const { tokenize, CSError } = require('./lexer');
const { Parser, TYPE_KW } = require('./parser-core');
const exprMethods = require('./parser-expr');

const MODIFIERS = new Set(['public', 'private', 'protected', 'internal', 'static', 'readonly', 'const', 'abstract', 'virtual', 'override', 'sealed', 'volatile', 'new', 'extern']);
const SOFT_MODIFIERS = new Set(['partial', 'async', 'unsafe']);

Object.assign(Parser.prototype, exprMethods);

const methods = {
	skipAttributes() {
		while (this.is('[')) {
			let depth = 0;
			do {
				if (this.is('[')) {
					depth += 1;
				} else if (this.is(']')) {
					depth -= 1;
				}
				this.next();
			} while (depth > 0);
		}
	},

	parseBlock(out) {
		this.expect('{');
		while (!this.is('}')) {
			if (this.peek().t === 'eof') {
				this.fail("Expected '}' but found end of file.", undefined, 'CS1513');
			}
			this.parseStatement(out);
		}
		this.expect('}');
	},

	parseBody(out) {
		if (this.is('{')) {
			this.parseBlock(out);
		} else {
			this.parseStatement(out);
		}
	},

	tryDeclaration() {
		return this.attempt(() => {
			const start = this.peek();
			const ty = this.parseType();
			if (this.peek().t !== 'id') {
				return null;
			}
			const name = this.peek().v;
			const after = this.peek(1);
			if (after.t === 'op' && ['=', ';', ','].includes(after.v)) {
				return { ty, line: start.line };
			}
			if (after.t === 'op' && after.v === '(') {
				return { ty, line: start.line, fn: true };
			}
			return name && null;
		});
	},

	parseVarList(ty, line, out, stop) {
		const node = { k: 'decl', type: ty, vars: [], line };
		out.push(node);
		do {
			const name = this.expectId();
			const v = { name, init: null };
			if (this.eat('=')) {
				v.init = this.is('{') ? this.parseInit() : this.parseExpr();
			}
			node.vars.push(v);
		} while (this.eat(','));
		if (stop !== false) {
			this.expect(';');
		}
		return node;
	},

	parseParams() {
		const params = [];
		this.expect('(');
		while (!this.is(')')) {
			this.skipAttributes();
			const p = { name: null, type: null, def: null, rest: false };
			while (this.is('ref') || this.is('out') || this.is('params') || this.isId('this') || this.isId('in')) {
				if (this.next().v === 'params') {
					p.rest = true;
				}
			}
			p.type = this.parseType();
			p.name = this.expectId();
			if (this.eat('=')) {
				p.def = this.parseExpr();
			}
			params.push(p);
			if (!this.eat(',')) {
				break;
			}
		}
		this.expect(')');
		return params;
	},

	parseStatement(out) {
		const t = this.peek();
		if (t.t === 'op') {
			if (t.v === '{') {
				const node = { k: 'block', body: [], line: t.line };
				out.push(node);
				this.parseBlock(node.body);
				return;
			}
			if (t.v === ';') {
				this.pos += 1;
				return;
			}
		}
		if (t.t === 'kw') {
			switch (t.v) {
				case 'if':
					return this.parseIf(out);
				case 'while': {
					this.pos += 1;
					this.expect('(');
					const cond = this.parseExpr();
					this.expect(')');
					const node = { k: 'while', cond, body: [], line: t.line };
					out.push(node);
					return this.parseBody(node.body);
				}
				case 'do': {
					this.pos += 1;
					const node = { k: 'do', cond: null, body: [], line: t.line };
					out.push(node);
					this.parseBody(node.body);
					this.expect('while');
					this.expect('(');
					node.cond = this.parseExpr();
					this.expect(')');
					this.expect(';');
					return undefined;
				}
				case 'for':
					return this.parseFor(out);
				case 'foreach':
					return this.parseForeach(out);
				case 'switch':
					return this.parseSwitch(out);
				case 'return': {
					this.pos += 1;
					const e = this.is(';') ? null : this.parseExpr();
					this.expect(';');
					out.push({ k: 'return', e, line: t.line });
					return undefined;
				}
				case 'break':
				case 'continue':
					this.pos += 1;
					this.expect(';');
					out.push({ k: t.v, line: t.line });
					return undefined;
				case 'throw': {
					this.pos += 1;
					const e = this.is(';') ? null : this.parseExpr();
					this.expect(';');
					out.push({ k: 'throw', e, line: t.line });
					return undefined;
				}
				case 'try':
					return this.parseTry(out);
				case 'using':
				case 'lock':
					return this.parseUsingLock(out);
				case 'const':
					this.pos += 1;
					return this.parseStatement(out);
				default:
					break;
			}
		}
		if (t.t === 'id' && t.v === 'yield') {
			this.pos += 1;
			if (this.is('break')) {
				this.pos += 1;
				this.expect(';');
				out.push({ k: 'yieldBreak', line: t.line });
				return undefined;
			}
			this.expect('return');
			const e = this.parseExpr();
			this.expect(';');
			out.push({ k: 'yieldRet', e, line: t.line });
			return undefined;
		}
		const decl = this.tryDeclaration();
		if (decl && decl.fn) {
			return this.parseLocalFn(decl, out);
		}
		if (decl) {
			return this.parseVarList(decl.ty, decl.line, out);
		}
		const e = this.parseExpr();
		this.expect(';');
		out.push({ k: 'expr', e, line: t.line });
		return undefined;
	},

	parseLocalFn(decl, out) {
		const name = this.expectId();
		const params = this.parseParams();
		const node = { k: 'localfn', name, params, ret: decl.ty, body: [], expr: null, line: decl.line };
		out.push(node);
		if (this.eat('=>')) {
			node.expr = this.parseExpr();
			this.expect(';');
		} else {
			this.parseBlock(node.body);
		}
	},

	parseIf(out) {
		const t = this.next();
		this.expect('(');
		const cond = this.parseExpr();
		this.expect(')');
		const node = { k: 'if', cond, then: [], else: null, line: t.line };
		out.push(node);
		this.parseBody(node.then);
		if (this.is('else')) {
			this.pos += 1;
			node.else = [];
			this.parseBody(node.else);
		}
	},

	parseFor(out) {
		const t = this.next();
		this.expect('(');
		const node = { k: 'for', init: [], cond: null, step: [], body: [], line: t.line };
		const decl = this.is(';') ? null : this.tryDeclaration();
		if (decl && !decl.fn) {
			this.parseVarList(decl.ty, decl.line, node.init, false);
		} else if (!this.is(';')) {
			do {
				node.init.push({ k: 'expr', e: this.parseExpr(), line: t.line });
			} while (this.eat(','));
		}
		this.expect(';');
		if (!this.is(';')) {
			node.cond = this.parseExpr();
		}
		this.expect(';');
		while (!this.is(')')) {
			node.step.push(this.parseExpr());
			if (!this.eat(',')) {
				break;
			}
		}
		this.expect(')');
		out.push(node);
		this.parseBody(node.body);
	},

	parseForeach(out) {
		const t = this.next();
		this.expect('(');
		const ty = this.parseType();
		const name = this.expectId();
		this.expect('in');
		const iter = this.parseExpr();
		this.expect(')');
		const node = { k: 'foreach', type: ty, name, iter, body: [], line: t.line };
		out.push(node);
		this.parseBody(node.body);
	},

	parseSwitch(out) {
		const t = this.next();
		this.expect('(');
		const e = this.parseExpr();
		this.expect(')');
		const node = { k: 'switch', e, cases: [], line: t.line };
		out.push(node);
		this.expect('{');
		while (!this.is('}')) {
			const c = { labels: [], isDefault: false, body: [], line: this.peek().line };
			let any = false;
			while (this.is('case') || this.is('default')) {
				any = true;
				if (this.next().v === 'default') {
					c.isDefault = true;
				} else {
					const lbl = this.parseTernary();
					if (this.isId('when') || this.peek().t === 'id') {
						this.fail('Pattern matching in case labels is not supported.', this.peek(), 'CS8120');
					}
					c.labels.push(lbl);
				}
				this.expect(':');
			}
			if (!any) {
				this.fail(`Expected 'case' or 'default' but found ${this.describe(this.peek())}.`, undefined, 'CS1003');
			}
			node.cases.push(c);
			while (!this.is('case') && !this.is('default') && !this.is('}')) {
				if (this.peek().t === 'eof') {
					this.fail("Expected '}' but found end of file.", undefined, 'CS1513');
				}
				this.parseStatement(c.body);
			}
		}
		this.expect('}');
	},

	parseTry(out) {
		const t = this.next();
		const node = { k: 'try', body: [], catches: [], fin: null, line: t.line };
		out.push(node);
		this.parseBlock(node.body);
		while (this.is('catch')) {
			this.pos += 1;
			const c = { type: null, name: null, body: [] };
			if (this.eat('(')) {
				c.type = this.parseType();
				if (this.peek().t === 'id') {
					c.name = this.next().v;
				}
				this.expect(')');
			}
			node.catches.push(c);
			this.parseBlock(c.body);
		}
		if (this.is('finally')) {
			this.pos += 1;
			node.fin = [];
			this.parseBlock(node.fin);
		}
		if (node.catches.length === 0 && !node.fin) {
			this.fail("A try statement must have at least one 'catch' or 'finally' block.", t, 'CS1524');
		}
	},

	parseUsingLock(out) {
		const t = this.next();
		this.expect('(');
		const node = { k: 'block', body: [], line: t.line };
		if (t.v === 'using') {
			const decl = this.tryDeclaration();
			if (decl) {
				this.parseVarList(decl.ty, decl.line, node.body, false);
			} else {
				node.body.push({ k: 'expr', e: this.parseExpr(), line: t.line });
			}
		} else {
			this.parseExpr();
		}
		this.expect(')');
		out.push(node);
		this.parseBody(node.body);
	},

	parseMember(list, owner) {
		this.skipAttributes();
		const start = this.peek();
		const mods = new Set();
		for (;;) {
			const t = this.peek();
			if ((t.t === 'kw' && MODIFIERS.has(t.v) && !(t.v === 'new' && this.is('(', 1))) || (t.t === 'id' && SOFT_MODIFIERS.has(t.v) && this.peek(1).t !== 'op')) {
				mods.add(t.v);
				this.pos += 1;
			} else {
				break;
			}
		}
		const t = this.peek();
		if (t.t === 'kw' && t.v === 'using' && !owner) {
			this.pos += 1;
			let name = this.expectId();
			while (this.eat('.')) {
				name += '.' + this.expectId();
			}
			this.expect(';');
			list.usings = list.usings || [];
			list.usings.push(name);
			return;
		}
		if (t.t === 'kw' && t.v === 'namespace') {
			this.pos += 1;
			this.expectId();
			while (this.eat('.')) {
				this.expectId();
			}
			if (this.eat(';')) {
				return;
			}
			this.expect('{');
			while (!this.is('}')) {
				if (this.peek().t === 'eof') {
					this.fail("Expected '}' but found end of file.", undefined, 'CS1513');
				}
				this.parseMember(list, owner);
			}
			this.expect('}');
			return;
		}
		if (t.t === 'kw' && (t.v === 'class' || t.v === 'struct' || t.v === 'interface')) {
			return this.parseClass(list, mods, t.v);
		}
		if (t.t === 'kw' && t.v === 'enum') {
			return this.parseEnum(list);
		}
		if (t.t === 'kw' && t.v === 'delegate') {
			while (!this.is(';')) {
				this.next();
			}
			this.pos += 1;
			return undefined;
		}
		if (!owner) {
			return this.fail(`Unexpected ${this.describe(t)}; expected a type declaration.`, t, 'CS1518');
		}
		const isEvent = this.isId('event') || this.is('event');
		if (isEvent) {
			this.pos += 1;
		}
		if (this.peek().t === 'id' && this.peek().v === owner.name && this.is('(', 1)) {
			return this.parseCtor(owner, mods, start);
		}
		if (this.is('~')) {
			return this.fail('Destructors are not supported.', undefined, 'CS8139');
		}
		const ty = this.parseType();
		if (this.is('operator') || this.isId('operator')) {
			return this.fail('Operator overloading is not supported.', undefined, 'CS8139');
		}
		if (this.is('this') && this.is('[', 1)) {
			return this.fail('Indexers are not supported.', undefined, 'CS8139');
		}
		const name = this.expectId();
		if (this.is('(')) {
			return this.parseMethod(owner, mods, ty, name, start);
		}
		if (this.is('{') || this.is('=>')) {
			return this.parseProperty(owner, mods, ty, name, start);
		}
		const first = { k: 'field', name, type: ty, mods, init: null, event: isEvent, line: start.line };
		owner.members.push(first);
		if (this.eat('=')) {
			first.init = this.is('{') ? this.parseInit() : this.parseExpr();
		}
		while (this.eat(',')) {
			const f = { k: 'field', name: this.expectId(), type: ty, mods, init: null, event: isEvent, line: start.line };
			owner.members.push(f);
			if (this.eat('=')) {
				f.init = this.parseExpr();
			}
		}
		this.expect(';');
		return undefined;
	},

	parseCtor(owner, mods, start) {
		this.pos += 1;
		const node = { k: 'ctor', params: this.parseParams(), mods, init: null, body: [], line: start.line };
		owner.members.push(node);
		if (this.eat(':')) {
			const kind = this.next().v;
			node.init = { kind, args: this.parseArgs() };
		}
		this.parseBlock(node.body);
	},

	parseMethod(owner, mods, ty, name, start) {
		const node = { k: 'method', name, ret: ty, mods, params: this.parseParams(), body: null, expr: null, line: start.line };
		owner.members.push(node);
		if (this.isId('where')) {
			while (!this.is('{') && !this.is(';') && !this.is('=>')) {
				this.next();
			}
		}
		if (this.eat('=>')) {
			node.expr = this.parseExpr();
			this.expect(';');
		} else if (this.eat(';')) {
			node.body = null;
		} else {
			node.body = [];
			this.parseBlock(node.body);
		}
	},

	parseProperty(owner, mods, ty, name, start) {
		const node = { k: 'prop', name, type: ty, mods, get: null, set: null, init: null, line: start.line };
		owner.members.push(node);
		if (this.eat('=>')) {
			node.get = { expr: this.parseExpr() };
			this.expect(';');
			return;
		}
		this.expect('{');
		while (!this.is('}')) {
			while (this.is('private') || this.is('protected') || this.is('internal') || this.is('public')) {
				this.pos += 1;
			}
			const kind = this.expectId();
			if (kind !== 'get' && kind !== 'set' && kind !== 'init') {
				this.fail(`Expected 'get' or 'set' accessor but found '${kind}'.`, undefined, 'CS1014');
			}
			const acc = { auto: false, expr: null, body: null };
			if (this.eat(';')) {
				acc.auto = true;
			} else if (this.eat('=>')) {
				acc.expr = this.parseExpr();
				this.expect(';');
			} else {
				acc.body = [];
				this.parseBlock(acc.body);
			}
			node[kind === 'get' ? 'get' : 'set'] = acc;
		}
		this.expect('}');
		if (this.eat('=')) {
			node.init = this.parseExpr();
			this.expect(';');
		}
	},

	parseClass(list, mods, kind) {
		this.pos += 1;
		const name = this.expectId();
		if (this.is('<')) {
			this.parseTypeArgs();
		}
		const node = { k: 'class', kind, name, bases: [], members: [], mods, line: this.peek().line };
		if (this.eat(':')) {
			do {
				node.bases.push(this.parseType());
			} while (this.eat(','));
		}
		if (this.isId('where')) {
			while (!this.is('{')) {
				this.next();
			}
		}
		this.expect('{');
		if (kind !== 'interface') {
			list.push(node);
			this.parseNested(node, list);
			this.expect('}');
			return;
		}
		let depth = 1;
		while (depth > 0) {
			const t = this.next();
			if (t.t === 'eof') {
				this.fail("Expected '}' but found end of file.", t, 'CS1513');
			}
			if (t.t === 'op' && t.v === '{') {
				depth += 1;
			} else if (t.t === 'op' && t.v === '}') {
				depth -= 1;
			}
		}
	},

	parseNested(node, list) {
		while (!this.is('}')) {
			if (this.peek().t === 'eof') {
				this.fail("Expected '}' but found end of file.", undefined, 'CS1513');
			}
			this.parseMember(list, node);
		}
	},

	parseEnum(list) {
		this.pos += 1;
		const node = { k: 'enum', name: this.expectId(), members: [], line: this.peek().line };
		if (this.eat(':')) {
			this.parseType();
		}
		list.push(node);
		this.expect('{');
		while (!this.is('}')) {
			this.skipAttributes();
			const m = { name: this.expectId(), value: null };
			if (this.eat('=')) {
				m.value = this.parseExpr();
			}
			node.members.push(m);
			if (!this.eat(',')) {
				break;
			}
		}
		this.expect('}');
	},
};

Object.assign(Parser.prototype, methods);

function parse(source) {
	const tokens = tokenize(source);
	const parser = new Parser(tokens);
	const unit = { members: [], usings: [], error: null };
	try {
		while (parser.peek().t !== 'eof') {
			parser.parseMember(unit.members, null);
		}
	} catch (e) {
		if (!(e instanceof CSError)) {
			throw e;
		}
		unit.error = e;
	}
	unit.usings = unit.members.usings || [];
	return unit;
}

module.exports = { parse, Parser, TYPE_KW };
