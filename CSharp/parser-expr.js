const { tokenize } = require('./lexer');
const { TYPE_KW } = require('./parser-core');

const BIN_PREC = {
	'??': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6, '==': 7, '!=': 7,
	'<': 8, '>': 8, '<=': 8, '>=': 8, '<<': 9, '>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '??=']);

const methods = {
	parseExpr() {
		return this.parseAssign();
	},

	parseAssign() {
		const left = this.parseTernary();
		const t = this.peek();
		if (t.t === 'op' && ASSIGN_OPS.has(t.v)) {
			this.pos += 1;
			const right = this.parseAssign();
			return { k: 'assign', op: t.v, l: left, r: right, line: t.line };
		}
		return left;
	},

	parseTernary() {
		const cond = this.parseBinary(1);
		if (this.is('?') && !this.is('?.') && !this.is('??')) {
			const t = this.next();
			const a = this.parseAssign();
			this.expect(':');
			const b = this.parseAssign();
			return { k: 'cond', c: cond, a, b, line: t.line };
		}
		return cond;
	},

	parseBinary(min) {
		let left = this.parseUnary();
		for (;;) {
			const t = this.peek();
			if (t.t === 'kw' && (t.v === 'is' || t.v === 'as') && min <= 8) {
				this.pos += 1;
				left = t.v === 'is' ? this.parseIs(left, t) : { k: 'as', e: left, type: this.parseType(), line: t.line };
				continue;
			}
			if (t.t !== 'op' || !(t.v in BIN_PREC) || BIN_PREC[t.v] < min) {
				return left;
			}
			this.pos += 1;
			const prec = BIN_PREC[t.v];
			const right = t.v === '??' ? this.parseBinary(prec) : this.parseBinary(prec + 1);
			left = { k: 'bin', op: t.v, l: left, r: right, line: t.line };
		}
	},

	parseIs(left, t) {
		let neg = false;
		if (this.isId('not')) {
			this.pos += 1;
			neg = true;
		}
		if (this.is('null')) {
			this.pos += 1;
			return { k: 'bin', op: neg ? '!=' : '==', l: left, r: { k: 'null' }, line: t.line };
		}
		const type = this.parseType();
		let name = null;
		if (this.peek().t === 'id' && !neg) {
			name = this.next().v;
		}
		return { k: 'is', e: left, type, name, neg, line: t.line };
	},

	isCast() {
		const p = this.mark();
		this.pos += 1;
		const ty = this.attempt(() => {
			const r = this.parseType();
			return this.is(')') ? r : null;
		});
		if (!ty) {
			this.reset(p);
			return null;
		}
		this.pos += 1;
		const n = this.peek();
		const keywordType = TYPE_KW.has(ty.n) && ty.arr === 0;
		let ok = n.t === 'id' || n.t === 'num' || n.t === 'str' || n.t === 'istr' || n.t === 'chr';
		ok = ok || (n.t === 'op' && (n.v === '(' || n.v === '!' || n.v === '~'));
		ok = ok || (n.t === 'op' && (n.v === '-' || n.v === '+') && keywordType);
		ok = ok || (n.t === 'kw' && ['this', 'new', 'true', 'false', 'null', 'typeof', 'default'].includes(n.v));
		ok = ok || (n.t === 'kw' && TYPE_KW.has(n.v));
		if (!ok) {
			this.reset(p);
			return null;
		}
		return ty;
	},

	parseUnary() {
		const t = this.peek();
		if (t.t === 'op') {
			if (t.v === '!' || t.v === '-' || t.v === '+' || t.v === '~') {
				this.pos += 1;
				return { k: 'un', op: t.v, e: this.parseUnary(), line: t.line };
			}
			if (t.v === '++' || t.v === '--') {
				this.pos += 1;
				return { k: 'pre', op: t.v, e: this.parseUnary(), line: t.line };
			}
			if (t.v === '(' && !this.isLambdaAhead()) {
				const ty = this.isCast();
				if (ty) {
					return { k: 'cast', type: ty, e: this.parseUnary(), line: t.line };
				}
			}
		}
		return this.parsePostfix(this.parsePrimary());
	},

	isLambdaAhead() {
		if (this.is('(')) {
			let depth = 0;
			let i = 0;
			for (;;) {
				const t = this.peek(i);
				if (t.t === 'eof') {
					return false;
				}
				if (t.t === 'op' && t.v === '(') {
					depth += 1;
				} else if (t.t === 'op' && t.v === ')') {
					depth -= 1;
					if (depth === 0) {
						return this.is('=>', i + 1);
					}
				}
				i += 1;
			}
		}
		return this.peek().t === 'id' && this.is('=>', 1);
	},

	parseLambda() {
		const t = this.peek();
		const params = [];
		if (this.is('(')) {
			this.pos += 1;
			while (!this.is(')')) {
				let ty = null;
				if (!(this.peek().t === 'id' && (this.is(',', 1) || this.is(')', 1)))) {
					ty = this.parseType();
				}
				params.push({ name: this.expectId(), type: ty });
				if (!this.eat(',')) {
					break;
				}
			}
			this.expect(')');
		} else {
			params.push({ name: this.expectId(), type: null });
		}
		this.expect('=>');
		const node = { k: 'lambda', params, body: null, expr: null, line: t.line };
		if (this.is('{')) {
			node.body = [];
			this.parseBlock(node.body);
		} else {
			node.expr = this.parseAssign();
		}
		return node;
	},

	parseArgs() {
		const args = [];
		this.expect('(');
		while (!this.is(')')) {
			const arg = { e: null, name: null, out: false, ref: false, decl: null };
			if (this.peek().t === 'id' && this.is(':', 1)) {
				arg.name = this.next().v;
				this.pos += 1;
			}
			if (this.is('out') || this.is('ref')) {
				arg.out = this.next().v === 'out';
				arg.ref = !arg.out;
				const decl = this.attempt(() => {
					const ty = this.parseType();
					return this.peek().t === 'id' ? { type: ty, name: this.next().v } : null;
				});
				if (decl) {
					arg.decl = decl;
				}
			}
			if (!arg.decl) {
				arg.e = this.parseAssign();
			}
			args.push(arg);
			if (!this.eat(',')) {
				break;
			}
		}
		this.expect(')');
		return args;
	},

	parsePostfix(e) {
		for (;;) {
			const t = this.peek();
			if (t.t === 'op') {
				if (t.v === '.' || t.v === '?.') {
					this.pos += 1;
					if (t.v === '?.' && this.is('[')) {
						this.pos += 1;
						const idx = this.parseArgs2();
						e = { k: 'index', obj: e, args: idx, opt: true, line: t.line };
						continue;
					}
					const name = this.expectId();
					e = { k: 'member', obj: e, name, opt: t.v === '?.', line: t.line };
					if (this.is('<')) {
						const targs = this.attempt(() => {
							const a = this.parseTypeArgs();
							return this.is('(') ? a : null;
						});
						if (targs) {
							e.targs = targs;
						}
					}
					continue;
				}
				if (t.v === '(') {
					e = { k: 'call', fn: e, args: this.parseArgs(), line: t.line };
					continue;
				}
				if (t.v === '[') {
					this.pos += 1;
					e = { k: 'index', obj: e, args: this.parseArgs2(), opt: false, line: t.line };
					continue;
				}
				if (t.v === '++' || t.v === '--') {
					this.pos += 1;
					e = { k: 'post', op: t.v, e, line: t.line };
					continue;
				}
				if (t.v === '!' && !this.is('=', 1) && (this.is('.', 1) || this.is(')', 1) || this.is(';', 1))) {
					this.pos += 1;
					continue;
				}
				if (t.v === '<' && e.k === 'id') {
					const targs = this.attempt(() => {
						const a = this.parseTypeArgs();
						return this.is('(') ? a : null;
					});
					if (targs) {
						e = { k: 'call', fn: { k: 'member', obj: null, name: e.name, targs }, args: this.parseArgs(), line: t.line };
						continue;
					}
				}
			}
			if (t.t === 'kw' && t.v === 'switch' && this.is('{', 1)) {
				e = this.parseSwitchExpr(e);
				continue;
			}
			return e;
		}
	},

	parseArgs2() {
		const list = [];
		while (!this.is(']')) {
			list.push(this.parseAssign());
			if (!this.eat(',')) {
				break;
			}
		}
		this.expect(']');
		return list;
	},

	parseSwitchExpr(e) {
		const t = this.next();
		this.expect('{');
		const arms = [];
		while (!this.is('}')) {
			const arm = { pats: [], guard: null, discard: false, e: null };
			if (this.isId('_')) {
				this.pos += 1;
				arm.discard = true;
			} else {
				do {
					arm.pats.push(this.parseBinary(8));
				} while (this.isId('or') && this.next());
			}
			if (this.is('when')) {
				this.pos += 1;
			}
			if (this.isId('when')) {
				this.pos += 1;
				arm.guard = this.parseExpr();
			}
			this.expect('=>');
			arm.e = this.parseAssign();
			arms.push(arm);
			if (!this.eat(',')) {
				break;
			}
		}
		this.expect('}');
		return { k: 'switchExpr', e, arms, line: t.line };
	},

	parseInterpolated(tok) {
		const parts = tok.v.map((p) => {
			if (p.s !== undefined) {
				return { s: p.s };
			}
			const sub = new this.constructor(tokenize(p.code));
			sub.tokens.forEach((x) => {
				x.line = tok.line;
			});
			const expr = sub.parseExpr();
			if (sub.peek().t !== 'eof') {
				this.fail('Invalid expression in interpolated string.', tok, 'CS1073');
			}
			return { expr, fmt: p.fmt };
		});
		return { k: 'istr', parts, line: tok.line };
	},

	parseInit() {
		this.expect('{');
		const items = [];
		let kind = 'list';
		while (!this.is('}')) {
			if (this.peek().t === 'id' && this.is('=', 1)) {
				kind = 'obj';
				const name = this.next().v;
				this.pos += 1;
				items.push({ name, v: this.is('{') ? this.parseInit() : this.parseAssign() });
			} else if (this.is('[')) {
				kind = 'dict';
				this.pos += 1;
				const key = this.parseAssign();
				this.expect(']');
				this.expect('=');
				items.push({ key, v: this.parseAssign() });
			} else if (this.is('{') && this.looksLikePair()) {
				kind = 'dict';
				this.pos += 1;
				const key = this.parseAssign();
				this.expect(',');
				const v = this.parseAssign();
				this.expect('}');
				items.push({ key, v });
			} else if (this.is('{')) {
				items.push({ v: this.parseInit() });
			} else {
				items.push({ v: this.parseAssign() });
			}
			if (!this.eat(',')) {
				break;
			}
		}
		this.expect('}');
		return { k: 'init', kind, items };
	},

	looksLikePair() {
		let depth = 0;
		for (let i = 0; ; i++) {
			const t = this.peek(i);
			if (t.t === 'eof') {
				return false;
			}
			if (t.t === 'op' && (t.v === '{' || t.v === '(' || t.v === '[')) {
				depth += 1;
			} else if (t.t === 'op' && (t.v === '}' || t.v === ')' || t.v === ']')) {
				depth -= 1;
				if (depth === 0) {
					return false;
				}
			} else if (t.t === 'op' && t.v === ',' && depth === 1) {
				return true;
			}
		}
	},

	parseNew() {
		const t = this.next();
		if (this.is('{')) {
			return { k: 'anon', init: this.parseInit(), line: t.line };
		}
		if (this.is('[')) {
			this.pos += 1;
			this.expect(']');
			return { k: 'newArr', elem: null, sizes: [], init: this.parseInit(), line: t.line };
		}
		if (this.is('(')) {
			return { k: 'new', type: null, args: this.parseArgs(), init: this.is('{') ? this.parseInit() : null, line: t.line };
		}
		const ty = this.parseTypeBase();
		if (this.is('[')) {
			this.pos += 1;
			const sizes = [];
			if (!this.is(']')) {
				sizes.push(this.parseAssign());
				if (this.is(',')) {
					this.fail('Multidimensional arrays are not supported.', this.peek(), 'CS8138');
				}
			}
			this.expect(']');
			while (this.is('[') && this.is(']', 1)) {
				this.pos += 2;
				ty.arr += 1;
			}
			return { k: 'newArr', elem: ty, sizes, init: this.is('{') ? this.parseInit() : null, line: t.line };
		}
		const args = this.is('(') ? this.parseArgs() : [];
		return { k: 'new', type: ty, args, init: this.is('{') ? this.parseInit() : null, line: t.line };
	},

	parsePrimary() {
		const t = this.peek();
		switch (t.t) {
			case 'num':
				this.pos += 1;
				return { k: 'num', v: t.v, float: t.float };
			case 'str':
				this.pos += 1;
				return { k: 'str', v: t.v };
			case 'chr':
				this.pos += 1;
				return { k: 'str', v: t.v, chr: true };
			case 'istr':
				this.pos += 1;
				return this.parseInterpolated(t);
			case 'id':
				if (this.is('=>', 1)) {
					return this.parseLambda();
				}
				this.pos += 1;
				return { k: 'id', name: t.v, line: t.line };
			case 'kw':
				return this.parseKeywordPrimary(t);
			case 'op':
				if (t.v === '(') {
					if (this.isLambdaAhead()) {
						return this.parseLambda();
					}
					this.pos += 1;
					const e = this.parseExpr();
					this.expect(')');
					return { k: 'paren', e };
				}
				break;
			default:
				break;
		}
		return this.fail(`Unexpected ${this.describe(t)} in expression.`, t, 'CS1525');
	},

	parseKeywordPrimary(t) {
		switch (t.v) {
			case 'true':
			case 'false':
				this.pos += 1;
				return { k: 'bool', v: t.v === 'true' };
			case 'null':
				this.pos += 1;
				return { k: 'null' };
			case 'this':
				this.pos += 1;
				return { k: 'this' };
			case 'base':
				this.pos += 1;
				return { k: 'base' };
			case 'new':
				return this.parseNew();
			case 'typeof': {
				this.pos += 1;
				this.expect('(');
				const ty = this.parseType();
				this.expect(')');
				return { k: 'typeof', type: ty, line: t.line };
			}
			case 'default': {
				this.pos += 1;
				if (this.eat('(')) {
					const ty = this.parseType();
					this.expect(')');
					return { k: 'default', type: ty };
				}
				return { k: 'default', type: null };
			}
			case 'throw':
				this.pos += 1;
				return { k: 'throwExpr', e: this.parseAssign(), line: t.line };
			default:
				if (TYPE_KW.has(t.v)) {
					this.pos += 1;
					return { k: 'id', name: t.v, line: t.line };
				}
				return this.fail(`Unexpected ${this.describe(t)} in expression.`, t, 'CS1525');
		}
	},
};

module.exports = methods;
