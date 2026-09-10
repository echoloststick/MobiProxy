// SMFX AI Formatter -- converte o markdown que o Gemini devolve (**negrito**,
// blocos de código ```lang\ncódigo```) em Roblox RichText, pronto pra ir
// direto no .Text de um TextLabel com .RichText = true.
//
// Arquivo separado do main.js/ai.js de propósito -- é uma responsabilidade
// bem diferente (transformação de texto, não chamada de IA). Reaproveita o
// colorizeLua do colorize.js (o mesmo motor usado no Script Editor via
// /colorize) pra colorir o código Luau dentro dos blocos ``` -- assim não
// duplica a lógica de tokenizar/colorir Luau que já existe.

const { colorizeLua } = require('./colorize');

// Escapa os caracteres que o RichText do Roblox interpreta como marcação.
// O & TEM que ser o primeiro -- senão escapa os próprios escapes (&lt;,
// &amp;, etc) que a gente acabou de inserir, virando "&amp;lt;".
function escapeRichText(text) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

// **negrito** -> <b>negrito</b>. Roda DEPOIS do escape -- asterisco não é
// caractere especial de RichText, então não tem conflito com o escape acima.
function applyBold(escapedText) {
	return escapedText.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>');
}

// Um trecho de texto NORMAL (fora de bloco de código): escapa pra não
// quebrar o RichText e depois converte o markdown de negrito.
function formatPlainSegment(text) {
	return applyBold(escapeRichText(text));
}

// Um bloco de código inteiro: força a fonte "Code" (monoespaçada, mesma
// usada no Script Editor) em cima do trecho todo. Se a linguagem for Luau
// (ou não especificada -- a IA às vezes manda ``` sem nome de linguagem),
// também roda o colorizeLua pra colorir por token; outras linguagens só
// ganham a fonte Code, sem coloração (o colorizer é só de Luau mesmo).
function formatCodeSegment(lang, code) {
	// tira só a quebra de linha logo depois da abertura ```lang
	code = code.replace(/^\n/, '');

	const normalizedLang = (lang || '').trim().toLowerCase();
	const isLuau = normalizedLang === '' || normalizedLang === 'lua' || normalizedLang === 'luau';

	let body;
	if (isLuau) {
		try {
			// colorizeLua já devolve RichText pronto (com <font color="...">
			// por token, igual o Script Editor usa) -- não escapa de novo aqui
			// pra não quebrar as tags que ele mesmo gerou.
			body = colorizeLua(code);
		} catch (e) {
			body = escapeRichText(code);
		}
	} else {
		body = escapeRichText(code);
	}

	return `<font face="Code">${body}</font>`;
}

// Percorre o texto trocando cada bloco ```lang\ncódigo``` por RichText com
// fonte Code (+ colorize se for Luau), e formata negrito no que sobra.
function formatAIText(rawText) {
	if (typeof rawText !== 'string') return '';

	const codeBlockPattern = /```(\w*)\n?([\s\S]*?)```/g;
	let result = '';
	let lastIndex = 0;
	let match;

	while ((match = codeBlockPattern.exec(rawText)) !== null) {
		const [full, lang, code] = match;
		const plainBefore = rawText.slice(lastIndex, match.index);
		result += formatPlainSegment(plainBefore);
		result += formatCodeSegment(lang, code);
		lastIndex = match.index + full.length;
	}
	result += formatPlainSegment(rawText.slice(lastIndex));

	return result;
}

module.exports = { formatAIText };
