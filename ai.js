// SMFX AI Assistant -- ponte com APIs de IA (Gemini e APIs compativeis com OpenAI, como Groq)
// Arquivo separado do main.js de proposito (esse ja esta enorme). Exporta
// askGemini(prompt, apiKey, options) (nome mantido por compatibilidade), usada pela rota
// POST /ai no main.js.
//
// A API KEY VEM DO LUA (script do lado do SERVIDOR do jogo, que
// ninguem alem do dono consegue abrir/copiar -- diferente de LocalScript,
// que qualquer um exploraria facil). O proxy NAO guarda a key em lugar
// nenhum (nem env var): so repassa pro provedor o que chegou no header
// x-api-key da requisicao e esquece.

// Modelo atualizado em set/2026: o Gemini aposentou o gemini-2.0-flash e
// recomendou este no proprio erro da API. Gemini 3.x tambem ignora valores
// customizados de temperature/top-K/top-P (nao da erro, so ignora).
const DEFAULT_MODEL = 'gemini-3.6-flash';
const net = require('net');
// Template do link padrao. {model} e {api} sao trocados em buildRequestUrl().
// O link tambem pode vir personalizado pelo player (via Lua). Dois formatos:
//   Gemini:  https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api}
//   Anthropic: https://api.anthropic.com/v1/messages (key no header x-api-key)
//   OpenAI-compativel (Groq etc., sem {model}/{api}):  https://api.groq.com/openai/v1/chat/completions
//     -> o modelo vai no body e a key vai no header "Authorization: Bearer <key>".
const DEFAULT_LINK_TEMPLATE = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api}';
const MAX_MODEL_LENGTH = 100;
const MAX_LINK_LENGTH = 1000;

// Limite de caracteres do prompt -- defesa em profundidade: o Lua ja limita
// a mensagem do player (800 chars) antes de montar o prompt final, mas
// quem chamar o proxy direto (sem passar pelo jogo) nao tem essa trava.
const MAX_PROMPT_LENGTH = 15000;

// Erro de entrada invalida (link/model personalizado) -- a rota /ai responde 400 em vez de 502.
function invalidInput(message) {
	const err = new Error(message);
	err.statusCode = 400;
	return err;
}

// Hosts que o proxy nunca deve acessar a pedido de um link personalizado (anti-SSRF):
// localhost, dominios internos e qualquer IP literal (so aceita nome de dominio).
function isBlockedHost(hostname) {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (net.isIP(host)) return true;
	if (host === 'localhost' || !host.includes('.')) return true;
	return ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa'].some((suffix) => host.endsWith(suffix));
}

// Monta a URL final: troca {model} e {api} no template (usa split/join, entao '$' no valor
// nunca vira padrao de replace) e valida o resultado.
function buildRequestUrl(linkTemplate, model, apiKey) {
	const template = linkTemplate || DEFAULT_LINK_TEMPLATE;
	if (typeof template !== 'string' || template.length > MAX_LINK_LENGTH) {
		throw invalidInput(`link must be a string of up to ${MAX_LINK_LENGTH} characters.`);
	}
	if (typeof model !== 'string' || model.length > MAX_MODEL_LENGTH || !/^[\w.:\-/]+$/.test(model)) {
		throw invalidInput('model name is missing, too long or contains invalid characters.');
	}

	const finalUrl = template
		.split('{model}').join(encodeURIComponent(model))
		.split('{api}').join(encodeURIComponent(apiKey));

	let parsed;
	try {
		parsed = new URL(finalUrl);
	} catch (e) {
		throw invalidInput('link is not a valid URL.');
	}
	if (parsed.protocol !== 'https:') {
		throw invalidInput('link must use https.');
	}
	if (isBlockedHost(parsed.hostname)) {
		throw invalidInput('link host is not allowed.');
	}
	return parsed.toString();
}

// A key pode ir dentro da URL; tira ela de qualquer mensagem de erro antes de sair do proxy.
function redactSecret(text, secret) {
	const value = String(text);
	return secret ? value.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]') : value;
}

