// SMFX Proxy — colorize.js
// Tokenizer + colorizador de Luau pra RichText (Roblox <font color='...'>).
// Isolado do server.js de propósito, só pra ficar organizado.

// Paleta pensada pro tema escuro do Script Editor: contraste confortável,
// sem saturar a tela, próxima de esquemas conhecidos (estilo VSCode Dark+)
// pra ficar familiar pra quem já programou em outro lugar.
const CORES = {
	keyword: '#569CD6',   // if/then/for/function/local/return/end...
	constant: '#D19A66',  // true/false/nil
	string: '#CE9178',
	comment: '#6A9955',
	number: '#B5CEA8',
	global: '#4EC9B0',    // game/workspace/script/string/table/math...
	self: '#9CDCFE',      // "self" -- comum o suficiente em OOP pra merecer cor própria
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

function escapeRichText(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrap(text, color) {
	return `<font color='${color}'>${escapeRichText(text)}</font>`;
}

// Tokenizer simples -- mesma filosofia do fallback local no client: cobre
// "..", '..', [[..]] (com [=[..]=] etc), comentário -- e --[[..]], número
// (incluindo hex/decimal), palavra, resto. Não precisa ser um parser Lua
// completo, só bom o suficiente pra colorir direito.
function tokenize(code) {
	const tokens = [];
	let i = 0;
	const n = code.length;

	while (i < n) {
		const c = code[i];

		if (code.startsWith('--', i)) {
			const longOpen = code.slice(i).match(/^--(\[=*\[)/);
			if (longOpen) {
				const closer = ']' + '='.repeat(longOpen[1].length - 2) + ']';
				let end = code.indexOf(closer, i + longOpen[0].length);
				end = end === -1 ? n : end + closer.length;
				tokens.push({ type: 'comment', text: code.slice(i, end) });
				i = end;
			} else {
				let end = code.indexOf('\n', i);
				end = end === -1 ? n : end;
				tokens.push({ type: 'comment', text: code.slice(i, end) });
				i = end;
			}
			continue;
		}

		const longStringOpen = code.slice(i).match(/^\[=*\[/);
		if (longStringOpen) {
			const closer = ']' + '='.repeat(longStringOpen[0].length - 2) + ']';
			let end = code.indexOf(closer, i + longStringOpen[0].length);
			end = end === -1 ? n : end + closer.length;
			tokens.push({ type: 'string', text: code.slice(i, end) });
			i = end;
			continue;
		}

		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < n) {
				if (code[j] === '\\') j += 2;
				else if (code[j] === c) { j++; break; }
				else if (code[j] === '\n') break;
				else j++;
			}
			tokens.push({ type: 'string', text: code.slice(i, j) });
			i = j;
			continue;
		}

		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] || ''))) {
			let j = i;
			while (j < n && /[0-9a-fA-Fx.]/.test(code[j])) j++;
			tokens.push({ type: 'number', text: code.slice(i, j) });
			i = j;
			continue;
		}

		if (/[a-zA-Z_]/.test(c)) {
			let j = i;
			while (j < n && /[a-zA-Z0-9_]/.test(code[j])) j++;
			tokens.push({ type: 'word', text: code.slice(i, j) });
			i = j;
			continue;
		}

		tokens.push({ type: 'other', text: c });
		i++;
	}

	return tokens;
}

function colorizeLua(code) {
	const tokens = tokenize(code);
	let out = '';

	for (const t of tokens) {
		if (t.type === 'comment') out += wrap(t.text, CORES.comment);
		else if (t.type === 'string') out += wrap(t.text, CORES.string);
		else if (t.type === 'number') out += wrap(t.text, CORES.number);
		else if (t.type === 'word') {
			if (KEYWORDS.has(t.text)) out += wrap(t.text, CORES.keyword);
			else if (CONSTANTS.has(t.text)) out += wrap(t.text, CORES.constant);
			else if (t.text === 'self') out += wrap(t.text, CORES.self);
			else if (GLOBALS.has(t.text)) out += wrap(t.text, CORES.global);
			else out += escapeRichText(t.text);
		} else out += escapeRichText(t.text);
	}

	return out;
}

module.exports = { colorizeLua };
        
