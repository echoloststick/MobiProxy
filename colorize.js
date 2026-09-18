// SMFX Proxy — colorize.js
// Tokenizer + colorizador de Luau pra RichText (Roblox <font color='...'>), mais um checker de
// sintaxe leve (baseado em casamento de blocos/brackets, não um parser Luau completo).
// colorizeLua() fica intocada e sozinha porque o format.js (AI Assistant) só precisa dela --
// checar sintaxe custa mais e não faz sentido pra texto de chat. colorizeWithErrors() é a nova
// função pro Script Editor, que precisa de linhas + erros pra destacar no editor.

const CORES = {
	keyword: '#569CD6',
	constant: '#D19A66',
	string: '#CE9178',
	comment: '#6A9955',
	number: '#B5CEA8',
	global: '#4EC9B0',
	self: '#9CDCFE',
	error: '#F44747',     // linha inteira quando o syntax check acha problema nela
};

const KEYWORDS = new Set([
	'if', 'then', 'else', 'elseif', 'end', 'for', 'while', 'do', 'repeat',
	'until', 'function', 'local', 'return', 'break', 'in', 'not', 'and', 'or',
	'continue', 'export', 'type',
]);
const CONSTANTS = new Set(['true', 'false', 'nil']);
const GLOBALS = new Set([
	'game', 'workspace', 'script', 'shared', '_G',
	'string', 'table', 'math', 'task', 'os', 'coroutine', 'utf8', 'buffer',
	'Instance', 'Enum', 'Vector2', 'Vector3', 'CFrame', 'Color3', 'BrickColor',
	'UDim', 'UDim2', 'Rect', 'NumberRange', 'NumberSequence', 'ColorSequence',
	'NumberSequenceKeypoint', 'ColorSequenceKeypoint', 'PhysicalProperties',
	'Ray', 'Region3', 'TweenInfo', 'Random', 'Content',
	'pairs', 'ipairs', 'next', 'pcall', 'xpcall', 'require', 'typeof', 'type',
	'tostring', 'tonumber', 'print', 'warn', 'error', 'assert', 'select',
	'unpack', 'rawget', 'rawset', 'rawequal', 'setmetatable', 'getmetatable',
	'delay', 'spawn', 'wait', 'DateTime',
]);

// Palavras que abrem um bloco fechado por 'end'. 'for'/'while' precisam de um 'do' antes de
// abrir de verdade o corpo -- esse 'do' não é um bloco novo, só o terminador deles.
const PENDING_DO = new Set(['for', 'while']);
const BRACKET_OPEN = { '(': ')', '[': ']', '{': '}' };
const BRACKET_CLOSE = { ')': '(', ']': '[', '}': '{' };

