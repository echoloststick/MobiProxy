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
	warning: '#DCDCAA', // amarelo -- variável não usada, 'break' fora de loop, código morto depois de 'return'
};

const KEYWORDS = new Set([
	'if', 'then', 'else', 'elseif', 'end', 'for', 'while', 'do', 'repeat',
	'until', 'function', 'local', 'return', 'break', 'in', 'not', 'and', 'or',
	'continue', 'export', 'type', 'goto',
]);
const CONSTANTS = new Set(['true', 'false', 'nil']);
const GLOBALS = new Set([
	'game', 'workspace', 'script', 'shared', '_G', '_ENV', 'debug',
	'string', 'table', 'math', 'task', 'os', 'coroutine', 'utf8', 'buffer',
	'Instance', 'Enum', 'Vector2', 'Vector3', 'CFrame', 'Color3', 'BrickColor',
	'UDim', 'UDim2', 'Rect', 'NumberRange', 'NumberSequence', 'ColorSequence',
	'NumberSequenceKeypoint', 'ColorSequenceKeypoint', 'PhysicalProperties',
	'Ray', 'Region3', 'TweenInfo', 'Random', 'Content',
	'pairs', 'ipairs', 'next', 'pcall', 'xpcall', 'require', 'typeof', 'type',
	'tostring', 'tonumber', 'print', 'warn', 'error', 'assert', 'select',
	'unpack', 'rawget', 'rawset', 'rawequal', 'setmetatable', 'getmetatable',
	'delay', 'spawn', 'wait', 'tick', 'time', 'elapsedTime', 'DateTime',
]);

const PENDING_DO = new Set(['for', 'while']);
const BRACKET_OPEN = { '(': ')', '[': ']', '{': '}' };
const BRACKET_CLOSE = { ')': '(', ']': '[', '}': '{' };
// Se a linha termina com um desses, a expressão continua na próxima linha --
// usado pra saber quando um 'return' de verdade "terminou" (e não achar que o
// resto de uma chamada/tabela de várias linhas é "código morto").
const TRAILING_CONTINUATION = new Set([',', '+', '-', '*', '/', '%', '^', '.', '=', '<', '>', '~', ':', 'and', 'or']);

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
			// Transposição adjacente ("fi" -> "if") conta como 1 edição, não 2 --
			// é o typo mais comum de todos e o Levenshtein puro não pegava isso.
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				matrix[j][i] = Math.min(matrix[j][i], matrix[j - 2][i - 2] + 1);
			}
		}
	}
	return matrix[b.length][a.length];
}

// Usada tanto pra sugerir palavra-chave (ex: 'fi' -> 'if') quanto nome de
// variável parecido (ex: 'playr' -> 'player') -- os candidatos é que mudam.
function findClosestMatch(word, candidates) {
	let bestMatch = null;
	let minDistance = Infinity;
	
	const defaultKeywords = SUGGESTION_KEYWORDS.filter(kw => kw !== 'end' && kw !== 'until');
	const candidateList = candidates && candidates.size > 0 
		? [...candidates] 
		: defaultKeywords;

	for (const candidate of candidateList) {
		if (candidate === word) continue;
		if (Math.abs(word.length - candidate.length) > 2) continue;
		const dist = levenshtein(word, candidate);
		if (dist < minDistance) {
			minDistance = dist;
			bestMatch = candidate;
		}
	}
	
	const threshold = word.length <= 5 ? 1 : 2;
	if (minDistance <= threshold && minDistance > 0) {
		return bestMatch;
	}
	return null;
}

// O tokenizer emite espaço/tab/quebra-de-linha como um token 'other' PRA CADA
// caractere (necessário pra colorizeWithErrors reconstruir o layout exato) --
// então "o token anterior/seguinte" NUNCA pode ser tokens[i-1]/tokens[i+1]
// direto, isso quase sempre pega um espaço em branco no meio, não a palavra
// de verdade. Comentário também não conta como vizinho significativo (ex:
// "local --[[ nota ]] x = 1" ainda é uma declaração normal de x).
function isInsignificant(tok) {
	return tok.type === 'comment' || (tok.type === 'other' && /^\s$/.test(tok.text));
}

