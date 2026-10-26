const lib = require('./library');
const { Gen, luaString, unparen } = require('./gen-core');
const { CSError } = require('./lexer');
const stmt = require('./gen-stmt');

Object.assign(Gen.prototype, require('./gen-kind'), require('./gen-expr'), stmt.methods);

const classMethods = {
	collect() {
		const nodes = this.unit.members.filter((m) => m.k === 'class' || m.k === 'enum');
		for (const n of nodes) {
			if (this.classes.has(n.name)) {
				this.warn(`Type '${n.name}' is declared more than once; the first declaration is used.`, n, 'CS0101');
				continue;
			}
			this.classes.set(n.name, { name: n.name, lua: lib.luaName(n.name), node: n, base: null, libBase: null, members: new Map(), isEnum: n.k === 'enum' });
		}
		for (const info of this.classes.values()) {
			const n = info.node;
			if (info.isEnum) {
				n.members.forEach((m) => info.members.set(m.name, { k: 'field', static: true, kind: { k: 'int' } }));
				continue;
			}
			for (const b of n.bases) {
				if (this.classes.has(b.n) && !info.base && !this.classes.get(b.n).isEnum) {
					info.base = b.n;
				} else if (lib.EXCEPTION_BASES.has(b.n)) {
					info.libBase = 'Exception';
				} else if (lib.LIB_BASES.has(b.n) && !info.libBase) {
					info.libBase = 'MonoBehaviour';
				}
			}
			for (const m of n.members) {
				const isStatic = !!m.mods && (m.mods.has('static') || m.mods.has('const'));
				if (m.k === 'field') {
					info.members.set(m.name, { k: m.event ? 'event' : 'field', static: isStatic, kind: lib.typeKind(m.type) });
				} else if (m.k === 'prop') {
					info.members.set(m.name, { k: 'prop', static: isStatic, kind: lib.typeKind(m.type) });
				} else if (m.k === 'method') {
					info.members.set(m.name, { k: 'method', static: isStatic, kind: m.ret.n === 'void' ? { k: 'any' } : lib.typeKind(m.ret), params: m.params });
				}
			}
		}
	},

	order() {
		const out = [];
		const seen = new Set();
		const visit = (info) => {
			if (seen.has(info.name)) {
				return;
			}
			seen.add(info.name);
			if (info.base) {
				visit(this.classes.get(info.base));
			}
			out.push(info);
		};
		for (const info of this.classes.values()) {
			visit(info);
		}
		return out;
	},

	genEnum(info) {
		this.curLine = info.node.line;
		const parts = [];
		let prev = null;
		for (const m of info.node.members) {
			let v;
			if (m.value) {
				v = unparen(this.ex(m.value));
			} else if (prev === null) {
				v = '0';
			} else {
				v = /^-?\d+$/.test(prev) ? String(Number(prev) + 1) : `${info.lua}.${prev} + 1`;
			}
			prev = /^-?\d+$/.test(v) ? v : m.name;
			parts.push(`\t${lib.luaName(m.name)} = ${v},`);
		}
		this.line(`${info.lua} = {`);
		parts.forEach((p) => this.line(p));
		this.line('}');
	},

	paramList(params) {
		const list = params.map((p) => (p.rest ? '...' : lib.luaName(p.name)));
		return list.join(', ');
	},

	enterFn(params) {
		const saved = this.fn;
		this.fn = { tryDepth: 0, loops: [], coroutine: false, catchVar: null };
		this.push();
		params.forEach((p) => this.declare(p.name, p.rest ? { k: 'list', elem: lib.typeKind(p.type) } : lib.typeKind(p.type)));
		return saved;
	},

	leaveFn(saved) {
		this.pop();
		this.fn = saved;
	},

	defaultFor(f) {
		const k = lib.typeKind(f.type).k;
		if (k === 'int' || k === 'float') {
			return '0';
		}
		return k === 'bool' ? 'false' : null;
	},

	genFields(info) {
		const n = info.node;
		this.open(`function ${info.lua}.__fields(self)`);
		const saved = this.enterFn([]);
		for (const m of n.members) {
			if ((m.k !== 'field' && m.k !== 'prop') || m.mods.has('static') || m.mods.has('const')) {
				continue;
			}
			this.curLine = m.line;
			if (m.k === 'prop' && !(m.get && m.get.auto) && !(m.set && m.set.auto && !m.get)) {
				continue;
			}
			const name = lib.luaName(m.name);
			let v = null;
			if (m.event) {
				v = 'CS.Event.new()';
			} else if (m.init) {
				v = m.init.k === 'init' ? this.genInit(m.init, lib.typeKind(m.type)) : unparen(this.ex(m.init));
			} else {
				v = this.defaultFor(m);
			}
			this.flushPre();
			if (v !== null) {
				this.line(`self.${name} = ${v}`);
			}
		}
		this.leaveFn(saved);
		this.close();
	},

	genStatics(info) {
		for (const m of info.node.members) {
			if ((m.k !== 'field' && m.k !== 'prop') || !(m.mods.has('static') || m.mods.has('const'))) {
				continue;
			}
			this.curLine = m.line;
			const saved = this.enterFn([]);
			const v = m.init ? (m.init.k === 'init' ? this.genInit(m.init, lib.typeKind(m.type)) : unparen(this.ex(m.init))) : this.defaultFor(m);
			this.leaveFn(saved);
			if (m.k === 'prop' && m.get && !m.get.auto) {
				this.err('Static properties with custom accessors are not supported.', m, 'CS8143');
			}
			if (v !== null) {
				this.line(`${info.lua}.${lib.luaName(m.name)} = ${v}`);
			}
		}
	},

	genAccessors(info) {
		for (const m of info.node.members) {
			if (m.k !== 'prop' || m.mods.has('static')) {
				continue;
			}
			this.curLine = m.line;
			const g = m.get;
			const s = m.set;
			const customGet = g && !g.auto;
			const customSet = s && !s.auto;
			if ((g && g.auto && customSet) || (s && s.auto && customGet)) {
				this.err('Properties that mix automatic and custom accessors are not supported.', m, 'CS8143');
			}
			const name = lib.luaName(m.name);
			if (customGet) {
				this.open(`function ${info.lua}.__get.${name}(self)`);
				const saved = this.enterFn([]);
				if (g.expr) {
					this.genLambdaExpr(g.expr);
				} else {
					this.genBody(g.body);
				}
				this.leaveFn(saved);
				this.close();
			}
			if (customSet) {
				this.open(`function ${info.lua}.__set.${name}(self, value)`);
				const saved = this.enterFn([{ name: 'value', type: m.type }]);
				if (s.expr) {
					this.genExprStmt(s.expr);
				} else {
					this.genBody(s.body);
				}
				this.leaveFn(saved);
				this.close();
			}
		}
	},

	genCallable(header, params, body, expr, retVoid, prelude) {
		this.open(header);
		const saved = this.enterFn(params);
		this.genParamDefaults(params);
		if (prelude) {
			prelude();
		}
		const yields = body && stmt.hasYield(body);
		if (yields) {
			this.open('return CS.enumerator(function(__yield)', 'end)');
			this.fn.coroutine = true;
		}
		if (body) {
			this.genBody(body);
		} else if (expr) {
			if (retVoid) {
				this.genExprStmt(expr);
			} else {
				this.genLambdaExpr(expr);
			}
		}
		if (yields) {
			this.close();
		}
		this.leaveFn(saved);
		this.close();
	},

	dispatcher(header, entries, label, fnExpr, lead) {
		this.open(header);
		this.line('local n = select("#", ...)');
		for (const e of entries) {
			const max = e.params.some((p) => p.rest) ? 'math.huge' : e.params.length;
			const req = e.params.filter((p) => !p.def && !p.rest).length;
			this.line(`if n >= ${req} and n <= ${max} then`);
			this.line(`\treturn ${fnExpr(e.name)}(${lead}...)`);
			this.line('end');
		}
		this.line(`error("No overload for ${label} takes " .. n .. " arguments.", 2)`);
		this.close();
	},

	genCtors(info) {
		const ctors = info.node.members.filter((m) => m.k === 'ctor' && !m.mods.has('static'));
		const base = info.base ? this.classes.get(info.base) : null;
		if (ctors.length === 0) {
			this.open(`function ${info.lua}.__ctor(self)`);
			this.line(`${info.lua}.__fields(self)`);
			if (base) {
				this.line(`${base.lua}.__ctor(self)`);
			}
			this.close();
			return;
		}
		const entries = [];
		ctors.forEach((c, i) => {
			this.curLine = c.line;
			const nm = ctors.length > 1 ? `__ctor__${i + 1}` : '__ctor';
			entries.push({ name: nm, params: c.params });
			const params = c.params;
			this.genCallable(`function ${info.lua}.${nm}(self${params.length ? ', ' : ''}${this.paramList(params)})`, params, c.body, null, true, () => {
				const init = c.init;
				if (!init || init.kind === 'base') {
					this.line(`${info.lua}.__fields(self)`);
					const args = init ? this.genArgs(init.args) : '';
					if (base) {
						this.line(`${base.lua}.__ctor(self${args ? ', ' + args : ''})`);
					} else if (info.libBase === 'Exception' && args) {
						this.line(`CS.Exception.__ctor(self, ${args})`);
					}
				} else {
					this.line(`${info.lua}.__ctor(self${init.args.length ? ', ' + this.genArgs(init.args) : ''})`);
				}
			});
		});
		if (ctors.length > 1) {
			this.dispatcher(`function ${info.lua}.__ctor(self, ...)`, entries, `constructor of '${info.name}'`, (n) => `${info.lua}.${n}`, 'self, ');
		}
	},

	genMethods(info) {
		const methods = info.node.members.filter((m) => m.k === 'method' && (m.body || m.expr));
		const groups = new Map();
		for (const m of methods) {
			if (!groups.has(m.name)) {
				groups.set(m.name, []);
			}
			groups.get(m.name).push(m);
		}
		for (const m of methods) {
			this.curLine = m.line;
			const list = groups.get(m.name);
			const isStatic = m.mods.has('static');
			const nm = list.length > 1 ? `${lib.luaName(m.name)}__${list.indexOf(m) + 1}` : lib.luaName(m.name);
			const sep = isStatic ? '.' : ':';
			const retVoid = m.ret.n === 'void';
			this.genCallable(`function ${info.lua}${sep}${nm}(${this.paramList(m.params)})`, m.params, m.body, m.expr, retVoid, null);
			if (list.length > 1 && list.indexOf(m) === list.length - 1) {
				const entries = list.map((x, i) => ({ name: `${lib.luaName(m.name)}__${i + 1}`, params: x.params }));
				const header = `function ${info.lua}${sep}${lib.luaName(m.name)}(...)`;
				this.dispatcher(header, entries, `method '${m.name}'`, (n) => (isStatic ? `${info.lua}.${n}` : `self.${n}`), isStatic ? '' : 'self, ');
			}
		}
	},

	genClass(info) {
		const n = info.node;
		this.cls = info;
		this.curLine = n.line;
		const base = info.base ? this.classes.get(info.base).lua : info.libBase ? `CS.${info.libBase}` : 'nil';
		this.line(`${info.lua} = CS.class(${luaString(info.name)}, ${base})`);
		this.genStatics(info);
		this.genFields(info);
		this.genAccessors(info);
		this.genCtors(info);
		this.genMethods(info);
		this.cls = null;
	},

	run() {
		this.collect();
		const infos = this.order();
		const names = infos.map((i) => i.lua);
		let error = null;
		try {
			if (names.length) {
				this.line(`local ${names.join(', ')}`);
			}
			for (const info of infos) {
				if (info.isEnum) {
					this.genEnum(info);
				}
			}
			for (const info of infos) {
				if (!info.isEnum) {
					this.genClass(info);
				}
			}
			for (const info of infos) {
				if (!info.isEnum && this.isBehaviour(info) && !info.node.mods.has('abstract') && !info.node.mods.has('static')) {
					this.line(`CS.start(${info.lua})`);
				}
			}
		} catch (e) {
			if (!(e instanceof CSError)) {
				throw e;
			}
			error = e;
		}
		while (this.closers.length) {
			this.close();
		}
		return error;
	},
};

