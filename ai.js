// SMFX AI Assistant -- ponte com a API do Gemini
// Arquivo separado do main.js de proposito (esse ja esta enorme). Exporta
// uma unica funcao, askGemini(prompt, apiKey, options), usada pela rota
// POST /ai no main.js.
//
// A API KEY DO GEMINI VEM DO LUA (script do lado do SERVIDOR do jogo, que
// ninguem alem do dono consegue abrir/copiar -- diferente de LocalScript,
// que qualquer um exploraria facil). O proxy NAO guarda a key em lugar
// nenhum (nem env var): so repassa pro Gemini o que chegou no header
// x-api-key da requisicao e esquece. Isso evita depender de configurar
// env var no Render toda vez que a key mudar, e evita ter uma key "fixa"
// do proxy que serviria pra qualquer jogo que apontar pra ele.

// Modelo atualizado em set/2026: o Gemini aposentou o gemini-2.0-flash e
// recomendou este no proprio erro da API. Gemini 3.x tambem ignora valores
// customizados de temperature/top-K/top-P (nao da erro, so ignora), entao
// o generationConfig abaixo continua inofensivo mesmo que isso mude de novo.
const DEFAULT_MODEL = 'gemini-3.6-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Limite de caracteres do prompt -- defesa em profundidade: o Lua ja limita
// a mensagem do player (800 chars) antes de montar o prompt final, mas
// quem chamar o proxy direto (sem passar pelo jogo) nao tem essa trava.
// Sem isso, um POST direto no /ai podia mandar um prompt gigante e gastar
// tokens/custo no Gemini sem limite nenhum.
const MAX_PROMPT_LENGTH = 15000;

// Personalidade/regras fixas do assistente dentro do Studio Mobi. Fica
// separado do prompt que o Lua monta (que carrega o contexto especifico
// da pergunta -- script atual, erro, etc), pra nao misturar as duas coisas.
const DEFAULT_SYSTEM_INSTRUCTION =
	'Voce é o assistente de IA do Studio Mobi, um editor de niveis Roblox ' +
	'que roda dentro de um jogo mobile. Ajude o jogador com Luau/scripting e com ' +
	'duvidas sobre como usar o editor. Seja direto e conciso -- as respostas ' +
	'aparecem numa tela de celular dentro do jogo, entao evite textao. O limite de tokens é 4096 alias. Quando der ' +
	'exemplo de codigo, use Luau valido.';

// Instruções dos comandos que a IA pode usar pra agir de verdade no jogo
// (criar/editar/apagar objetos, trocar o código de um script). Ficam
// SEMPRE no final da mensagem, um por linha -- extractCommands() abaixo
// arranca essas linhas antes do texto chegar no player (ele nunca vê a
// sintaxe do comando, só o resultado em texto normal).
const COMMANDS_INSTRUCTIONS = `
Você também pode agir no jogo de verdade através de comandos. Se quiser executar uma ação, escreva sua resposta normal em texto pro player primeiro, e SÓ NO FINAL da mensagem adicione os comandos, um por linha (nunca explique os comandos pro player, eles são invisíveis pra ele e são processados pelo servidor).

Comandos disponíveis (cada um numa linha só, mesmo com JSON grande):
create(caminho-do-pai, ClassName, {"Propriedade": valor, ...})              -- cria uma instância nova
edit(caminho-do-objeto, {"Propriedade": valor, ...})                        -- muda propriedades de um objeto existente (as que não forem citadas continuam iguais)
delete(caminho-do-objeto)                                                   -- apaga um objeto
copy(caminho-do-objeto)                                                     -- duplica um objeto no mesmo lugar (mesmo pai)
copy(caminho-do-objeto, caminho-do-novo-pai)                                -- duplica um objeto e move a cópia pra outro lugar
editsource(caminho-do-script, "código Luau aqui, use \\n pra quebra de linha")  -- substitui o código de um Script/LocalScript/ModuleScript

Caminhos (paths) sempre no formato "game/Workspace/NomeDoObjeto/NomeDoFilho", separados por "/", começando em "game". Toda propriedade que referencia outra instância (ex: Parent, PrimaryPart) também usa esse mesmo formato de caminho, como string.

Formato dos valores de propriedade no JSON:
- bool, número, string: direto (true, 5, "texto")
- Posição/tamanho/rotação (Position, Size, Orientation): {"x":0,"y":5,"z":0} -- use Position e Orientation pra mover/girar, NUNCA CFrame diretamente
- Color3: {"r":1,"g":0,"b":0} (0 a 1)
- BrickColor: o nome da cor como string, ex: "Bright red"
- Enum (Material, PartType, etc): só o nome do item, ex: "SmoothPlastic", "Neon"
- Instância (Class, ex: Parent): o caminho completo como string, ex: "game/Workspace/Baseplate".
Evite mandar muitos comandos para não furar o limite de 4096 tokens.
`.trim();

