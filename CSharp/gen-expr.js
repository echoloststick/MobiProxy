const lib = require('./library');
const { luaString, luaNumber, unparen } = require('./gen-core');

const TYPE_KW_MAP = { string: 'String', int: 'Int', long: 'Int', short: 'Int', float: 'Float', double: 'Float', bool: 'Bool', char: 'Char', decimal: 'Float', byte: 'Int' };
const VEC_STATIC = new Set(['Distance', 'Dot', 'Cross', 'Lerp', 'LerpUnclamped', 'Normalize', 'Angle', 'SignedAngle', 'Scale', 'Project', 'MoveTowards', 'Reflect', 'Max', 'Min', 'ClampMagnitude', 'up', 'down', 'forward', 'back', 'left', 'right', 'zero', 'one']);
const RANDOM_STATIC = new Set(['Range', 'value', 'insideUnitSphere', 'insideUnitCircle', 'onUnitSphere', 'rotation']);
const BEHAVIOUR_FIELDS = new Set(['gameObject', 'transform', 'name', 'enabled', 'tag']);
const BEHAVIOUR_METHODS = new Set(['StartCoroutine', 'StopCoroutine', 'StopAllCoroutines', 'Invoke', 'InvokeRepeating', 'CancelInvoke', 'IsInvoking', 'SendMessage']);
const OBJECT_FUNCS = new Set(['Instantiate', 'Destroy', 'DestroyImmediate', 'DontDestroyOnLoad', 'FindObjectOfType', 'FindObjectsOfType']);
const COMPONENT_FUNCS = new Set(['GetComponent', 'GetComponentInChildren', 'GetComponentInParent', 'GetComponents', 'GetComponentsInChildren', 'AddComponent', 'TryGetComponent']);
const COLLECTION_NEW = new Set(['List', 'HashSet', 'Queue', 'Stack', 'LinkedList', 'Dictionary', 'SortedDictionary', 'IList']);

function startsWithCall(s) {
	return s[0] === '(' || s.startsWith('function');
}