Object.assign(Gen.prototype, classMethods);

function prelude(options) {
	const mode = options.prelude || 'embedded';
	if (mode === 'module') {
		return [`local CS = require(${options.runtimeRequire || 'script.Parent:WaitForChild("CSharpRuntime")'})`];
	}
	if (mode === 'injected') {
		return ['local CS = __csharp'];
	}
	const body = String(options.runtimeSource || '').replace(/\s+$/, '').split('\n');
	return ['local CS = (function()'].concat(body.map((l) => (l === '' ? '' : '\t' + l)), ['end)()']);
}

function generate(unit, options) {
	const opt = options || {};
	const gen = new Gen(unit, opt);
	const head = prelude(opt);
	const error = gen.run();
	const diagnostics = gen.diags.slice();
	const stop = error || unit.error;
	if (stop) {
		diagnostics.push({ code: stop.code || 'CS1000', severity: 'error', message: stop.message, line: stop.line, column: stop.col });
	}
	const lines = head.map((text) => ({ text, cs: 0 })).concat(gen.out);
	if (stop) {
		lines.push({ text: `-- [CSharp] Conversion stopped at line ${stop.line}: ${stop.message}`, cs: stop.line });
	}
	return {
		source: lines.map((l) => l.text).join('\n'),
		luaToCs: lines.map((l) => l.cs),
		diagnostics,
		stoppedAt: stop ? { line: stop.line, column: stop.col } : null,
		classes: Array.from(gen.classes.keys()),
	};
}

module.exports = { generate };