// Monta o systemInstruction final: a base (customizada ou a padrão + regras
// de comando) mais o objeto selecionado no momento pelo player -- assim a
// IA sabe com o que está lidando sem precisar perguntar.
function buildSystemInstruction(customInstruction, selection) {
	const base = customInstruction || `${DEFAULT_SYSTEM_INSTRUCTION}\n\n${COMMANDS_INSTRUCTIONS}`;
	const selectionLine = selection
		? `Objeto atualmente selecionado pelo player no Explorer: ${selection}`
		: 'Nenhum objeto está selecionado no momento pelo player.';
	return `${base}\n\n${selectionLine}`;
}

// ===========================================================================
// Extração de comandos do final da resposta
// ===========================================================================

const COMMAND_NAMES = ['create', 'edit', 'delete', 'copy', 'editsource'];

// Acha o ')' que fecha o '(' de abertura, respeitando aninhamento de
// (), {}, [] e conteúdo dentro de aspas -- uma busca ingênua por ')' quebra
// no primeiro que aparecer dentro do JSON das propriedades.
function findMatchingParen(text, openIndex) {
	let depth = 0;
	let inString = false;
	let stringChar = '';
	for (let i = openIndex; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === '\\') { i++; continue; }
			if (c === stringChar) inString = false;
			continue;
		}
		if (c === '"' || c === "'") { inString = true; stringChar = c; continue; }
		if (c === '(' || c === '{' || c === '[') depth++;
		else if (c === ')' || c === '}' || c === ']') {
			depth--;
			if (depth === 0 && c === ')') return i;
		}
	}
	return -1;
}

// "a, b, {c: 1, d: 2}" -> ['a', 'b', '{c: 1, d: 2}'] -- um split(',') comum
// quebraria o JSON no meio da primeira vírgula interna.
function splitTopLevelArgs(argsStr) {
	const parts = [];
	let depth = 0;
	let inString = false;
	let stringChar = '';
	let current = '';
	for (let i = 0; i < argsStr.length; i++) {
		const c = argsStr[i];
		if (inString) {
			current += c;
			if (c === '\\') { current += argsStr[++i] || ''; continue; }
			if (c === stringChar) inString = false;
			continue;
		}
		if (c === '"' || c === "'") { inString = true; stringChar = c; current += c; continue; }
		if (c === '{' || c === '[' || c === '(') { depth++; current += c; continue; }
		if (c === '}' || c === ']' || c === ')') { depth--; current += c; continue; }
		if (c === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
			continue;
		}
		current += c;
	}
	if (current.trim() !== '') parts.push(current.trim());
	return parts;
}

function parseJsonArg(raw) {
	try {
		return JSON.parse(raw);
	} catch (e) {
		return null;
	}
}

// Tira as aspas de um argumento string (path ou source), respeitando
// escapes -- se não vier entre aspas, usa o texto cru mesmo assim (a IA
// às vezes manda o path sem aspas nenhuma).
function parseStringArg(raw) {
	const trimmed = raw.trim();
	if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed[trimmed.length - 1] === trimmed[0]) {
		const asJson = trimmed[0] === '"' ? trimmed : `"${trimmed.slice(1, -1).replace(/"/g, '\\"')}"`;
		try {
			return JSON.parse(asJson);
		} catch (e) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

// Converte UMA linha ("create(...)" etc) num objeto de comando estruturado,
// ou null se a linha não for um comando válido/reconhecido.
function parseCommandCall(callText) {
	const openIndex = callText.indexOf('(');
	if (openIndex === -1) return null;

	const name = callText.slice(0, openIndex).trim();
	if (!COMMAND_NAMES.includes(name)) return null;

	const closeIndex = findMatchingParen(callText, openIndex);
	if (closeIndex === -1) return null;

	const args = splitTopLevelArgs(callText.slice(openIndex + 1, closeIndex));

	if (name === 'create' && args.length >= 3) {
		return {
			type: 'create',
			path: parseStringArg(args[0]),
			className: parseStringArg(args[1]),
			properties: parseJsonArg(args[2]) || {},
		};
	}
	if (name === 'edit' && args.length >= 2) {
		return {
			type: 'edit',
			path: parseStringArg(args[0]),
			properties: parseJsonArg(args[1]) || {},
		};
	}
	if (name === 'delete' && args.length >= 1) {
		return { type: 'delete', path: parseStringArg(args[0]) };
	}
	if (name === 'copy' && args.length >= 1) {
		return {
			type: 'copy',
			path: parseStringArg(args[0]),
			destPath: args.length >= 2 ? parseStringArg(args[1]) : null,
		};
	}
	if (name === 'editsource' && args.length >= 2) {
		return {
			type: 'editsource',
			path: parseStringArg(args[0]),
			source: parseStringArg(args[1]),
		};
	}
	return null;
}

// Puxa o BLOCO de comandos do final da mensagem (um por linha, permitindo
// linhas em branco entre eles/depois deles) e devolve { text, commands }.
// text já sai limpo, sem nenhuma linha de comando -- é isso que o player
// efetivamente vê na tela.
function extractCommands(rawText) {
	const lines = rawText.split('\n');
	const commands = [];
	let cut = lines.length;

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line === '') {
			cut = i;
			continue;
		}
		const parsed = parseCommandCall(line);
		if (!parsed) break;
		commands.unshift(parsed);
		cut = i;
	}

	const text = lines.slice(0, cut).join('\n').trim();
	return { text, commands };
}

