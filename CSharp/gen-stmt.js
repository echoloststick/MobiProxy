const lib = require('./library');
const { unparen } = require('./gen-core');

function scan(list, inSwitch, res) {
	const r = res || { cont: false, brk: false, contSwitch: false };
	for (const s of list || []) {
		switch (s.k) {
			case 'continue':
				r.cont = true;
				r.contSwitch = r.contSwitch || inSwitch;
				break;
			case 'break':
				if (!inSwitch) {
					r.brk = true;
				}
				break;
			case 'if':
				scan(s.then, inSwitch, r);
				scan(s.else, inSwitch, r);
				break;
			case 'block':
				scan(s.body, inSwitch, r);
				break;
			case 'try':
				scan(s.body, inSwitch, r);
				s.catches.forEach((c) => scan(c.body, inSwitch, r));
				scan(s.fin, inSwitch, r);
				break;
			case 'switch':
				s.cases.forEach((c) => scan(c.body, true, r));
				break;
			default:
				break;
		}
	}
	return r;
}

function hasYield(list) {
	for (const s of list || []) {
		if (s.k === 'yieldRet' || s.k === 'yieldBreak') {
			return true;
		}
		const subs = [s.body, s.then, s.else, s.fin].concat((s.catches || []).map((c) => c.body)).concat((s.cases || []).map((c) => c.body));
		if (subs.some((b) => Array.isArray(b) && hasYield(b))) {
			return true;
		}
	}
	return false;
}

function assignsTo(node, name) {
	if (!node || typeof node !== 'object') {
		return false;
	}
	if (Array.isArray(node)) {
		return node.some((n) => assignsTo(n, name));
	}
	if ((node.k === 'assign' && node.l.k === 'id' && node.l.name === name) || ((node.k === 'pre' || node.k === 'post') && node.e.k === 'id' && node.e.name === name)) {
		return true;
	}
	return Object.values(node).some((v) => v && typeof v === 'object' && assignsTo(v, name));
}

