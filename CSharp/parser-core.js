const { CSError } = require('./lexer');

const TYPE_KW = new Set(['int', 'float', 'double', 'bool', 'string', 'char', 'long', 'short', 'byte', 'object', 'void', 'decimal', 'uint', 'ulong', 'ushort', 'sbyte']);

class Parser {
	constructor(tokens) {
		this.tokens = tokens;
		this.pos = 0;
	}

	peek(o) {
		const t = this.tokens[Math.min(this.pos + (o || 0), this.tokens.length - 1)];
		if (t.t === 'eof' && t.error) {
			throw t.error;
		}
		return t;
	}

	next() {
		const t = this.peek();
		if (t.t !== 'eof') {
			this.pos += 1;
		}
		return t;
	}

	is(v, o) {
		const t = this.peek(o);
		return (t.t === 'op' || t.t === 'kw') && t.v === v;
	}

	isId(v, o) {
		const t = this.peek(o);
		return t.t === 'id' && (v === undefined || t.v === v);
	}

	eat(v) {
		if (this.is(v)) {
			this.pos += 1;
			return true;
		}
		return false;
	}

	fail(msg, tok, code) {
		const t = tok || this.peek();
		throw new CSError(msg, t.line, t.col, code || 'CS1002');
	}

	describe(t) {
		return t.t === 'eof' ? 'end of file' : `'${t.t === 'str' ? '"' + t.v + '"' : t.v}'`;
	}

	expect(v) {
		if (!this.is(v)) {
			this.fail(`Expected '${v}' but found ${this.describe(this.peek())}.`, undefined, v === ';' ? 'CS1002' : 'CS1003');
		}
		return this.next();
	}

	expectId() {
		const t = this.peek();
		if (t.t !== 'id') {
			this.fail(`Expected an identifier but found ${this.describe(t)}.`, t, 'CS1001');
		}
		this.pos += 1;
		return t.v;
	}

	mark() {
		return this.pos;
	}

	reset(p) {
		this.pos = p;
	}

	attempt(fn) {
		const p = this.pos;
		try {
			const r = fn();
			if (r === null || r === undefined || r === false) {
				this.pos = p;
				return null;
			}
			return r;
		} catch (e) {
			if (!(e instanceof CSError)) {
				throw e;
			}
			this.pos = p;
			return null;
		}
	}

	eatGt() {
		const t = this.peek();
		if (t.t === 'op' && t.v === '>') {
			this.pos += 1;
			return;
		}
		if (t.t === 'op' && (t.v === '>>' || t.v === '>=' || t.v === '>>=')) {
			this.tokens.splice(this.pos, 1, { t: 'op', v: '>', line: t.line, col: t.col }, { t: 'op', v: t.v.slice(1), line: t.line, col: t.col + 1 });
			this.pos += 1;
			return;
		}
		this.fail(`Expected '>' but found ${this.describe(t)}.`, t, 'CS1003');
	}

	parseTypeArgs() {
		this.expect('<');
		const args = [];
		do {
			args.push(this.parseType());
		} while (this.eat(','));
		this.eatGt();
		return args;
	}

	parseTypeBase() {
		const t = this.peek();
		let name;
		if (t.t === 'kw' && TYPE_KW.has(t.v)) {
			name = t.v;
			this.pos += 1;
		} else if (t.t === 'id') {
			name = t.v;
			this.pos += 1;
			while ((this.is('.') || this.is('::')) && this.peek(1).t === 'id') {
				this.pos += 1;
				name = this.next().v;
			}
		} else if (this.is('(')) {
			this.fail('Tuple types are not supported.', t, 'CS8137');
		} else {
			this.fail(`Expected a type but found ${this.describe(t)}.`, t, 'CS1031');
		}
		let args = [];
		if (this.is('<')) {
			args = this.parseTypeArgs();
		}
		return { n: name, a: args, arr: 0, nul: false };
	}

	parseType() {
		const ty = this.parseTypeBase();
		if (this.is('?') && !this.is('?', 1)) {
			const after = this.peek(1);
			if (after.t === 'id' || (after.t === 'op' && [')', ',', '>', ';', '=', '['].includes(after.v)) || (after.t === 'kw' && after.v === 'in')) {
				this.pos += 1;
				ty.nul = true;
			}
		}
		while (this.is('[')) {
			if (this.is(']', 1)) {
				this.pos += 2;
				ty.arr += 1;
			} else if (this.is(',', 1)) {
				this.fail('Multidimensional arrays are not supported.', this.peek(), 'CS8138');
			} else {
				break;
			}
		}
		return ty;
	}
}

module.exports = { Parser, TYPE_KW };