// Pra cada índice em "tokens", acha o token significativo mais próximo antes
// e depois dele. Calculado uma vez só (dois passes lineares) em vez de
// escanear pra trás/frente token a token toda hora que alguém pede prevToken.
function buildNeighbors(tokens) {
	const prev = new Array(tokens.length).fill(null);
	const next = new Array(tokens.length).fill(null);

	let ultimoSignificativo = null;
	for (let i = 0; i < tokens.length; i++) {
		prev[i] = ultimoSignificativo;
		if (!isInsignificant(tokens[i])) ultimoSignificativo = tokens[i];
	}

	let proximoSignificativo = null;
	for (let i = tokens.length - 1; i >= 0; i--) {
		next[i] = proximoSignificativo;
		if (!isInsignificant(tokens[i])) proximoSignificativo = tokens[i];
	}

	return { prev, next };
}

// Avança "j" até o próximo índice que não seja espaço/comentário (ou até
// o fim do array). Usado pra andar token a token em collectVariables sem
// tropeçar nos espaços em branco entre cada palavra.
function skipInsignificant(tokens, j) {
	while (j < tokens.length && isInsignificant(tokens[j])) j++;
	return j;
}

// Faz uma varredura inicial pra descobrir as variáveis declaradas no script.
// Devolve tanto o Set "isso existe" (vars) quanto ONDE cada nome foi declarado
// (declarations) -- essa segunda parte é o que permite: (1) trocar a isenção
// "qualquer palavra depois de vírgula" por uma isenção EXATA por posição de
// token (a de vírgula isentava até argumento de chamada de função por engano)
// e (2) detectar variável declarada e nunca usada.
function collectVariables(tokens) {
	const vars = new Set([...GLOBALS, 'self', '...', '_ENV']);
	const declarations = new Map(); // nome -> [{line, col, len}, ...]

	function declare(tok) {
		vars.add(tok.text);
		if (!declarations.has(tok.text)) declarations.set(tok.text, []);
		declarations.get(tok.text).push({ line: tok.line, col: tok.col, len: tok.text.length });
	}

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type !== 'word') continue;

		if (t.text === 'local' || t.text === 'for') {
			let j = skipInsignificant(tokens, i + 1);
			// "local function nome(...)" não é uma lista "local a, b, c" -- deixa
			// o branch de 'function' (mais abaixo, quando o loop de fora chegar
			// nesse token) cuidar do nome e dos parâmetros.
			if (!(t.text === 'local' && tokens[j] && tokens[j].text === 'function')) {
				// Pra "for NOME, NOME in expr do", o 'in' marca o fim da lista de
				// nomes -- sem essa exclusão, o loop andava por cima dele e
				// "declarava" 'in' e o que vier depois (ex: 'ipairs') também.
				while (j < tokens.length && ((tokens[j].type === 'word' && tokens[j].text !== 'in') || tokens[j].text === ',')) {
					if (tokens[j].type === 'word') declare(tokens[j]);
					j = skipInsignificant(tokens, j + 1);
				}
			}
		} else if (t.text === 'function') {
			let j = skipInsignificant(tokens, i + 1);

			if (tokens[j] && tokens[j].type === 'word') {
				const depoisDoNome = skipInsignificant(tokens, j + 1);
				if (tokens[depoisDoNome] && tokens[depoisDoNome].text === ':') {
					// É um método (ex: function obj:metodo(...)) -- pula o
					// objeto, os dois pontos e o nome do método; nenhum dos
					// dois é uma variável nova sendo declarada aqui.
					const depoisDoisPontos = skipInsignificant(tokens, depoisDoNome + 1);
					j = skipInsignificant(tokens, depoisDoisPontos + 1);
				} else if (tokens[depoisDoNome] && tokens[depoisDoNome].text === '.') {
					// function Tabela.Metodo(...) -- mesma ideia, mas sem "self"
					const depoisDoPonto = skipInsignificant(tokens, depoisDoNome + 1);
					j = skipInsignificant(tokens, depoisDoPonto + 1);
				} else {
					// function nome(...) de verdade -- é uma declaração nova
					declare(tokens[j]);
					j = depoisDoNome;
				}
			}

			// Adiciona os parâmetros da função
			if (tokens[j] && tokens[j].text === '(') {
				j = skipInsignificant(tokens, j + 1);
				while (j < tokens.length && tokens[j].text !== ')') {
					if (tokens[j].type === 'word') declare(tokens[j]);
					j = skipInsignificant(tokens, j + 1);
				}
			}
		}
	}
	return { vars, declarations };
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

	// Escaneia UM token a partir de code[i] (sem tratar backtick -- isso é
	// especial porque pode empurrar VÁRIOS tokens de uma vez, então quem
	// chama trata `` ` `` antes de chegar aqui). Usada tanto pelo loop
	// principal quanto recursivamente dentro de uma string interpolada.
	function scanOne(i) {
		const c = code[i];
		const { line, col } = posOf(i);

		if (code.startsWith('--', i)) {
			const longOpen = code.slice(i).match(/^--(\[=*\[)/);
			if (longOpen) {
				const closer = ']' + '='.repeat(longOpen[1].length - 2) + ']';
				let end = code.indexOf(closer, i + longOpen[0].length);
				const unterminated = end === -1;
				end = unterminated ? n : end + closer.length;
				return { token: { type: 'comment', text: code.slice(i, end), line, col, unterminated }, next: end };
			}
			let end = code.indexOf('\n', i);
			end = end === -1 ? n : end;
			return { token: { type: 'comment', text: code.slice(i, end), line, col }, next: end };
		}

		const longStringOpen = code.slice(i).match(/^\[=*\[/);
		if (longStringOpen) {
			const closer = ']' + '='.repeat(longStringOpen[0].length - 2) + ']';
			let end = code.indexOf(closer, i + longStringOpen[0].length);
			const unterminated = end === -1;
			end = unterminated ? n : end + closer.length;
			return { token: { type: 'string', text: code.slice(i, end), line, col, unterminated }, next: end };
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
			return { token: { type: 'string', text: code.slice(i, j), line, col, unterminated }, next: j };
		}

		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] || ''))) {
			let j = i;
			while (j < n && /[0-9a-fA-Fx.]/.test(code[j])) j++;
			return { token: { type: 'number', text: code.slice(i, j), line, col }, next: j };
		}

		if (/[a-zA-Z_]/.test(c)) {
			let j = i;
			while (j < n && /[a-zA-Z0-9_]/.test(code[j])) j++;
			return { token: { type: 'word', text: code.slice(i, j), line, col }, next: j };
		}

		return { token: { type: 'other', text: c, line, col }, next: i + 1 };
	}

	// String interpolada do Luau: `` `texto {expr} mais texto` ``. O texto
	// literal vira token 'string' igual uma string normal; o que tá dentro de
	// `{}` é código de verdade (pode ter chamada, tabela, outro backtick
	// aninhado etc.) e é tokenizado normalmente via scanOne, token por token,
	// então o checker de variável/sintaxe enxerga o que tem lá dentro.
	function scanInterpolatedString(start) {
		const abre = posOf(start);
		tokens.push({ type: 'string', text: '`', line: abre.line, col: abre.col });

		let i = start + 1;
		let litStart = i;
		let closed = false;

		function flushLiteral(endIdx) {
			if (endIdx > litStart) {
				const p = posOf(litStart);
				tokens.push({ type: 'string', text: code.slice(litStart, endIdx), line: p.line, col: p.col });
			}
		}

		while (i < n) {
			const ch = code[i];
			if (ch === '\\') { i += 2; continue; }
			if (ch === '`') {
				flushLiteral(i);
				const p = posOf(i);
				tokens.push({ type: 'string', text: '`', line: p.line, col: p.col });
				i++;
				closed = true;
				break;
			}
			if (ch === '\n') break; // igual string normal: não atravessa linha sem escape
			if (ch === '{') {
				flushLiteral(i);
				const p = posOf(i);
				tokens.push({ type: 'other', text: '{', line: p.line, col: p.col });
				i = scanInterpolationExpr(i + 1);
				litStart = i;
				continue;
			}
			i++;
		}

		if (!closed) {
			flushLiteral(i);
			const last = tokens[tokens.length - 1];
			if (last && last.type === 'string' && last.text !== '`') {
				last.unterminated = true;
			} else {
				const p = posOf(i);
				tokens.push({ type: 'string', text: '', line: p.line, col: p.col, unterminated: true });
			}
		}

		return i;
	}

	// Consome o conteúdo real dentro de `{...}`, empurrando os tokens de
	// código normalmente, até achar o '}' que fecha (contando chaves
	// aninhadas, tipo um construtor de tabela dentro da expressão).
	function scanInterpolationExpr(i) {
		let depth = 1;
		while (i < n) {
			if (code[i] === '`') { i = scanInterpolatedString(i); continue; }
			const { token, next } = scanOne(i);
			tokens.push(token);
			i = next;
			if (token.type === 'other' && token.text === '{') depth++;
			else if (token.type === 'other' && token.text === '}') {
				depth--;
				if (depth === 0) return i;
			}
		}
		return i; // chegou no fim do código sem fechar -- '{' fica sobrando na pilha de brackets
	}

	while (i < n) {
		if (code[i] === '`') {
			i = scanInterpolatedString(i);
			continue;
		}
		const { token, next } = scanOne(i);
		tokens.push(token);
		i = next;
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
	const rootFrame = { type: 'chunk', line: 0 }; // representa o nível mais externo do arquivo
	const { vars: knownVars, declarations } = collectVariables(tokens);
	const { prev: prevSignificant } = buildNeighbors(tokens);

	// Posições exatas (linha:coluna) de todo nome DECLARADO no script -- troca
	// a isenção antiga "qualquer palavra depois de vírgula" (que isentava até
	// argumento de chamada de função por engano) por uma isenção exata: só o
	// token que É a própria declaração fica de fora da checagem.
	const declarationSites = new Set();
	for (const sites of declarations.values()) {
		for (const site of sites) declarationSites.add(`${site.line}:${site.col}`);
	}

	// Conta quantas vezes cada nome aparece no arquivo inteiro (como token
	// 'word', em qualquer lugar) -- usado pra achar variável declarada e nunca
	// referenciada de novo (unused).
	const occurrenceCount = new Map();
	for (const t of tokens) {
		if (t.type === 'word') occurrenceCount.set(t.text, (occurrenceCount.get(t.text) || 0) + 1);
	}

	const pushError = (line, message, suggestion = null) => errors.push({ line, message, suggestion, severity: 'error' });
	const pushWarning = (t, message) => errors.push({ line: t.line, col: t.col, len: t.text.length, message, severity: 'warning' });

	let inTypeRHS = false; // dentro de "type X = ..." / "export type X = ..." -- não é valor, é tipo
	let typeRHSBaseDepth = 0;

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const prevToken = prevSignificant[i];

		if (t.type === 'comment' || t.type === 'string') {
			if (t.unterminated) {
				const kind = t.type === 'comment' ? 'Unterminated comment' : 'Unterminated string';
				const detail = t.text.startsWith('--[') || t.text.startsWith('[') ? "missing closing ']'" : 'missing closing quote';
				pushError(t.line, `${kind}: ${detail}`);
			}
			continue;
		}

		if (t.type === 'other') {
			if (inTypeRHS && t.text === '\n' && brackets.length === typeRHSBaseDepth) {
				inTypeRHS = false;
			}
			if (t.text === '\n') {
				// Só considera o 'return' atual "terminado" quando a profundidade
				// de brackets voltou à mesma de quando ele começou E a linha que
				// tá terminando não deixa nada pendurado (vírgula, operador,
				// 'and'/'or'...) -- senão uma chamada/tabela de várias linhas
				// vira "código morto" por engano.
				const frame = blocks[blocks.length - 1] || rootFrame;
				if (frame.returnActive && brackets.length === frame.returnBaseDepth) {
					const before = prevSignificant[i];
					if (!(before && TRAILING_CONTINUATION.has(before.text))) {
						frame.returnActive = false;
					}
				}
			}
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

		// --- CÓDIGO MORTO DEPOIS DE 'return' ---
		// Roda ANTES de excluir palavra-chave, porque código morto pode começar
		// com "local", "if", "return" de novo etc, não só identificador.
		{
			const frame = blocks[blocks.length - 1] || rootFrame;
			if (frame.returnLine && !frame.returnActive && !frame.deadCodeWarned && t.line > frame.returnLine
				&& w !== 'end' && w !== 'until' && w !== 'else' && w !== 'elseif') {
				frame.deadCodeWarned = true;
				pushWarning(t, `Unreachable code: this comes after a 'return' on line ${frame.returnLine} and will never run.`);
			}
		}

		// --- DETECÇÃO DE VARIÁVEIS E ERROS DE DIGITAÇÃO ---
		if (!KEYWORDS.has(w) && !CONSTANTS.has(w) && w !== 'self') {
			const isFieldAccess = prevToken && (prevToken.text === '.' || prevToken.text === ':');
			const isDeclarationSite = declarationSites.has(`${t.line}:${t.col}`);
			const isGotoTarget = prevToken && prevToken.text === 'goto';

			// Campo de table constructor: { Nome = valor } ou { Nome: Tipo } --
			// "Nome" não é uma variável sendo lida, é uma chave/anotação de tipo.
			let isTableFieldKey = false;
			if (prevToken && (prevToken.text === '{' || prevToken.text === ',')
				&& brackets.length > 0 && brackets[brackets.length - 1].char === '{') {
				const j1 = skipInsignificant(tokens, i + 1);
				const tok1 = tokens[j1];
				if (tok1 && tok1.text === ':') {
					isTableFieldKey = true;
				} else if (tok1 && tok1.text === '=') {
					const j2 = skipInsignificant(tokens, j1 + 1);
					const tok2 = tokens[j2];
					isTableFieldKey = !(tok2 && tok2.text === '='); // '==' não conta, é comparação
				}
			}

			if (!isFieldAccess && !isDeclarationSite && !isTableFieldKey && !isGotoTarget && !inTypeRHS && !knownVars.has(w)) {
				// Verifica se é um contexto de valor (ex: = en, return en, print(en))
				// Nesses casos, NÃO sugerimos palavras-chave como 'end'
				const isValueContext = prevToken && (
					prevToken.text === '=' || prevToken.text === '(' || prevToken.text === ',' || 
					prevToken.text === 'and' || prevToken.text === 'or' || prevToken.text === 'not' || 
					prevToken.text === '+' || prevToken.text === '-' || prevToken.text === '*' || 
					prevToken.text === '/' || prevToken.text === '%' || prevToken.text === '^' || 
					prevToken.text === '.' || prevToken.text === 'return'
				);
				
				let typo = null;
				if (!isValueContext) {
					// Coleta o contexto atual de blocos para saber quais palavras-chave são esperadas
					const expectedKeywords = new Set();
					const top = blocks[blocks.length - 1];
					if (top) {
						if (top.type === 'if') {
							if (!top.hasThen) expectedKeywords.add('then');
							expectedKeywords.add('elseif'); expectedKeywords.add('else'); expectedKeywords.add('end');
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
					expectedKeywords.add('local'); expectedKeywords.add('function');
					expectedKeywords.add('if'); expectedKeywords.add('for');
					expectedKeywords.add('while'); expectedKeywords.add('repeat');
					
					typo = findClosestMatch(w, expectedKeywords);
				}
				
				if (typo) {
					pushError(t.line, `Unknown word '${w}'. Did you mean '${typo}'?`, `Did you mean '${typo}'?`);
				} else {
					// Se não for erro de digitação de palavra-chave e não estiver
					// declarada, é variável desconhecida -- mas antes de desistir,
					// procura um nome já conhecido/declarado bem parecido (ex:
					// "playr" quando existe "player") e avisa junto, separado do
					// erro principal.
					pushError(t.line, `Unknown variable '${w}'.`, `Declare '${w}' or check for typos.`);

					const varSuggestion = w.length >= 3 ? findClosestMatch(w, knownVars) : null;
					if (varSuggestion) {
						pushWarning(t, `Possible typo: '${w}' is unknown, but a similar name '${varSuggestion}' exists. Did you mean '${varSuggestion}'?`);
					}
				}
			}
		}

		// --- VARIÁVEL NÃO USADA ---
		// Só emite uma vez, quando chega no token que É a declaração (evita
		// repetir o aviso em cada uso caso o nome apareça 1x só, que é a
		// própria declaração). "_" e nomes começando com "_" são convenção
		// pra "sei que não uso, é de propósito" -- não avisa pra esses.
		if (declarationSites.has(`${t.line}:${t.col}`) && w !== '_' && !w.startsWith('_')) {
			const sites = declarations.get(w) || [];
			if ((occurrenceCount.get(w) || 0) <= sites.length) {
				pushWarning(t, `Unused variable '${w}': declared but never used.`);
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
			if (top && top.type === 'if') top.hasThen = false;
		} else if (w === 'else') {
			const top = blocks[blocks.length - 1];
			if (!top || top.type !== 'if') pushError(t.line, `'${w}' outside of an 'if' block`);
		} else if (w === 'type') {
			// "type X = ..." / "export type X = ..." -- tudo até a próxima quebra
			// de linha na mesma profundidade de bracket é anotação de tipo, não
			// valor/variável de verdade, então não passa pela checagem normal.
			inTypeRHS = true;
			typeRHSBaseDepth = brackets.length;
		} else if (w === 'return') {
			const frame = blocks[blocks.length - 1] || rootFrame;
			if (!frame.returnLine) {
				frame.returnLine = t.line;
				frame.returnActive = true;
				frame.returnBaseDepth = brackets.length;
			}
		} else if (w === 'break') {
			let dentroDeLoop = false;
			for (let bi = blocks.length - 1; bi >= 0; bi--) {
				const bt = blocks[bi].type;
				if (bt === 'for' || bt === 'while' || bt === 'repeat') { dentroDeLoop = true; break; }
				if (bt === 'function') break; // 'break' não atravessa fronteira de função
			}
			if (!dentroDeLoop) {
				pushWarning(t, "'break' used outside of a loop -- it only works inside 'for', 'while', or 'repeat', and can't cross into an outer function.");
			}
		}
	}

	for (const open of blocks) {
		const needs = open.type === 'repeat' ? "'until'" : "'end'";
		let msg = `Unclosed '${open.type}' block (started on line ${open.line}): missing ${needs}.`;
		
		const expectedKw = open.type === 'repeat' ? 'until' : 'end';
		const typoToken = tokens.find(t => t.type === 'word' && t.line >= open.line && t.text.length >= 3 && findClosestMatch(t.text, new Set([expectedKw])) === expectedKw);
		
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

function wrapWarningToken(text) {
	return `<font color='${CORES.warning}'><u>${escapeRichText(text)}</u></font>`;
}

function colorizeWithErrors(code) {
	const tokens = tokenize(code);
	const errors = checkSyntax(tokens);

	// Erro = linha inteira vermelha (como já era). Aviso = só o token
	// específico fica amarelo, o resto da linha mantém a cor normal.
	const errorLines = new Set(errors.filter(e => e.severity !== 'warning').map((e) => e.line));
	const warningPositions = new Map(); // "linha:coluna" -> comprimento do token
	for (const e of errors) {
		if (e.severity === 'warning' && typeof e.col === 'number') {
			warningPositions.set(`${e.line}:${e.col}`, e.len);
		}
	}

	const rawLines = code.split('\n');
	const lines = new Array(rawLines.length).fill('');

	for (const t of tokens) {
		const warnLen = warningPositions.get(`${t.line}:${t.col}`);
		const isWarnToken = warnLen === t.text.length;
		const color = isWarnToken ? null : colorOf(t);

		const segments = t.text.split('\n');
		if (segments.length === 1) {
			lines[t.line - 1] += isWarnToken ? wrapWarningToken(t.text) : (color ? wrap(t.text, color) : escapeRichText(t.text));
		} else {
			// Token de aviso nunca ocupa mais de uma linha (é sempre uma
			// palavra) -- esse ramo só acontece pra comentário/string longa.
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