const methods = {
	ex(e) {
		if (e.line) {
			this.curLine = e.line;
		}
		switch (e.k) {
			case 'num':
				return luaNumber(e.v);
			case 'str':
				return luaString(e.v);
			case 'bool':
				return e.v ? 'true' : 'false';
			case 'null':
				return 'nil';
			case 'istr':
				return this.genIstr(e);
			case 'id':
				return this.genId(e);
			case 'paren':
				return `(${unparen(this.ex(e.e))})`;
			case 'this':
				return 'self';
			case 'base':
				return this.err("'base' can only be used to call a base member.", e);
			case 'member':
				return this.genMember(e);
			case 'index':
				return this.genIndex(e);
			case 'call':
				return this.genCall(e);
			case 'new':
				return this.genNew(e);
			case 'newArr':
				return this.genNewArr(e);
			case 'anon':
				return this.genInit(e.init, { k: 'any' });
			case 'init':
				return this.genInit(e, { k: 'any' });
			case 'un':
				return this.genUnary(e);
			case 'pre':
			case 'post':
			case 'assign':
				return this.genSideEffect(e);
			case 'bin':
				return this.genBin(e);
			case 'cond':
				return this.genCond(e);
			case 'cast':
				return this.genCast(e);
			case 'is':
				return this.genIs(e);
			case 'as':
				return this.genAs(e);
			case 'lambda':
				return this.genLambda(e);
			case 'typeof':
				return luaString(e.type.n);
			case 'default':
				return this.defaultValue(e.type);
			case 'switchExpr':
				return this.genSwitchExpr(e);
			case 'throwExpr':
				return this.iife([`error(${this.ex(e.e)}, 0)`], null);
			default:
				return this.err(`Expression of kind '${e.k}' is not supported.`, e);
		}
	},

	defaultValue(ty) {
		const k = lib.typeKind(ty || { n: 'object', a: [], arr: 0 }).k;
		if (k === 'int' || k === 'float') {
			return '0';
		}
		return k === 'bool' ? 'false' : 'nil';
	},

	strPart(e) {
		const k = this.kind(e).k;
		const s = this.ex(e);
		return k === 'string' || k === 'char' || k === 'int' || k === 'float' ? s : `tostring(${s})`;
	},

	genIstr(e) {
		const parts = e.parts.map((p) => {
			if (p.s !== undefined) {
				return luaString(p.s);
			}
			if (p.fmt) {
				return `CS.format(${this.ex(p.expr)}, ${luaString(p.fmt)})`;
			}
			return this.strPart(p.expr);
		});
		return parts.length === 1 ? parts[0] : `(${parts.join(' .. ')})`;
	},

	genId(e) {
		const name = e.name;
		const loc = this.lookup(name);
		if (loc) {
			return loc.lua;
		}
		if (this.cls) {
			const f = this.findMember(this.cls, name);
			if (f) {
				const nm = lib.luaName(name);
				if (f.m.k === 'method') {
					return f.m.static ? `${f.owner.lua}.${nm}` : `function(...)\n\treturn self:${nm}(...)\nend`;
				}
				return f.m.static ? `${f.owner.lua}.${nm}` : `self.${nm}`;
			}
			if (this.isBehaviour(this.cls) && BEHAVIOUR_FIELDS.has(name)) {
				return `self.${name}`;
			}
		}
		if (this.classes.has(name)) {
			return this.classes.get(name).lua;
		}
		if (lib.STATIC_LIBS.has(name)) {
			return `CS.${name}`;
		}
		return lib.luaName(name);
	},

	isFreeName(obj) {
		return obj.k === 'id' && !this.lookup(obj.name) && !(this.cls && this.findMember(this.cls, obj.name));
	},

	wrapOpt(o, opt, make) {
		if (!opt) {
			return make(o);
		}
		if (this.isSimple(o)) {
			return `(${o} and ${make(o)})`;
		}
		const t = this.tmp('o');
		return this.iife([`local ${t} = ${o}`, `if ${t} == nil then`, '\treturn nil', 'end'], make(t));
	},

	genMember(e) {
		if (!e.obj) {
			return this.genId({ name: e.name });
		}
		const name = e.name;
		if (this.isFreeName(e.obj) && !this.classes.has(e.obj.name)) {
			const on = e.obj.name;
			if (lib.STATIC_LIBS.has(on)) {
				return `CS.${on}.${name}`;
			}
			if (TYPE_KW_MAP[on]) {
				return `CS.${TYPE_KW_MAP[on]}.${name}`;
			}
			if ((on === 'Vector3' || on === 'Vector2') && VEC_STATIC.has(name)) {
				return `CS.Vector3.${name}`;
			}
			if (on === 'Random' && RANDOM_STATIC.has(name)) {
				return `CS.Random.${name}`;
			}
		}
		const ok = this.kind(e.obj);
		const o = this.ex(e.obj);
		const userMember = ok.k === 'class' && this.classes.has(ok.name) && this.findMember(this.classes.get(ok.name), name);
		return this.wrapOpt(o, e.opt, (x) => {
			if (!userMember) {
				if (name === 'Length' || name === 'Count') {
					return ok.k === 'string' || ok.k === 'list' ? `#${x}` : `CS.len(${x})`;
				}
				if (name === 'Keys' || name === 'Values') {
					return `CS.${name.toLowerCase()}(${x})`;
				}
				if (name === 'sqrMagnitude') {
					return `CS.sqrMag(${x})`;
				}
				if (lib.MEMBER_RENAMES[name] && ok.k !== 'class') {
					return `${x}.${lib.MEMBER_RENAMES[name]}`;
				}
			}
			return `${x}.${lib.luaName(name)}`;
		});
	},

	genIndex(e) {
		if (e.args.length !== 1) {
			return this.err('Multi-dimensional indexing is not supported.', e);
		}
		const ok = this.kind(e.obj);
		const o = this.ex(e.obj);
		const idx = e.args[0];
		return this.wrapOpt(o, e.opt, (x) => {
			if (ok.k === 'list') {
				return `${x}[${this.plusOne(idx)}]`;
			}
			if (ok.k === 'string') {
				const i = this.plusOne(idx);
				return `string.sub(${x}, ${i}, ${i})`;
			}
			if (ok.k === 'any' && this.kind(idx).k === 'int') {
				return `CS.idx(${x}, ${this.ex(idx)})`;
			}
			return `${x}[${unparen(this.ex(idx))}]`;
		});
	},

	plusOne(e) {
		if (e.k === 'num' && Number.isInteger(e.v)) {
			return String(e.v + 1);
		}
		if (e.k === 'bin' && e.op === '-' && e.r.k === 'num' && e.r.v === 1) {
			return unparen(this.ex(e.l));
		}
		return `${this.ex(e)} + 1`;
	},

	genArgs(args, params) {
		let list = args;
		if (args.some((a) => a.name)) {
			if (!params) {
				return this.err('Named arguments are only supported for methods declared in this script.', args[0].e);
			}
			const ordered = [];
			args.forEach((a, i) => {
				const idx = a.name ? params.findIndex((p) => p.name === a.name) : i;
				if (idx < 0) {
					this.err(`The parameter '${a.name}' does not exist.`, a.e);
				}
				ordered[idx] = a;
			});
			list = Array.from(ordered, (a) => a || { e: { k: 'null' } });
		}
		return list.map((a) => {
			if (a.out || a.ref) {
				return this.err("'out' and 'ref' arguments are not supported because Luau cannot pass values by reference.", a.e || args[0].e, 'CS8140');
			}
			return unparen(this.ex(a.e));
		}).join(', ');
	},

	typeArg(t) {
		return this.classes.has(t.n) ? this.classes.get(t.n).lua : luaString(t.n);
	},

	genCall(e) {
		const f = e.fn;
		this.curLine = e.line || this.curLine;
		if (f.k === 'id' || (f.k === 'member' && !f.obj)) {
			return this.callUnqualified(f, e);
		}
		if (f.k === 'member') {
			return this.callMember(f, e);
		}
		return `${this.ex(f)}(${this.genArgs(e.args)})`;
	},

	callUnqualified(f, e) {
		const name = f.name;
		const loc = this.lookup(name);
		if (loc) {
			return `${loc.lua}(${this.genArgs(e.args)})`;
		}
		if (this.cls) {
			const m = this.findMember(this.cls, name);
			if (m && m.m.k === 'method') {
				const nm = lib.luaName(name);
				const a = this.genArgs(e.args, m.m.params);
				return m.m.static ? `${m.owner.lua}.${nm}(${a})` : `self:${nm}(${a})`;
			}
			if (m) {
				return `${this.genId({ name })}(${this.genArgs(e.args)})`;
			}
		}
		if (name === 'nameof' && e.args.length === 1) {
			const a = e.args[0].e;
			return luaString(a.name || 'unknown');
		}
		if (f.targs && COMPONENT_FUNCS.has(name)) {
			return this.componentCall(name, 'self.gameObject', f.targs[0], e.args);
		}
		if (f.targs && OBJECT_FUNCS.has(name)) {
			return `CS.Object.${name}(${this.typeArg(f.targs[0])}${e.args.length ? ', ' + this.genArgs(e.args) : ''})`;
		}
		if (OBJECT_FUNCS.has(name)) {
			return `CS.Object.${name}(${this.genArgs(e.args)})`;
		}
		if (this.cls && this.isBehaviour(this.cls) && (BEHAVIOUR_METHODS.has(name) || COMPONENT_FUNCS.has(name))) {
			return `self:${name}(${this.genArgs(e.args)})`;
		}
		return `${lib.luaName(name)}(${this.genArgs(e.args)})`;
	},

	componentCall(name, obj, targ, args) {
		const rest = args.length ? ', ' + this.genArgs(args) : '';
		return `CS.${name}(${obj}, ${this.typeArg(targ)}${rest})`;
	},

	callMember(f, e) {
		const name = f.name;
		const obj = f.obj;
		if (obj.k === 'base') {
			return this.callBase(name, e);
		}
		if (this.isFreeName(obj)) {
			const on = obj.name;
			if (this.classes.has(on)) {
				const info = this.classes.get(on);
				const m = this.findMember(info, name);
				return `${info.lua}.${lib.luaName(name)}(${this.genArgs(e.args, m && m.m.params)})`;
			}
			if (lib.STATIC_LIBS.has(on)) {
				return `CS.${on}.${name}(${this.genArgs(e.args)})`;
			}
			if (TYPE_KW_MAP[on]) {
				return `CS.${TYPE_KW_MAP[on]}.${name}(${this.genArgs(e.args)})`;
			}
			if ((on === 'Vector3' || on === 'Vector2') && VEC_STATIC.has(name)) {
				return `CS.Vector3.${name}(${this.genArgs(e.args)})`;
			}
			if (on === 'Random' && RANDOM_STATIC.has(name)) {
				return `CS.Random.${name}(${this.genArgs(e.args)})`;
			}
		}
		const ok = this.kind(obj);
		const o = this.ex(obj);
		const userCls = ok.k === 'class' && this.classes.has(ok.name) ? this.classes.get(ok.name) : null;
		const userMember = userCls ? this.findMember(userCls, name) : null;
		return this.wrapOpt(startsWithCall(o) && !o.startsWith('(') ? `(${o})` : o, f.opt, (x) => {
			if (f.targs && COMPONENT_FUNCS.has(name)) {
				return this.componentCall(name, x, f.targs[0], e.args);
			}
			if (f.targs && name === 'GetService') {
				return `${x}:GetService(${luaString(f.targs[0].n)})`;
			}
			if (userMember && userMember.m.k === 'method') {
				const a = this.genArgs(e.args, userMember.m.params);
				return userMember.m.static ? `${userMember.owner.lua}.${lib.luaName(name)}(${a})` : `${x}:${lib.luaName(name)}(${a})`;
			}
			const a = this.genArgs(e.args);
			if (name === 'Invoke') {
				return `CS.invoke(${x}${a ? ', ' + a : ''})`;
			}
			if (ok.k === 'list' && name === 'Add' && e.args.length === 1) {
				return `table.insert(${x}, ${a})`;
			}
			if (!userCls && lib.DYNAMIC_METHODS.has(name) && ok.k !== 'class') {
				return `CS.m.${name}(${x}${a ? ', ' + a : ''})`;
			}
			return `${x}:${lib.luaName(name)}(${a})`;
		});
	},

	callBase(name, e) {
		const args = this.genArgs(e.args);
		const base = this.cls && this.cls.base ? this.classes.get(this.cls.base) : null;
		const target = base ? base.lua : `CS.${this.cls && this.cls.libBase === 'Exception' ? 'Exception' : 'MonoBehaviour'}`;
		return `${target}.${lib.luaName(name)}(self${args ? ', ' + args : ''})`;
	},

	genUnary(e) {
		const v = this.ex(e.e);
		if (e.op === '!') {
			return `(not ${v})`;
		}
		if (e.op === '-') {
			return e.e.k === 'num' ? `(-${v})` : `(-${v})`;
		}
		return e.op === '~' ? `bit32.bnot(${unparen(v)})` : v;
	},

	genBin(e) {
		const op = e.op;
		const lk = this.kind(e.l).k;
		const rk = this.kind(e.r).k;
		if (op === '+' && (lk === 'string' || rk === 'string' || (lk === 'char' && rk === 'char' && false))) {
			return `(${this.strPart(e.l)} .. ${this.strPart(e.r)})`;
		}
		if (op === '??') {
			return this.genCoalesce(e);
		}
		const l = this.ex(e.l);
		const r = this.ex(e.r);
		switch (op) {
			case '&&':
				return `(${l} and ${r})`;
			case '||':
				return `(${l} or ${r})`;
			case '!=':
				return `(${l} ~= ${r})`;
			case '/':
				return lk === 'int' && rk === 'int' ? `CS.idiv(${unparen(l)}, ${unparen(r)})` : `(${l} / ${r})`;
			case '%':
				return `math.fmod(${unparen(l)}, ${unparen(r)})`;
			case '&':
				return lk === 'bool' ? `(${l} and ${r})` : `bit32.band(${unparen(l)}, ${unparen(r)})`;
			case '|':
				return lk === 'bool' ? `(${l} or ${r})` : `bit32.bor(${unparen(l)}, ${unparen(r)})`;
			case '^':
				return lk === 'bool' ? `(${l} ~= ${r})` : `bit32.bxor(${unparen(l)}, ${unparen(r)})`;
			case '<<':
				return `bit32.lshift(${unparen(l)}, ${unparen(r)})`;
			case '>>':
				return `bit32.rshift(${unparen(l)}, ${unparen(r)})`;
			default:
				return `(${l} ${op} ${r})`;
		}
	},

	genCoalesce(e) {
		const l = this.ex(e.l);
		const r = this.ex(e.r);
		if (this.isSimple(l)) {
			return `(${l} == nil and ${r} or ${l})`;
		}
		const t = this.tmp('c');
		return this.iife([`local ${t} = ${l}`, `if ${t} == nil then`, `\treturn ${r}`, 'end'], t);
	},

	isTruthy(e) {
		return ['num', 'str', 'istr', 'new', 'newArr', 'lambda', 'anon'].includes(e.k) || (e.k === 'bool' && e.v);
	},

	genCond(e) {
		const c = unparen(this.ex(e.c));
		const a = this.ex(e.a);
		const b = this.ex(e.b);
		if (this.isTruthy(e.a)) {
			return `(${c} and ${a} or ${b})`;
		}
		return this.iife([`if ${c} then`, `\treturn ${a}`, 'end'], b);
	},

	genCast(e) {
		const k = lib.typeKind(e.type);
		const sk = this.kind(e.e).k;
		const v = this.ex(e.e);
		if (k.k === 'int') {
			if (sk === 'int') {
				return v;
			}
			return sk === 'char' ? `string.byte(${unparen(v)})` : `CS.toInt(${unparen(v)})`;
		}
		if (k.k === 'char' && sk === 'int') {
			return `CS.chr(${unparen(v)})`;
		}
		if (k.k === 'float' && sk === 'char') {
			return `string.byte(${unparen(v)})`;
		}
		return v;
	},

	typeTest(v, ty) {
		const n = ty.n;
		if (lib.INT_TYPES.has(n) || lib.FLOAT_TYPES.has(n)) {
			return `type(${v}) == "number"`;
		}
		if (n === 'string' || n === 'char') {
			return `type(${v}) == "string"`;
		}
		if (n === 'bool') {
			return `type(${v}) == "boolean"`;
		}
		if (n === 'object') {
			return `${v} ~= nil`;
		}
		if (this.classes.has(n)) {
			return `CS.is(${v}, ${this.classes.get(n).lua})`;
		}
		if (lib.VALUE_TYPES.has(n)) {
			return `typeof(${v}) == ${luaString(n)}`;
		}
		return `(typeof(${v}) == "Instance" and ${v}:IsA(${luaString(n)}))`;
	},

	genIs(e) {
		const v = this.ex(e.e);
		const name = e.name;
		const neg = e.neg;
		if (name) {
			const lua = lib.luaName(name);
			this.pre.push(`local ${lua}`);
			this.declare(name, lib.typeKind(e.type), lua);
			const test = this.typeTest(lua, e.type);
			return this.iife([`${lua} = ${v}`, `if ${test} then`, '\treturn true', 'end', `${lua} = nil`], 'false');
		}
		const test = this.isSimple(v) ? this.typeTest(v, e.type) : this.typeTest(unparen(v), e.type);
		return neg ? `(not (${test}))` : `(${test})`;
	},

	genAs(e) {
		const v = this.ex(e.e);
		if (this.classes.has(e.type.n) && this.isSimple(v)) {
			return `(CS.is(${v}, ${this.classes.get(e.type.n).lua}) and ${v} or nil)`;
		}
		return v;
	},

	genSwitchExpr(e) {
		const t = this.tmp('s');
		const lines = [`local ${t} = ${unparen(this.ex(e.e))}`];
		for (const arm of e.arms) {
			let cond = arm.discard ? 'true' : arm.pats.map((p) => `${t} == ${this.ex(p)}`).join(' or ');
			if (arm.guard) {
				cond = `(${cond}) and ${this.ex(arm.guard)}`;
			}
			lines.push(`if ${cond} then`, `\treturn ${unparen(this.ex(arm.e))}`, 'end');
		}
		lines.push('error("No match in switch expression.", 0)');
		return this.iife(lines, null);
	},

	genInit(init, kind) {
		const k = init.kind;
		if (k === 'obj') {
			return `{${init.items.map((i) => `${lib.luaName(i.name)} = ${unparen(this.initValue(i.v))}`).join(', ')}}`;
		}
		if (k === 'dict' || (kind && kind.k === 'dict')) {
			return `{${init.items.map((i) => `[${unparen(this.ex(i.key))}] = ${unparen(this.initValue(i.v))}`).join(', ')}}`;
		}
		return `{${init.items.map((i) => unparen(this.initValue(i.v))).join(', ')}}`;
	},

	initValue(v) {
		return v.k === 'init' ? this.genInit(v, { k: 'any' }) : this.ex(v);
	},

	genNew(e) {
		const ty = e.type;
		if (!ty) {
			return this.err('Target-typed new() expressions are not supported; specify the type explicitly.', e);
		}
		const n = ty.n;
		const kind = lib.typeKind(ty);
		if (COLLECTION_NEW.has(n)) {
			return this.genCollectionNew(e, ty, kind);
		}
		const args = this.genArgs(e.args, this.classes.has(n) ? null : undefined);
		let call;
		if (this.classes.has(n)) {
			call = `${this.classes.get(n).lua}.new(${args})`;
		} else if (n === 'StringBuilder') {
			call = `CS.StringBuilder.new(${args})`;
		} else if (lib.LIB_TYPES.has(n) && !lib.VALUE_TYPES.has(n)) {
			call = `CS.${n}.new(${args})`;
		} else if (lib.VALUE_TYPES.has(n)) {
			call = `${n}.new(${args})`;
		} else {
			call = `Instance.new(${[luaString(n)].concat(args ? [args] : []).join(', ')})`;
		}
		if (!e.init) {
			return call;
		}
		const t = this.tmp('n');
		const lines = [`local ${t} = ${call}`];
		for (const it of e.init.items) {
			if (it.name) {
				lines.push(`${t}.${lib.luaName(it.name)} = ${unparen(this.initValue(it.v))}`);
			}
		}
		return this.iife(lines, t);
	},

	genCollectionNew(e, ty, kind) {
		const n = ty.n;
		const isDict = kind.k === 'dict';
		if (e.init) {
			const body = this.genInit(e.init, kind);
			return n === 'Queue' ? `CS.newQueue(${body})` : n === 'Stack' ? `CS.newStack(${body})` : n === 'HashSet' ? `CS.newSet(${body})` : body;
		}
		const first = e.args[0];
		const copy = first && this.kind(first.e).k !== 'int' ? this.ex(first.e) : null;
		const ctor = { Queue: 'newQueue', Stack: 'newStack', HashSet: 'newSet' }[n];
		if (ctor) {
			return `CS.${ctor}(${copy ? `CS.copy(${copy})` : ''})`;
		}
		return copy ? `CS.copy(${copy})` : (isDict ? '{}' : '{}');
	},

	genNewArr(e) {
		if (e.init) {
			return this.genInit(e.init, { k: 'list' });
		}
		const size = this.ex(e.sizes[0]);
		const elemKind = e.elem ? lib.typeKind({ n: e.elem.n, a: e.elem.a, arr: e.elem.arr, nul: false }) : { k: 'any' };
		const def = elemKind.k === 'int' || elemKind.k === 'float' ? '0' : elemKind.k === 'bool' ? 'false' : 'nil';
		return `CS.newArray(${unparen(size)}, ${def})`;
	},

	genLambda(e) {
		const params = e.params.map((p) => lib.luaName(p.name));
		const saved = this.fn;
		this.fn = { tryDepth: 0, loops: [], coroutine: false };
		this.push();
		e.params.forEach((p) => this.declare(p.name, p.type ? lib.typeKind(p.type) : { k: 'any' }));
		let body;
		try {
			body = this.capture(() => {
				this.closers.push('end');
				if (e.expr) {
					this.genLambdaExpr(e.expr);
				} else {
					this.genBody(e.body);
				}
				this.closers.pop();
			});
		} finally {
			this.pop();
			this.fn = saved;
		}
		return `function(${params.join(', ')})\n${body}\nend`;
	},

	genLambdaExpr(x) {
		if (['assign', 'pre', 'post'].includes(x.k)) {
			this.genExprStmt(x);
			return;
		}
		const s = unparen(this.ex(x));
		this.flushPre();
		this.line(`return ${s}`);
	},
};

module.exports = methods;