// Provedores suportados:
//   gemini: URL com :generateContent (key normalmente em {api} na propria URL).
//   openai: qualquer API compativel com OpenAI (Groq, OpenAI, OpenRouter, Together, Mistral, DeepSeek...).
//   anthropic: api.anthropic.com/v1/messages (header x-api-key + anthropic-version, system separado, max_tokens obrigatorio).
function detectProvider(url) {
	if (/^https:\/\/api\.anthropic\.com\//i.test(url)) return 'anthropic';
	return /generativelanguage\.googleapis\.com|:generateContent|:streamGenerateContent/i.test(url) ? 'gemini' : 'openai';
}

// Pega o texto da resposta nos dois formatos. Devolve { text, finishReason, blockReason }.
function parseProviderResponse(provider, data) {
	if (provider === 'anthropic') {
		const parts = data && Array.isArray(data.content) ? data.content : [];
		const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
		const reason = data && data.stop_reason;
		return {
			text,
			finishReason: reason === 'max_tokens' ? 'MAX_TOKENS' : reason === 'refusal' ? 'SAFETY' : reason || null,
			blockReason: null,
		};
	}

	if (provider === 'openai') {
		const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
		const message = choice && choice.message;
		let text = '';
		if (message && typeof message.content === 'string') {
			text = message.content;
		} else if (message && Array.isArray(message.content)) {
			text = message.content.map((p) => (p && p.text) || '').join('');
		}
		const reason = choice && choice.finish_reason;
		// OpenAI usa "length" pra limite de tokens; normaliza pro valor que o resto do codigo ja entende.
		return { text, finishReason: reason === 'length' ? 'MAX_TOKENS' : reason || null, blockReason: null };
	}

	const candidate = data.candidates && data.candidates[0];
	const finishReason = (candidate && candidate.finishReason) || null;
	const blockReason = !candidate && data.promptFeedback && data.promptFeedback.blockReason;
	const text = candidate && candidate.content && Array.isArray(candidate.content.parts)
		? candidate.content.parts.map((p) => p.text || '').join('')
		: '';
	return { text, finishReason, blockReason: blockReason || null };
}

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
Caso o player perguntar como criar uma API KEY, sugira pedir para colocar as permissões de "universe" e "universe-place" (Porque o Studio Mobi tem o sistema de publicar projetos em forma de jogo, e para isso é usado a API Open Cloud, então necessita permissões de API Key).

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
Escreva os comandos em texto puro: sem bloco de código, sem crases, sem marcadores de lista e sem numeração, cada comando começando no início da linha. JSON sempre com aspas duplas.
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
		// Erros comuns de outros modelos: virgula sobrando antes de } ou ].
		try {
			return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
		} catch (e2) {
			return null;
		}
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

// Modelos que nao sao o Gemini costumam "enfeitar" a linha do comando: bloco de codigo (```),
// crases, marcador de lista ("- ", "1. "). Tira esse enfeite antes de tentar interpretar a linha.
const FENCE_LINE = /^\s*(```|~~~)[\w+-]*\s*$/;

function normalizeCommandLine(line) {
	return line
		.trim()
		.replace(/^(?:[-*•]|\d+[.)])\s+/, '')
		.replace(/^`+|`+$/g, '')
		.trim();
}

// Puxa o BLOCO de comandos do final da mensagem (um por linha, permitindo
// linhas em branco entre eles/depois deles, e tambem comandos dentro de um bloco de codigo
// que fecha a mensagem) e devolve { text, commands }.
// text já sai limpo, sem nenhuma linha de comando -- é isso que o player
// efetivamente vê na tela.
function extractCommands(rawText) {
	const lines = rawText.split('\n');
	const commands = [];
	let cut = lines.length;
	let fenceCut = null; // indice do fence de fechamento, enquanto o de abertura nao foi achado

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line === '') {
			cut = i;
			continue;
		}
		if (FENCE_LINE.test(line)) {
			if (fenceCut === null && commands.length === 0) {
				fenceCut = i; // possivel fence de fechamento de um bloco so de comandos
				cut = i;
				continue;
			}
			if (fenceCut !== null) {
				fenceCut = null; // fence de abertura: o bloco inteiro era de comandos
				cut = i;
				continue;
			}
			break;
		}
		const parsed = parseCommandCall(normalizeCommandLine(line));
		if (!parsed) break;
		commands.unshift(parsed);
		cut = i;
	}

	// Fence de fechamento sem o de abertura: o bloco tinha texto junto, entao nao mexe em nada.
	if (fenceCut !== null) {
		return { text: rawText.trim(), commands: [] };
	}

	const text = lines.slice(0, cut).join('\n').trim();
	return { text, commands };
}

// Chama a IA com um prompt ja pronto (o Lua/servidor decide o que vai
// no prompt) e a API key que o proprio Lua mandou. Retorna { text, commands,
// finishReason }. Lanca Error em qualquer falha -- quem chama (a rota /ai)
// decide como isso vira JSON de erro.
async function askGemini(prompt, apiKey, options = {}) {
	if (typeof apiKey !== 'string' || apiKey.trim() === '') {
		throw new Error("API key nao foi enviada (header 'x-api-key').");
	}
	if (typeof prompt !== 'string' || prompt.trim() === '') {
		throw new Error("campo 'prompt' vazio ou invalido.");
	}
	if (prompt.length > MAX_PROMPT_LENGTH) {
		throw new Error(`prompt excede o limite de ${MAX_PROMPT_LENGTH} caracteres.`);
	}

	const template = typeof options.link === 'string' && options.link !== '' ? options.link : DEFAULT_LINK_TEMPLATE;
	const provider = detectProvider(template);
	// Em APIs OpenAI-compativeis e na Anthropic o modelo vai no body, entao nao existe um padrao que sirva.
	if (provider !== 'gemini' && !options.model) {
		throw invalidInput('this endpoint needs a model name (it is sent in the request body).');
	}

	const model = options.model || DEFAULT_MODEL;
	const key = apiKey.trim();
	const url = buildRequestUrl(template, model, key);
	const systemText = buildSystemInstruction(options.systemInstruction, options.selection);
	const temperature = typeof options.temperature === 'number' ? options.temperature : 0.7;
	// 1024 cortava respostas com script no meio (MAX_TOKENS) -- scripts
	// completos e prontos pra usar precisam de bem mais espaço.
	const maxTokens = typeof options.maxOutputTokens === 'number' ? options.maxOutputTokens : 7500;

	const headers = { 'Content-Type': 'application/json' };
	let body;
	if (provider === 'anthropic') {
		headers['x-api-key'] = key;
		headers['anthropic-version'] = '2023-06-01';
		body = {
			model,
			max_tokens: maxTokens,
			temperature,
			system: systemText,
			messages: [{ role: 'user', content: prompt }],
		};
	} else if (provider === 'openai') {
		headers.Authorization = `Bearer ${key}`;
		body = {
			model,
			messages: [
				{ role: 'system', content: systemText },
				{ role: 'user', content: prompt },
			],
			temperature,
			max_tokens: maxTokens,
		};
	} else {
		body = {
			contents: [{ role: 'user', parts: [{ text: prompt }] }],
			generationConfig: { temperature, maxOutputTokens: maxTokens },
			systemInstruction: { role: 'system', parts: [{ text: systemText }] },
		};
	}

	let upstream;
	try {
		upstream = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			redirect: 'error', // um link personalizado nao pode redirecionar o proxy pra outro host
		});
	} catch (e) {
		throw new Error(`falha de rede ao contatar o provedor de IA: ${redactSecret(e.message, key)}`);
	}

	let data;
	try {
		data = await upstream.json();
	} catch (e) {
		throw new Error(`resposta do provedor nao veio em JSON valido (status ${upstream.status}).`);
	}

	if (!upstream.ok) {
		// Gemini e OpenAI/Groq usam o mesmo formato { error: { message } }.
		const msg = (data && data.error && (data.error.message || (typeof data.error === 'string' && data.error))) || `HTTP ${upstream.status}`;
		throw new Error(`o provedor retornou erro: ${redactSecret(msg, key)}`);
	}

	const parsedResponse = parseProviderResponse(provider, data);
	const { finishReason, blockReason } = parsedResponse;
	// Alguns modelos (DeepSeek, Qwen, varios gratuitos do OpenRouter) mandam o raciocinio em <think>...</think>.
	const rawText = parsedResponse.text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();

	// Bloqueio de safety filter (do prompt inteiro) chega sem candidato
	if (blockReason) {
		throw new Error(`prompt bloqueado pelo provedor (motivo: ${blockReason}).`);
	}
	if (!rawText) {
		if (finishReason === 'SAFETY' || finishReason === 'content_filter') {
			throw new Error('resposta bloqueada pelo filtro de seguranca do provedor.');
		}
		throw new Error('o provedor nao retornou nenhum conteudo utilizavel.');
	}

	// Tira os comandos (create/edit/delete/editsource) do final da mensagem
	// -- o que sobra é o texto que o player efetivamente vê.
	const { text: cleanedText, commands } = extractCommands(rawText);
	let finalText = cleanedText || 'Feito!'; // se a mensagem era só comando, não pode voltar vazio

	// MAX_TOKENS não é erro (o provedor devolve o texto que já tinha gerado
	// até estourar o limite), mas fica parecendo bug se o player receber
	// um script cortado no meio sem nenhum aviso. Marca visivelmente.
	if (finishReason === 'MAX_TOKENS') {
		finalText += '\n\n → Response cut off due to token limit.';
	}

	return { text: finalText, commands, finishReason };
}

module.exports = { askGemini, MAX_PROMPT_LENGTH, extractCommands };
