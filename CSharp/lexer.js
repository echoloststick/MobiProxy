class CSError extends Error {
	constructor(message, line, col, code) {
		super(message);
		this.line = line || 0;
		this.col = col || 0;
		this.code = code || 'CS1000';
	}
}

const KEYWORDS = new Set([
	'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
	'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'false', 'finally', 'float',
	'for', 'foreach', 'if', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new',
	'null', 'object', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref',
	'return', 'sbyte', 'sealed', 'short', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true',
	'try', 'typeof', 'uint', 'ulong', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
]);

const OPS = [
	'>>>=', '<<=', '>>=', '??=', '...', '=>', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=',
	'/=', '%=', '&=', '|=', '^=', '??', '?.', '<<', '>>', '::', '+', '-', '*', '/', '%', '=', '<', '>', '!',
	'&', '|', '^', '~', '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}',
];

const ESCAPES = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'", a: '\x07', b: '\b', f: '\f', v: '\v' };

function isIdStart(c) {
	return /[A-Za-z_À-￿]/.test(c);
}

function isIdPart(c) {
	return /[A-Za-z0-9_À-￿]/.test(c);
}

function tokenize(src) {
	const tokens = [];
	let i = 0;
	let line = 1;
	let lineStart = 0;
	const n = src.length;

	function fail(msg, code) {
		throw new CSError(msg, line, i - lineStart + 1, code);
	}

	function readEscape() {
		const c = src[i + 1];
		if (c === 'u' || c === 'x') {
			const len = c === 'u' ? 4 : 2;
			const hex = src.substr(i + 2, len);
			if (!/^[0-9a-fA-F]+$/.test(hex)) {
				fail('Invalid escape sequence in literal.', 'CS1009');
			}
			i += 2 + len;
			return String.fromCodePoint(parseInt(hex, 16));
		}
		if (!(c in ESCAPES)) {
			fail(`Unrecognized escape sequence '\\${c}'.`, 'CS1009');
		}
		i += 2;
		return ESCAPES[c];
	}

	function readString(verbatim, interpolated) {
		const startLine = line;
		const startCol = i - lineStart + 1;
		i += 1;
		const parts = [];
		let buf = '';
		for (;;) {
			if (i >= n) {
				throw new CSError('Unterminated string literal.', startLine, startCol, 'CS1010');
			}
			const c = src[i];
			if (c === '\n' && !verbatim) {
				throw new CSError('Newline in constant.', startLine, startCol, 'CS1010');
			}
			if (c === '"') {
				if (verbatim && src[i + 1] === '"') {
					buf += '"';
					i += 2;
					continue;
				}
				i += 1;
				break;
			}
			if (c === '\n') {
				line += 1;
				lineStart = i + 1;
			}
			if (c === '\\' && !verbatim) {
				buf += readEscape();
				continue;
			}
			if (interpolated && c === '{') {
				if (src[i + 1] === '{') {
					buf += '{';
					i += 2;
					continue;
				}
				let depth = 1;
				let j = i + 1;
				let inStr = false;
				while (j < n && depth > 0) {
					const d = src[j];
					if (d === '"') {
						inStr = !inStr;
					} else if (!inStr && d === '{') {
						depth += 1;
					} else if (!inStr && d === '}') {
						depth -= 1;
					}
					j += 1;
				}
				if (depth !== 0) {
					throw new CSError('Unterminated interpolation in string.', startLine, startCol, 'CS1010');
				}
				if (buf !== '') {
					parts.push({ s: buf });
					buf = '';
				}
				let code = src.slice(i + 1, j - 1);
				let fmt = null;
				const colon = code.lastIndexOf(':');
				if (colon > 0 && !code.includes('?') && !code.includes('"') && !code.includes('::')) {
					fmt = code.slice(colon + 1);
					code = code.slice(0, colon);
				}
				parts.push({ code, fmt, line });
				i = j;
				continue;
			}
			if (interpolated && c === '}') {
				if (src[i + 1] === '}') {
					buf += '}';
					i += 2;
					continue;
				}
				fail("A '}' character must be escaped in an interpolated string.", 'CS1013');
			}
			buf += c;
			i += 1;
		}
		if (buf !== '' || parts.length === 0) {
			parts.push({ s: buf });
		}
		return interpolated ? { t: 'istr', v: parts, line: startLine, col: startCol } : { t: 'str', v: buf, line: startLine, col: startCol };
	}

	try {
		while (i < n) {
			const c = src[i];
			if (c === '\n') {
				line += 1;
				i += 1;
				lineStart = i;
				continue;
			}
			if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') {
				i += 1;
				continue;
			}
			if (c === '/' && src[i + 1] === '/') {
				while (i < n && src[i] !== '\n') {
					i += 1;
				}
				continue;
			}
			if (c === '/' && src[i + 1] === '*') {
				const startLine = line;
				const end = src.indexOf('*/', i + 2);
				if (end < 0) {
					throw new CSError('Unterminated comment.', startLine, i - lineStart + 1, 'CS1035');
				}
				for (let k = i; k < end; k++) {
					if (src[k] === '\n') {
						line += 1;
						lineStart = k + 1;
					}
				}
				i = end + 2;
				continue;
			}
			if (c === '#' && /^\s*$/.test(src.slice(lineStart, i))) {
				while (i < n && src[i] !== '\n') {
					i += 1;
				}
				continue;
			}
			const col = i - lineStart + 1;
			if (c === '"') {
				tokens.push(readString(false, false));
				continue;
			}
			if ((c === '@' && src[i + 1] === '"') || (c === '$' && src[i + 1] === '"')) {
				const interp = c === '$';
				i += 1;
				tokens.push(readString(!interp ? true : false, interp));
				continue;
			}
			if ((c === '$' && src[i + 1] === '@' && src[i + 2] === '"') || (c === '@' && src[i + 1] === '$' && src[i + 2] === '"')) {
				i += 2;
				tokens.push(readString(true, true));
				continue;
			}
			if (c === "'") {
				i += 1;
				let ch;
				if (src[i] === '\\') {
					ch = readEscape();
				} else {
					ch = src[i];
					i += 1;
				}
				if (src[i] !== "'") {
					fail('Too many characters in character literal.', 'CS1012');
				}
				i += 1;
				tokens.push({ t: 'chr', v: ch, line, col });
				continue;
			}
			if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
				const m = src.slice(i).match(/^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:[0-9][0-9_]*)?\.?[0-9_]+(?:[eE][+-]?[0-9]+)?)([fFdDmMuUlL]*)/);
				let text = m[1].replace(/_/g, '');
				const suffix = m[2].toLowerCase();
				if (/^[0-9]+\.$/.test(text)) {
					text = text.slice(0, -1);
				}
				if (/^[0-9]*\.[^0-9]/.test(m[1]) && !/^[0-9]*\.[0-9]/.test(m[1])) {
					fail('Invalid numeric literal.', 'CS1013');
				}
				let value;
				if (/^0[xX]/.test(text)) {
					value = parseInt(text, 16);
				} else if (/^0[bB]/.test(text)) {
					value = parseInt(text.slice(2), 2);
				} else {
					value = Number(text);
				}
				const isFloat = /[.eE]/.test(text) && !/^0[xX]/.test(text) || /[fdm]/.test(suffix);
				tokens.push({ t: 'num', v: value, float: isFloat, line, col });
				i += m[0].length;
				continue;
			}
			if (isIdStart(c) || (c === '@' && isIdStart(src[i + 1] || ''))) {
				let j = i + (c === '@' ? 1 : 0);
				while (j < n && isIdPart(src[j])) {
					j += 1;
				}
				const word = src.slice(i + (c === '@' ? 1 : 0), j);
				const kw = c !== '@' && KEYWORDS.has(word);
				tokens.push({ t: kw ? 'kw' : 'id', v: word, line, col });
				i = j;
				continue;
			}
			let matched = null;
			for (const op of OPS) {
				if (src.startsWith(op, i)) {
					matched = op;
					break;
				}
			}
			if (!matched) {
				fail(`Unexpected character '${c}'.`, 'CS1056');
			}
			tokens.push({ t: 'op', v: matched, line, col });
			i += matched.length;
		}
	} catch (e) {
		if (!(e instanceof CSError)) {
			throw e;
		}
		tokens.push({ t: 'eof', v: '', line: e.line, col: e.col, error: e });
		return tokens;
	}
	tokens.push({ t: 'eof', v: '', line, col: i - lineStart + 1 });
	return tokens;
}

module.exports = { tokenize, CSError, KEYWORDS };
