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
	'Voce e o assistente de IA do Studio Mobi (SMFX), um editor de niveis Roblox ' +
	'que roda dentro de um jogo mobile. Ajude o jogador com Luau/scripting e com ' +
	'duvidas sobre como usar o editor. Seja direto e conciso -- as respostas ' +
	'aparecem numa tela de celular dentro do jogo, entao evite textao. Quando der ' +
	'exemplo de codigo, use Luau valido.';

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
			maxOutputTokens: typeof options.maxOutputTokens === 'number' ? options.maxOutputTokens : 1024,
		},
		systemInstruction: {
			role: 'system',
			parts: [{ text: options.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION }],
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

	const text = candidate.content.parts.map((p) => p.text || '').join('');
	if (!text) {
		throw new Error('Gemini retornou uma resposta vazia.');
	}

	return { text, finishReason };
}

module.exports = { askGemini, MAX_PROMPT_LENGTH };
