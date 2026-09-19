// SMFX Proxy — colorize.js
// Tokenizer + colorizador de Luau pra RichText (Roblox <font color='...'>), mais um checker de
// sintaxe leve (baseado em casamento de blocos/brackets, não um parser Luau completo).

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

const PENDING_DO = new Set(['for', 'while']);
const BRACKET_OPEN = { '(': ')', '[': ']', '{': '}' };
const BRACKET_CLOSE = { ')': '(', ']': '[', '}': '{' };

// Palavras-chave que podem ser alvo de erros de digitação
const SUGGESTION_KEYWORDS = [...KEYWORDS, ...CONSTANTS];

function escapeRichText(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrap(text, color) {
	return `<font color='${color}'>${escapeRichText(text)}</font>`;
}

// --- FUNÇÕES PARA SUGESTÃO DE DIGITAÇÃO ---

// Calcula a distância de Levenshtein (quantas edições são necessárias para transformar 'a' em 'b')
function levenshtein(a, b) {
	const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
	for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
	for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
	for (let j = 1; j <= b.length; j++) {
		for (let i = 1; i <= a.length; i++) {
			const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[j][i] = Math.min(
				matrix[j][i - 1] + 1, // deleção
				matrix[j - 1][i] + 1, // inserção
				matrix[j - 1][i - 1] + indicator // substituição
			);
		}
	}
	return matrix[b.length][a.length];
}

// Encontra a palavra-chave mais próxima da palavra digitada, se houver
function findKeywordSuggestion(word) {
	let bestMatch = null;
	let minDistance = Infinity;
	
	for (const kw of SUGGESTION_KEYWORDS) {
		if (Math.abs(word.length - kw.length) > 2) continue;
		const dist = levenshtein(word, kw);
		if (dist < minDistance) {
			minDistance = dist;
			bestMatch = kw;
		}
	}
	
	// Limiar de tolerância: 1 erro para palavras curtas, 2 para palavras longas
	const threshold = word.length <= 3 ? 1 : 2;
	if (minDistance <= threshold && minDistance > 0) {
		return bestMatch;
	}
	return null;
}

// --- FIM DAS FUNÇÕES DE SUGESTÃO ---

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
// repeat -> until) e de brackets ((), [], {}).
function checkSyntax(tokens) {
	const errors = [];
	const blocks = [];
	const brackets = [];

	// Agora aceita uma sugestão opcional
	const pushError = (line, message, suggestion = null) => errors.push({ line, message, suggestion });

	let prevToken = null;

	for (const t of tokens) {
		if (t.type === 'comment' || t.type === 'string') {
			if (t.unterminated) {
				const kind = t.type === 'comment' ? 'Unterminated comment' : 'Unterminated string';
				const detail = t.text.startsWith('--[') || t.text.startsWith('[') ? "missing closing ']'" : 'missing closing quote';
				pushError(t.line, `${kind}: ${detail}`);
			}
			continue; // Não atualiza prevToken para não atrapalhar a detecção de variáveis
		}

		if (t.type === 'other') {
			if (BRACKET_OPEN[t.text]) {
				brackets.push({ char: t.text, line: t.line });
			} else if (BRACKET_CLOSE[t.text]) {
				const top = brackets[brackets.length - 1];
				if (!top || top.char !== BRACKET_CLOSE[t.text]) {
					pushError(t.line, `Unexpected '${t.text}': no matching opening bracket`);
				} else {
					brackets.pop();
				}
			}
			prevToken = t;
			continue;
		}

		if (t.type !== 'word') {
			prevToken = t;
			continue;
		}

		const w = t.text;

		// --- DETECÇÃO DE ERROS DE DIGITAÇÃO ---
		// Se não for uma palavra-chave conhecida, global ou 'self', verificamos se é um typo.
		if (!KEYWORDS.has(w) && !CONSTANTS.has(w) && !GLOBALS.has(w) && w !== 'self') {
			// Evita dar erro se for uma declaração de variável (ex: local en = 5)
			const isVarDeclaration = prevToken && (
				prevToken.text === 'local' || 
				prevToken.text === 'function' || 
				prevToken.text === ','
			);
			
			if (!isVarDeclaration) {
				const typo = findKeywordSuggestion(w);
				if (typo) {
					pushError(t.line, `Unknown word '${w}'. Did you mean '${typo}'?`, `Did you mean '${typo}'?`);
				}
			}
		}

		// --- LÓGICA DE BLOCOS ---
		if (w === 'if') {
			blocks.push({ type: 'if', line: t.line, hasThen: false });
		} else if (w === 'then') {
			const top = blocks[blocks.length - 1];
			if (top && top.type === 'if') top.hasThen = true;
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
			if (!top || top.type !== 'repeat') pushError(t.line, "'until' with no matching 'repeat'");
			else blocks.pop();
		} else if (w === 'end') {
			const top = blocks[blocks.length - 1];
			if (!top) {
				pushError(t.line, "Unexpected 'end': no matching block to close");
			} else if (top.type === 'repeat') {
				pushError(t.line, "Unexpected 'end': a 'repeat' block must be closed with 'until'");
				blocks.pop();
			} else if (top.type === 'if' && !top.hasThen) {
				pushError(t.line, "Unexpected 'end': this 'if' block is missing 'then'");
				blocks.pop();
			} else {
				blocks.pop();
			}
		} else if (w === 'elseif') {
			const top = blocks[blocks.length - 1];
			if (!top || top.type !== 'if') pushError(t.line, `'${w}' outside of an 'if' block`);
			if (top && top.type === 'if') top.hasThen = false; // elseif precisa de um novo 'then'
		} else if (w === 'else') {
			const top = blocks[blocks.length - 1];
			if (!top || top.type !== 'if') pushError(t.line, `'${w}' outside of an 'if' block`);
		}

		prevToken = t;
	}

	// --- ERROS DE BLOCOS NÃO FECHADOS ---
	for (const open of blocks) {
		const needs = open.type === 'repeat' ? "'until'" : "'end'";
		let msg = `Unclosed '${open.type}' block (started on line ${open.line}): missing ${needs}.`;
		
		// Tenta achar um erro de digitação que possa ser a causa do bloco não fechado
		const expectedKw = open.type === 'repeat' ? 'until' : 'end';
		const typoToken = tokens.find(t => t.type === 'word' && findKeywordSuggestion(t.text) === expectedKw);
		
		if (typoToken) {
			msg += ` Did you mean '${expectedKw}' instead of '${typoToken.text}' on line ${typoToken.line}?`;
		}
		
		pushError(open.line, msg);
	}
	
	for (const b of brackets) {
		pushError(b.line, `Unclosed '${b.char}' bracket (opened on line ${b.line}): missing '${BRACKET_OPEN[b.char]}'`);
	}

	errors.sort((a, b) => a.line - b.line);
	return errors;
}

function wrapErrorLine(text) {
	return `<font color='${CORES.error}'><u>${escapeRichText(text)}</u></font>`;
}

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