function escapeRichText(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrap(text, color) {
	return `<font color='${color}'>${escapeRichText(text)}</font>`;
}

// Tokenizer simples -- mesma filosofia do fallback local no client: cobre "..", '..', [[..]]
// (com [=[..]=] etc), comentário -- e --[[..]], número (incluindo hex/decimal), palavra, resto.
// Não precisa ser um parser Lua completo, só bom o suficiente pra colorir e checar bloco/bracket.
// Cada token carrega line/col (1-based) do ponto onde começa, pra localizar erro depois.
function tokenize(code) {
	const tokens = [];
	let i = 0;
	const n = code.length;

	const lineStarts = [0];
	for (let idx = 0; idx < n; idx++) {
		if (code[idx] === '\n') lineStarts.push(idx + 1);
	}
	let lsIdx = 0;
	function posOf(start) {
		while (lsIdx + 1 < lineStarts.length && lineStarts[lsIdx + 1] <= start) lsIdx++;
		while (lsIdx > 0 && lineStarts[lsIdx] > start) lsIdx--;
		return { line: lsIdx + 1, col: start - lineStarts[lsIdx] };
	}

	while (i < n) {
		const c = code[i];
		const { line, col } = posOf(i);

		if (code.startsWith('--', i)) {
			const longOpen = code.slice(i).match(/^--(\[=*\[)/);
			if (longOpen) {
				const closer = ']' + '='.repeat(longOpen[1].length - 2) + ']';
				let end = code.indexOf(closer, i + longOpen[0].length);
				const unterminated = end === -1;
				end = unterminated ? n : end + closer.length;
				tokens.push({ type: 'comment', text: code.slice(i, end), line, col, unterminated });
				i = end;
			} else {
				let end = code.indexOf('\n', i);
				end = end === -1 ? n : end;
				tokens.push({ type: 'comment', text: code.slice(i, end), line, col });
				i = end;
			}
			continue;
		}

		const longStringOpen = code.slice(i).match(/^\[=*\[/);
		if (longStringOpen) {
			const closer = ']' + '='.repeat(longStringOpen[0].length - 2) + ']';
			let end = code.indexOf(closer, i + longStringOpen[0].length);
			const unterminated = end === -1;
			end = unterminated ? n : end + closer.length;
			tokens.push({ type: 'string', text: code.slice(i, end), line, col, unterminated });
			i = end;
			continue;
		}

		if (c === '"' || c === "'") {
			let j = i + 1;
			let unterminated = true;
			while (j < n) {
				if (code[j] === '\\') j += 2;
				else if (code[j] === c) { j++; unterminated = false; break; }
				else if (code[j] === '\n') break;
				else j++;
			}
			tokens.push({ type: 'string', text: code.slice(i, j), line, col, unterminated });
			i = j;
			continue;
		}

		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] || ''))) {
			let j = i;
			while (j < n && /[0-9a-fA-Fx.]/.test(code[j])) j++;
			tokens.push({ type: 'number', text: code.slice(i, j), line, col });
			i = j;
			continue;
		}

		if (/[a-zA-Z_]/.test(c)) {
			let j = i;
			while (j < n && /[a-zA-Z0-9_]/.test(code[j])) j++;
			tokens.push({ type: 'word', text: code.slice(i, j), line, col });
			i = j;
			continue;
		}

		tokens.push({ type: 'other', text: c, line, col });
		i++;
	}

	return tokens;
}

function colorOf(t) {
	if (t.type === 'comment') return CORES.comment;
	if (t.type === 'string') return CORES.string;
	if (t.type === 'number') return CORES.number;
	if (t.type === 'word') {
		if (KEYWORDS.has(t.text)) return CORES.keyword;
		if (CONSTANTS.has(t.text)) return CORES.constant;
		if (t.text === 'self') return CORES.self;
		if (GLOBALS.has(t.text)) return CORES.global;
	}
	return null;
}

function colorizeLua(code) {
	const tokens = tokenize(code);
	let out = '';
	for (const t of tokens) {
		const color = colorOf(t);
		out += color ? wrap(t.text, color) : escapeRichText(t.text);
	}
	return out;
}

// Checagem de sintaxe leve: casamento de blocos (if/for/while/function/do -> end,
// repeat -> until) e de brackets ((), [], {}). NÃO é um parser Luau completo -- não valida
// gramática de expressão, só estrutura. Cobre o caso "if x then end" na mesma linha porque o
// stack fecha e abre pelo TOKEN, não pela linha.
function checkSyntax(tokens) {
	const errors = [];
	const blocks = [];
	const brackets = [];

	const pushError = (line, message) => errors.push({ line, message });

	for (const t of tokens) {
		if (t.type === 'comment' || t.type === 'string') {
			if (t.unterminated) {
				const kind = t.type === 'comment' ? 'Comentário' : 'String';
				const closer = t.text.startsWith('--[') || t.text.startsWith('[') ? 'não fechado(a) (falta o \']\' correspondente)' : 'não fechada (falta a aspa de fechamento)';
				pushError(t.line, `${kind} ${closer}`);
			}
			continue;
		}

		if (t.type === 'other') {
			if (BRACKET_OPEN[t.text]) {
				brackets.push({ char: t.text, line: t.line });
			} else if (BRACKET_CLOSE[t.text]) {
				const top = brackets[brackets.length - 1];
				if (!top || top.char !== BRACKET_CLOSE[t.text]) {
					pushError(t.line, `'${t.text}' inesperado, sem abertura correspondente`);
				} else {
					brackets.pop();
				}
			}
			continue;
		}

		if (t.type !== 'word') continue;
		const w = t.text;

		if (w === 'if') {
			blocks.push({ type: 'if', line: t.line });
		} else if (PENDING_DO.has(w)) {
			blocks.push({ type: w, line: t.line, pendingDo: true });
		} else if (w === 'function') {
			blocks.push({ type: 'function', line: t.line });
		} else if (w === 'do') {
			const top = blocks[blocks.length - 1];
			if (top && top.pendingDo) top.pendingDo = false;
			else blocks.push({ type: 'do', line: t.line });
		} else if (w === 'repeat') {
			blocks.push({ type: 'repeat', line: t.line });
		} else if (w === 'until') {
			const top = blocks[blocks.length - 1];
			if (!top || top.type !== 'repeat') pushError(t.line, "'until' sem 'repeat' correspondente");
			else blocks.pop();
		} else if (w === 'end') {
			const top = blocks[blocks.length - 1];
			if (!top) {
				pushError(t.line, "'end' inesperado");
			} else if (top.type === 'repeat') {
				pushError(t.line, "'end' inesperado -- bloco 'repeat' precisa de 'until', não 'end'");
				blocks.pop();
			} else {
				blocks.pop();
			}
		} else if (w === 'else' || w === 'elseif') {
			const top = blocks[blocks.length - 1];
			if (!top || top.type !== 'if') pushError(t.line, `'${w}' fora de um bloco 'if'`);
		}
	}

	for (const open of blocks) {
		const needs = open.type === 'repeat' ? "'until'" : "'end'";
		pushError(open.line, `bloco '${open.type}' aberto aqui nunca foi fechado (falta ${needs})`);
	}
	for (const b of brackets) {
		pushError(b.line, `'${b.char}' aberto aqui nunca foi fechado`);
	}

	errors.sort((a, b) => a.line - b.line);
	return errors;
}

// Linha com erro vira <font color='error'><u>...</u></font> inteira, IGNORANDO a cor por token
// -- é assim que o vermelho fica dominante em cima de qualquer keyword/string/etc na linha (tag
// interna sobrescreveria a externa se fizesse o contrário, então nem tenta colorir por token
// numa linha com erro). O client não precisa saber renderizar nada diferente: é tudo tag de
// RichText normal, então funciona igual no Roblox sem lógica extra do lado do Lua.
function wrapErrorLine(text) {
	return `<font color='${CORES.error}'><u>${escapeRichText(text)}</u></font>`;
}

// Versão pro Script Editor: devolve o código colorido QUEBRADO POR LINHA (cada linha com tags
// próprias e balanceadas, pra dar pra re-renderizar/recolorir uma linha sozinha sem herdar tag
// aberta da anterior -- e já com o vermelho/sublinhado aplicado nas linhas com erro), o mesmo
// resultado colado como string única em "colored", e a lista de erros de sintaxe encontrados.
function colorizeWithErrors(code) {
	const tokens = tokenize(code);
	const errors = checkSyntax(tokens);
	const errorLines = new Set(errors.map((e) => e.line));

	const rawLines = code.split('\n');
	const lines = new Array(rawLines.length).fill('');

	for (const t of tokens) {
		const color = colorOf(t);
		const segments = t.text.split('\n');
		if (segments.length === 1) {
			lines[t.line - 1] += color ? wrap(t.text, color) : escapeRichText(t.text);
		} else {
			for (let s = 0; s < segments.length; s++) {
				if (segments[s] === '') continue;
				lines[t.line - 1 + s] += color ? wrap(segments[s], color) : escapeRichText(segments[s]);
			}
		}
	}

	for (const lineNum of errorLines) {
		lines[lineNum - 1] = wrapErrorLine(rawLines[lineNum - 1] ?? '');
	}

	return { colored: lines.join('\n'), lines, errors };
}

module.exports = { colorizeLua, colorizeWithErrors, checkSyntax, tokenize };
