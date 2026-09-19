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
	error: '#F44747',
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

const SUGGESTION_KEYWORDS = [...KEYWORDS, ...CONSTANTS];

function escapeRichText(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrap(text, color) {
	return `<font color='${color}'>${escapeRichText(text)}</font>`;
}

function levenshtein(a, b) {
	const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
	for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
	for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
	for (let j = 1; j <= b.length; j++) {
		for (let i = 1; i <= a.length; i++) {
			const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[j][i] = Math.min(
				matrix[j][i - 1] + 1,
				matrix[j - 1][i] + 1,
				matrix[j - 1][i - 1] + indicator
			);
		}
	}
	return matrix[b.length][a.length];
}

// MELHORIA: Agora aceita uma lista de palavras-chave esperadas (contexto)
function findKeywordSuggestion(word, contextKeywords) {
	let bestMatch = null;
	let minDistance = Infinity;
	
	// Se o contexto for fornecido, só procuramos nele.
	// Se não, usamos a lista global, MAS removemos 'end' e 'until' que só devem ser sugeridos
	// se houver um bloco aberto esperando por eles.
	const defaultKeywords = SUGGESTION_KEYWORDS.filter(kw => kw !== 'end' && kw !== 'until');
	const keywordsToCheck = contextKeywords && contextKeywords.size > 0 
		? [...contextKeywords] 
		: defaultKeywords;

	for (const kw of keywordsToCheck) {
		if (Math.abs(word.length - kw.length) > 2) continue;
		const dist = levenshtein(word, kw);
		if (dist < minDistance) {
			minDistance = dist;
			bestMatch = kw;
		}
	}
	
	const threshold = word.length <= 5 ? 1 : 2;
	if (minDistance <= threshold && minDistance > 0) {
		return bestMatch;
	}
	return null;
}

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

function checkSyntax(tokens) {
	const errors = [];
	const blocks = [];
	const brackets = [];

	const pushError = (line, message, suggestion = null) => errors.push({ line, message, suggestion });

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const prevToken = tokens[i - 1];
		const nextToken = tokens[i + 1];

		if (t.type === 'comment' || t.type === 'string') {
			if (t.unterminated) {
				const kind = t.type === 'comment' ? 'Unterminated comment' : 'Unterminated string';
				const detail = t.text.startsWith('--[') || t.text.startsWith('[') ? "missing closing ']'" : 'missing closing quote';
				pushError(t.line, `${kind}: ${detail}`);
			}
			continue;
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
			continue;
		}

		if (t.type !== 'word') continue;
		const w = t.text;

		// --- DETECÇÃO DE ERROS DE DIGITAÇÃO ---
		if (!KEYWORDS.has(w) && !CONSTANTS.has(w) && !GLOBALS.has(w) && w !== 'self') {
			const isVarDeclaration = prevToken && (
				prevToken.text === 'local' || 
				prevToken.text === 'function' || 
				prevToken.text === ','
			);
			
			const nextIsVarChar = nextToken && (
				nextToken.text === '=' || 
				nextToken.text === '.' || 
				nextToken.text === ':' || 
				nextToken.text === '(' || 
				nextToken.text === '[' ||
				nextToken.text === ','
			);
			
			if (!isVarDeclaration && !nextIsVarChar) {
				// MELHORIA: Coleta o contexto atual de blocos para saber quais palavras-chave são esperadas
				const expectedKeywords = new Set();
				const top = blocks[blocks.length - 1];
				
				if (top) {
					if (top.type === 'if') {
						if (!top.hasThen) expectedKeywords.add('then');
						expectedKeywords.add('elseif');
						expectedKeywords.add('else');
						expectedKeywords.add('end');
					} else if (top.type === 'for' || top.type === 'while') {
						if (top.pendingDo) expectedKeywords.add('do');
						expectedKeywords.add('end');
					} else if (top.type === 'function') {
						expectedKeywords.add('end');
					} else if (top.type === 'do') {
						expectedKeywords.add('end');
					} else if (top.type === 'repeat') {
						expectedKeywords.add('until');
					}
				}
				
				// Palavras-chave globais que fazem sentido mesmo sem bloco aberto
				expectedKeywords.add('local');
				expectedKeywords.add('function');
				expectedKeywords.add('if');
				expectedKeywords.add('for');
				expectedKeywords.add('while');
				expectedKeywords.add('repeat');
				
				const typo = findKeywordSuggestion(w, expectedKeywords);
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
				// AQUI: Erro para "end" solto, sem bloco aberto (inclui end depois de = ou sinais)
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
			if (top && top.type === 'if') top.hasThen = false;
		} else if (w === 'else') {
			const top = blocks[blocks.length - 1];
			if (!top || top.type !== 'if') pushError(t.line, `'${w}' outside of an 'if' block`);
		}
	}

	for (const open of blocks) {
		const needs = open.type === 'repeat' ? "'until'" : "'end'";
		let msg = `Unclosed '${open.type}' block (started on line ${open.line}): missing ${needs}.`;
		
		const expectedKw = open.type === 'repeat' ? 'until' : 'end';
		const typoToken = tokens.find(t => t.type === 'word' && findKeywordSuggestion(t.text, new Set([expectedKw])) === expectedKw);
		
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