const methods = {
	genBody(list) {
		list.forEach((s, i) => {
			this.genStmt(s, i === list.length - 1);
		});
	},

	term(text, last) {
		if (last) {
			this.line(text);
			return;
		}
		this.line('do');
		this.line('\t' + text.replace(/\n/g, '\n\t'));
		this.line('end');
	},

	block(list) {
		this.push();
		this.genBody(list);
		this.pop();
	},

	genStmt(s, last) {
		this.curLine = s.line || this.curLine;
		switch (s.k) {
			case 'decl':
				return this.genDecl(s);
			case 'expr':
				return this.genExprStmt(s.e);
			case 'if':
				return this.genIf(s);
			case 'while':
				return this.genWhile(s);
			case 'do':
				return this.genDo(s);
			case 'for':
				return this.genFor(s);
			case 'foreach':
				return this.genForeach(s);
			case 'switch':
				return this.genSwitch(s);
			case 'return':
				return this.genReturn(s, last !== false);
			case 'break':
			case 'continue':
				return this.genJump(s, last !== false);
			case 'throw':
				return this.genThrow(s);
			case 'try':
				return this.genTry(s);
			case 'block':
				this.open('do');
				this.block(s.body);
				this.close();
				return undefined;
			case 'yieldRet': {
				const v = s.e.k === 'null' ? '' : unparen(this.ex(s.e));
				this.flushPre();
				this.line(`__yield(${v})`);
				return undefined;
			}
			case 'yieldBreak':
				this.term('return', last !== false);
				return undefined;
			case 'localfn':
				return this.genLocalFn(s);
			default:
				return this.err(`Statement of kind '${s.k}' is not supported.`, s);
		}
	},

	genDecl(s) {
		for (const v of s.vars) {
			let init = null;
			let kind = s.type.n === 'var' ? { k: 'any' } : lib.typeKind(s.type);
			if (v.init) {
				if (v.init.k === 'init') {
					init = this.genInit(v.init, kind);
				} else {
					init = unparen(this.ex(v.init));
					if (s.type.n === 'var') {
						kind = this.kind(v.init);
					}
				}
			} else if (kind.k === 'int' || kind.k === 'float') {
				init = null;
			}
			this.flushPre();
			const lua = lib.luaName(v.name);
			this.line(init === null ? `local ${lua}` : `local ${lua} = ${init}`);
			this.declare(v.name, kind, lua);
		}
		return undefined;
	},

	genLocalFn(s) {
		this.declare(s.name, { k: 'fn' });
		const saved = this.fn;
		this.fn = { tryDepth: 0, loops: [], coroutine: false };
		this.push();
		s.params.forEach((p) => this.declare(p.name, lib.typeKind(p.type)));
		this.open(`local function ${lib.luaName(s.name)}(${s.params.map((p) => lib.luaName(p.name)).join(', ')})`);
		try {
			this.genParamDefaults(s.params);
			if (s.expr) {
				this.genLambdaExpr(s.expr);
			} else {
				this.genBody(s.body);
			}
			this.close();
		} finally {
			this.pop();
			this.fn = saved;
		}
	},

	genParamDefaults(params) {
		for (const p of params) {
			if (p.def) {
				const lua = lib.luaName(p.name);
				this.line(`if ${lua} == nil then`);
				this.line(`\t${lua} = ${unparen(this.ex(p.def))}`);
				this.line('end');
			}
			if (p.rest) {
				this.line(`local ${lib.luaName(p.name)} = {...}`);
			}
		}
	},

	lvalue(e) {
		if (e.k === 'paren') {
			return this.lvalue(e.e);
		}
		if (e.k === 'id' || e.k === 'member') {
			const get = e.k === 'id' ? this.genId(e) : this.genMember(e);
			return { get, set: (v) => `${get} = ${v}` };
		}
		if (e.k === 'index') {
			const ok = this.kind(e.obj);
			const o = this.ex(e.obj);
			const idx = e.args[0];
			if (ok.k === 'list') {
				const t = `${o}[${this.plusOne(idx)}]`;
				return { get: t, set: (v) => `${t} = ${v}` };
			}
			if (ok.k === 'any' && this.kind(idx).k === 'int') {
				const i = unparen(this.ex(idx));
				return { get: `CS.idx(${o}, ${i})`, set: (v) => `CS.setidx(${o}, ${i}, ${v})` };
			}
			const t = `${o}[${unparen(this.ex(idx))}]`;
			return { get: t, set: (v) => `${t} = ${v}` };
		}
		return this.err('The left-hand side of an assignment must be a variable, property or indexer.', e, 'CS0131');
	},

	isEventTarget(e) {
		if (e.r && e.r.k === 'lambda') {
			return true;
		}
		const t = e.l;
		const name = t.name;
		if (t.k === 'id' && this.cls) {
			const f = this.findMember(this.cls, name);
			if (f && f.m.k === 'event') {
				return true;
			}
		}
		if (t.k === 'member') {
			const ok = this.kind(t.obj);
			if (ok.k === 'class' && this.classes.has(ok.name)) {
				const f = this.findMember(this.classes.get(ok.name), name);
				if (f && f.m.k === 'event') {
					return true;
				}
			}
		}
		return e.r && e.r.k === 'id' && this.cls && !!this.findMember(this.cls, e.r.name) && this.findMember(this.cls, e.r.name).m.k === 'method';
	},

	assignLines(e) {
		const op = e.op;
		if ((op === '+=' || op === '-=') && this.isEventTarget(e)) {
			const lv = this.lvalue(e.l);
			const userEvent = this.userEvent(e.l);
			if (op === '-=' && !userEvent) {
				return this.err('Unsubscribing from Roblox events is not supported; store the connection and call Disconnect instead.', e, 'CS8141');
			}
			const h = unparen(this.ex(e.r));
			return [`${lv.get}:${op === '+=' ? 'Connect' : 'Disconnect'}(${h})`];
		}
		const lv = this.lvalue(e.l);
		if (op === '=') {
			const lk = this.kind(e.l);
			const rhs = e.r.k === 'init' ? this.genInit(e.r, lk) : unparen(this.ex(e.r));
			return [lv.set(rhs)];
		}
		if (op === '??=') {
			return [`if ${lv.get} == nil then`, `\t${lv.set(unparen(this.ex(e.r)))}`, 'end'];
		}
		const bin = { k: 'bin', op: op.slice(0, -1), l: e.l, r: e.r, line: e.line };
		return [lv.set(unparen(this.genBin(bin)))];
	},

	userEvent(t) {
		if (t.k === 'id' && this.cls) {
			const f = this.findMember(this.cls, t.name);
			return !!f && f.m.k === 'event';
		}
		if (t.k === 'member') {
			const ok = this.kind(t.obj);
			const info = ok.k === 'class' ? this.classes.get(ok.name) : null;
			const f = info ? this.findMember(info, t.name) : null;
			return !!f && f.m.k === 'event';
		}
		return false;
	},

	incLines(e) {
		const lv = this.lvalue(e.e);
		const op = e.op === '++' ? '+' : '-';
		return [lv.set(`${lv.get} ${op} 1`)];
	},

	genSideEffect(e) {
		if (e.k === 'assign') {
			const lines = this.assignLines(e);
			return this.iife(lines, this.lvalue(e.l).get);
		}
		const lv = this.lvalue(e.e);
		const op = e.op === '++' ? '+' : '-';
		if (e.k === 'pre') {
			return this.iife([lv.set(`${lv.get} ${op} 1`)], lv.get);
		}
		const t = this.tmp('p');
		return this.iife([`local ${t} = ${lv.get}`, lv.set(`${t} ${op} 1`)], t);
	},

	genExprStmt(x) {
		let lines;
		if (x.k === 'assign') {
			lines = this.assignLines(x);
		} else if (x.k === 'pre' || x.k === 'post') {
			lines = this.incLines(x);
		} else {
			const t = this.ex(x);
			if (x.k === 'call' && !t.startsWith('(')) {
				lines = [t];
			} else if (x.k === 'call' && t.startsWith('(function()')) {
				lines = [';' + t];
			} else {
				lines = [`local _ = ${t}`];
			}
		}
		this.flushPre();
		for (const l of lines) {
			this.line(l);
		}
	},

	elseLine(text) {
		const c = this.closers.pop();
		this.line(text);
		this.closers.push(c);
	},

	genIf(s, cond0) {
		const cond = cond0 !== undefined ? cond0 : unparen(this.ex(s.cond));
		this.flushPre();
		this.open(`if ${cond} then`);
		this.block(s.then);
		let cur = s.else;
		while (cur) {
			if (cur.length === 1 && cur[0].k === 'if') {
				const n = cur[0];
				this.curLine = n.line;
				const c = unparen(this.ex(n.cond));
				if (this.pre.length === 0) {
					this.elseLine(`elseif ${c} then`);
					this.block(n.then);
					cur = n.else;
					continue;
				}
				this.elseLine('else');
				this.genIf(n, c);
				cur = null;
				continue;
			}
			this.elseLine('else');
			this.block(cur);
			cur = null;
		}
		this.close();
	},

	loopCtx(body) {
		const info = scan(body, false);
		const ctx = { kind: 'loop', wrapper: info.cont || false, brkVar: null, contVar: null, tryDepth: this.fn.tryDepth };
		if (ctx.wrapper && info.brk) {
			ctx.brkVar = this.tmp('b');
		}
		if (info.contSwitch) {
			ctx.contVar = this.tmp('k');
		}
		return ctx;
	},

	emitLoopBody(ctx, body, steps) {
		this.fn.loops.push(ctx);
		if (ctx.brkVar) {
			this.line(`local ${ctx.brkVar} = false`);
		}
		if (ctx.contVar) {
			this.line(`local ${ctx.contVar} = false`);
		}
		if (ctx.wrapper) {
			this.open('repeat', 'until true');
			this.block(body);
			this.close();
			if (ctx.brkVar) {
				this.line(`if ${ctx.brkVar} then`);
				this.line('\tbreak');
				this.line('end');
			}
		} else {
			this.block(body);
		}
		this.fn.loops.pop();
		if (steps) {
			steps();
		}
	},

	genWhile(s) {
		const cond = unparen(this.ex(s.cond));
		this.flushPre();
		const ctx = this.loopCtx(s.body);
		this.open(`while ${cond} do`);
		this.emitLoopBody(ctx, s.body);
		this.close();
	},

	genDo(s) {
		const ctx = this.loopCtx(s.body);
		this.open('repeat', 'until true');
		this.emitLoopBody(ctx, s.body);
		const cond = unparen(this.ex(s.cond));
		this.closers.pop();
		this.line(`until not (${cond})`);
	},

	numericFor(s) {
		if (s.init.length !== 1 || s.init[0].k !== 'decl' || s.init[0].vars.length !== 1 || s.step.length !== 1 || !s.cond) {
			return null;
		}
		const d = s.init[0];
		const v = d.vars[0];
		const c = s.cond;
		const st = s.step[0];
		if (!v.init || v.init.k === 'init' || !['int'].includes(lib.typeKind(d.type).k) && !(d.type.n === 'var' && this.kind(v.init).k === 'int')) {
			return null;
		}
		if (c.k !== 'bin' || !['<', '<=', '>', '>='].includes(c.op) || c.l.k !== 'id' || c.l.name !== v.name) {
			return null;
		}
		let step = null;
		if ((st.k === 'post' || st.k === 'pre') && st.e.k === 'id' && st.e.name === v.name) {
			step = st.op === '++' ? 1 : -1;
		} else if (st.k === 'assign' && st.l.k === 'id' && st.l.name === v.name && (st.op === '+=' || st.op === '-=') && st.r.k === 'num' && Number.isInteger(st.r.v) && st.r.v > 0) {
			step = st.op === '+=' ? st.r.v : -st.r.v;
		}
		if (step === null || (step > 0) !== (c.op === '<' || c.op === '<=')) {
			return null;
		}
		const bound = c.r;
		const boundOk = bound.k === 'num' || (bound.k === 'id' && !assignsTo(s.body, bound.name) && !(this.cls && this.findMember(this.cls, bound.name) && !this.lookup(bound.name)));
		if (!boundOk || assignsTo(s.body, v.name) || this.kind(bound).k === 'float') {
			return null;
		}
		return { v, step, c, bound };
	},

	genFor(s) {
		const nf = this.numericFor(s);
		this.push();
		try {
			if (nf) {
				const lua = lib.luaName(nf.v.name);
				const start = unparen(this.ex(nf.v.init));
				let end = unparen(this.ex(nf.bound));
				if (nf.c.op === '<' || nf.c.op === '>') {
					const delta = nf.c.op === '<' ? -1 : 1;
					end = nf.bound.k === 'num' ? String(nf.bound.v + delta) : `${end} ${delta < 0 ? '-' : '+'} 1`;
				}
				this.declare(nf.v.name, { k: 'int' }, lua);
				const ctx = this.loopCtx(s.body);
				this.flushPre();
				this.open(`for ${lua} = ${start}, ${end}${nf.step !== 1 ? ', ' + nf.step : ''} do`);
				this.emitLoopBody(ctx, s.body);
				this.close();
				return;
			}
			this.open('do');
			for (const i of s.init) {
				this.genStmt(i);
			}
			const cond = s.cond ? unparen(this.ex(s.cond)) : 'true';
			this.flushPre();
			const ctx = this.loopCtx(s.body);
			this.open(`while ${cond} do`);
			this.emitLoopBody(ctx, s.body, () => {
				for (const st of s.step) {
					this.genExprStmt(st);
				}
			});
			this.close();
			this.close();
		} finally {
			this.pop();
		}
	},

	genForeach(s) {
		const ik = this.kind(s.iter);
		const it = unparen(this.ex(s.iter));
		this.flushPre();
		const lua = lib.luaName(s.name);
		const ctx = this.loopCtx(s.body);
		this.push();
		try {
			const declared = s.type.n === 'var' ? null : lib.typeKind(s.type);
			if (ik.k === 'dict') {
				const k = this.tmp('k');
				const v = this.tmp('v');
				this.open(`for ${k}, ${v} in pairs(${it}) do`);
				this.line(`local ${lua} = {Key = ${k}, Value = ${v}}`);
				this.declare(s.name, declared || { k: 'class', name: 'KeyValuePair' }, lua);
			} else {
				const iter = ik.k === 'list' ? `ipairs(${it})` : ik.k === 'string' ? `CS.chars(${it})` : `CS.each(${it})`;
				this.open(`for _, ${lua} in ${iter} do`);
				this.declare(s.name, declared || (ik.k === 'list' ? ik.elem : ik.k === 'string' ? { k: 'char' } : { k: 'any' }), lua);
			}
			this.emitLoopBody(ctx, s.body);
			this.close();
		} finally {
			this.pop();
		}
	},

	genSwitch(s) {
		const t = this.tmp('s');
		const val = unparen(this.ex(s.e));
		this.flushPre();
		const cases = s.cases.map((c) => {
			const body = c.body.slice();
			if (body.length && body[body.length - 1].k === 'break') {
				body.pop();
			}
			return { c, body };
		});
		const wrapped = cases.some((x) => scan(x.body, false).brk);
		const loopCtx = [...this.fn.loops].reverse().find((l) => l.kind === 'loop');
		const ctx = { kind: 'switch', wrapped };
		this.open('do');
		this.line(`local ${t} = ${val}`);
		if (wrapped) {
			this.open('repeat', 'until true');
		}
		this.fn.loops.push(ctx);
		const labelled = cases.filter((x) => x.c.labels.length > 0 && !x.c.isDefault);
		const def = cases.find((x) => x.c.isDefault);
		labelled.forEach((x, i) => {
			const cond = x.c.labels.map((l) => `${t} == ${this.ex(l)}`).join(' or ');
			this.flushPre();
			if (i === 0) {
				this.open(`if ${cond} then`);
			} else {
				this.elseLine(`elseif ${cond} then`);
			}
			this.block(x.body);
		});
		if (def) {
			if (labelled.length) {
				this.elseLine('else');
				this.block(def.body);
			} else {
				this.block(def.body);
			}
		}
		if (labelled.length) {
			this.close();
		}
		this.fn.loops.pop();
		if (wrapped) {
			this.close();
			if (loopCtx && loopCtx.contVar) {
				this.line(`if ${loopCtx.contVar} then`);
				this.line('\tbreak');
				this.line('end');
			}
		}
		this.close();
	},

	genJump(s, last) {
		const loops = this.fn.loops;
		const inner = loops[loops.length - 1];
		if (!inner) {
			return this.err(`No enclosing loop out of which to ${s.k}.`, s, 'CS0139');
		}
		const loop = [...loops].reverse().find((l) => l.kind === 'loop');
		if (loop && this.fn.tryDepth > loop.tryDepth) {
			return this.err(`'${s.k}' out of a try block is not supported.`, s, 'CS8142');
		}
		if (s.k === 'break') {
			if (inner.kind !== 'switch' && inner.brkVar) {
				this.term(`${inner.brkVar} = true\nbreak`, last);
			} else {
				this.term('break', last);
			}
			return undefined;
		}
		if (!loop) {
			return this.err("No enclosing loop out of which to continue.", s, 'CS0139');
		}
		this.term(inner.kind === 'switch' && loop.contVar ? `${loop.contVar} = true\nbreak` : 'break', last);
		return undefined;
	},

	genReturn(s, last) {
		const v = s.e ? unparen(this.ex(s.e)) : null;
		this.flushPre();
		const text = this.fn.tryDepth > 0 ? (v === null ? 'return CS.RET' : `return CS.RET, ${v}`) : (v === null ? 'return' : `return ${v}`);
		this.term(text, last);
	},

	genThrow(s) {
		if (!s.e) {
			if (!this.fn.catchVar) {
				return this.err("A throw statement with no expression is only allowed in a catch block.", s, 'CS0156');
			}
			this.line(`error(${this.fn.catchVar}, 0)`);
			return undefined;
		}
		const v = unparen(this.ex(s.e));
		this.flushPre();
		this.line(`error(${v}, 0)`);
		return undefined;
	},

	genTry(s) {
		const ok = this.tmp('ok');
		const a = this.tmp('a');
		const b = this.tmp('b');
		this.open('do');
		this.open(`local ${ok}, ${a}, ${b} = pcall(function()`, 'end)');
		this.fn.tryDepth += 1;
		try {
			this.block(s.body);
		} finally {
			this.fn.tryDepth -= 1;
		}
		this.close();
		if (s.catches.length) {
			const ex = this.tmp('e');
			this.open(`if not ${ok} then`);
			this.line(`local ${ex} = CS.ex(${a})`);
			const savedCatch = this.fn.catchVar;
			let first = true;
			let hasAll = false;
			for (const c of s.catches) {
				const all = !c.type || c.type.n === 'Exception' || c.type.n === 'SystemException';
				const head = all ? null : `CS.is(${ex}, ${this.classes.has(c.type.n) ? this.classes.get(c.type.n).lua : 'CS.' + c.type.n})`;
				if (head) {
					if (first) {
						this.open(`if ${head} then`);
					} else {
						this.elseLine(`elseif ${head} then`);
					}
				} else if (first) {
					this.open('do');
				} else {
					this.elseLine('else');
					hasAll = true;
				}
				first = false;
				this.push();
				if (c.name) {
					this.line(`local ${lib.luaName(c.name)} = ${ex}`);
					this.declare(c.name, { k: 'class', name: c.type ? c.type.n : 'Exception' });
				}
				this.fn.catchVar = ex;
				this.genBody(c.body);
				this.pop();
				if (!head) {
					hasAll = true;
					break;
				}
			}
			if (!hasAll) {
				this.elseLine('else');
				this.line(`\terror(${a}, 0)`);
			}
			this.close();
			this.fn.catchVar = savedCatch;
			this.close();
		}
		if (s.fin) {
			this.block(s.fin);
		}
		if (!s.catches.length) {
			this.line(`if not ${ok} then`);
			this.line(`\terror(${a}, 0)`);
			this.line('end');
		}
		if (this.fn.tryDepth > 0) {
			this.line(`if ${ok} and ${a} == CS.RET then`);
			this.line(`\treturn CS.RET, ${b}`);
			this.line('end');
		} else {
			this.line(`if ${ok} and ${a} == CS.RET then`);
			this.line(`\treturn ${b}`);
			this.line('end');
		}
		this.close();
	},
};

module.exports = { methods, hasYield, scan };