// Chama o Gemini com um prompt ja pronto (o Lua/servidor decide o que vai
// no prompt) e a API key que o proprio Lua mandou. Retorna { text,
// finishReason }. Lanca Error em qualquer falha -- quem chama (a rota /ai)
// decide como isso vira JSON de erro.
async function askGemini(prompt, apiKey, options = {}) {
	if (typeof apiKey !== 'string' || apiKey.trim() === '') {
		throw new Error("API key do Gemini nao foi enviada (header 'x-api-key').");
	}
	if (typeof prompt !== 'string' || prompt.trim() === '') {
		throw new Error("campo 'prompt' vazio ou invalido.");
	}
	if (prompt.length > MAX_PROMPT_LENGTH) {
		throw new Error(`prompt excede o limite de ${MAX_PROMPT_LENGTH} caracteres.`);
	}

	const model = options.model || DEFAULT_MODEL;
	const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;

	const body = {
		contents: [
			{
				role: 'user',
				parts: [{ text: prompt }],
			},
		],
		generationConfig: {
			temperature: typeof options.temperature === 'number' ? options.temperature : 0.7,
			// 1024 cortava respostas com script no meio (finishReason
			// MAX_TOKENS) -- scripts completos e prontos pra usar (que é
			// bem o que o assistente promete) precisam de bem mais espaço.
			maxOutputTokens: typeof options.maxOutputTokens === 'number' ? options.maxOutputTokens : 5000,
		},
		systemInstruction: {
			role: 'system',
			parts: [{ text: buildSystemInstruction(options.systemInstruction, options.selection) }],
		},
	};

	let upstream;
	try {
		upstream = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	} catch (e) {
		throw new Error(`falha de rede ao contatar o Gemini: ${e.message}`);
	}

	let data;
	try {
		data = await upstream.json();
	} catch (e) {
		throw new Error(`resposta do Gemini nao veio em JSON valido (status ${upstream.status}).`);
	}

	if (!upstream.ok) {
		const msg = (data && data.error && data.error.message) || `HTTP ${upstream.status}`;
		throw new Error(`Gemini retornou erro: ${msg}`);
	}

	const candidate = data.candidates && data.candidates[0];
	const finishReason = (candidate && candidate.finishReason) || null;

	// Bloqueio de safety filter (do prompt inteiro) chega aqui, nao em candidates
	if (!candidate && data.promptFeedback && data.promptFeedback.blockReason) {
		throw new Error(`prompt bloqueado pelo Gemini (motivo: ${data.promptFeedback.blockReason}).`);
	}

	if (!candidate || !candidate.content || !Array.isArray(candidate.content.parts)) {
		if (finishReason === 'SAFETY') {
			throw new Error('resposta bloqueada pelo filtro de seguranca do Gemini.');
		}
		throw new Error('Gemini nao retornou nenhum conteudo utilizavel.');
	}

	const rawText = candidate.content.parts.map((p) => p.text || '').join('');
	if (!rawText) {
		throw new Error('Gemini retornou uma resposta vazia.');
	}

	// Tira os comandos (create/edit/delete/editsource) do final da mensagem
	// -- o que sobra é o texto que o player efetivamente vê.
	const { text: cleanedText, commands } = extractCommands(rawText);
	let finalText = cleanedText || 'Feito!'; // se a mensagem era só comando, não pode voltar vazio

	// MAX_TOKENS não é erro (o Gemini devolve o texto que já tinha gerado
	// até estourar o limite), mas fica parecendo bug se o player receber
	// um script cortado no meio sem nenhum aviso -- foi exatamente isso
	// que aconteceu com maxOutputTokens em 1024. Marca visivelmente em vez
	// de deixar passar batido.
	if (finishReason === 'MAX_TOKENS') {
		finalText += '\n\n → Response cut off due to token limit.';
	}

	return { text: finalText, commands, finishReason };
}

module.exports = { askGemini, MAX_PROMPT_LENGTH, extractCommands };
