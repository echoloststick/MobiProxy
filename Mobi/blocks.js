'use strict';

const L = require('./language');

const { T, LIB, VALUE, LITERAL_RETURNS, Reflection, isIdent, quote } = L;
const { ANY, NIL, BOOL, NUM, STR } = T;

const P = { TERN: 0, OR: 1, AND: 2, CMP: 3, CAT: 4, ADD: 5, MUL: 6, UN: 7, POW: 8, LIT: 10, PRE: 11, ATOM: 12 };

const DEFS = new Map();
const ALIASES = new Map();

function def(op, spec) {
  const entry = Object.assign({
    op, kind: 'stmt', context: 'both', since: 1, fields: {}, inputs: {}, stacks: [], label: op,
  }, spec);
  entry.category = entry.category || op.split('.')[0];
  DEFS.set(op, entry);
  (entry.aliases || []).forEach((a) => ALIASES.set(a, op));
}

const Fd = {
  enum: (values, dflt) => ({ kind: 'enum', values, default: dflt }),
  num: (o) => Object.assign({ kind: 'number' }, o || {}),
  int: (o) => Object.assign({ kind: 'number', int: true }, o || {}),
  str: (o) => Object.assign({ kind: 'string' }, o || {}),
  bool: (dflt) => ({ kind: 'boolean', default: dflt }),
  id: (o) => Object.assign({ kind: 'id' }, o || {}),
  type: (o) => Object.assign({ kind: 'type' }, o || {}),
  types: () => ({ kind: 'types', default: [] }),
};

const X = (t, p) => ({ t, p: p === undefined ? P.ATOM : p });

function memberText(obj, name) {
  return isIdent(name) ? obj + '.' + name : obj + '[' + quote(name) + ']';
}

function mayBeNil(t) {
  return !t || t.opt === true || t.k === 'any' || t.k === 'nil';
}

function isSimpleRef(text) {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(text);
}

function numText(v) {
  const n = Object.is(v, -0) ? 0 : v;
  return String(n);
}

const SYMS = {
  add: { sym: '+', prec: P.ADD, text: 'addition' },
  sub: { sym: '-', prec: P.ADD, text: 'subtraction' },
  mul: { sym: '*', prec: P.MUL, text: 'multiplication' },
  div: { sym: '/', prec: P.MUL, text: 'division' },
  idiv: { sym: '//', prec: P.MUL, text: 'floor division' },
  mod: { sym: '%', prec: P.MUL, text: 'modulo' },
  pow: { sym: '^', prec: P.POW, text: 'exponentiation' },
};

const CMP = { eq: '==', ne: '~=', lt: '<', le: '<=', gt: '>', ge: '>=' };

function nullableCheck(c, b, slot, t) {
  if (t && t.opt) {
    c.report('W2001', b, slot, { type: T.fmt(T.strip(t)) });
    return T.strip(t);
  }
  return t;
}

function arithResult(c, b, op, ta, tb) {
  const a = nullableCheck(c, b, 'a', ta);
  const d = nullableCheck(c, b, 'b', tb);
  if (a.k === 'nil' || d.k === 'nil') {
    c.report('E2001', b, null, { message: `Operator '${SYMS[op].sym}' cannot be applied to nil.` });
    return ANY;
  }
  const r = T.arith(op, a, d);
  if (!r) {
    c.report('E2001', b, null, {
      message: `Operator '${SYMS[op].sym}' (${SYMS[op].text}) cannot be applied to ${T.fmt(a)} and ${T.fmt(d)}.`,
    });
    return ANY;
  }
  return r;
}

function conditionWarn(c, b, slot, t) {
  if (t && !t.opt && (t.k === 'number' || t.k === 'string')) c.report('W2004', b, slot, { type: t.k });
}

function funcBody(c, b, name, vars, returns, opts) {
  const params = [];
  (vars || []).forEach((v, i) => {
    if (!v || typeof v.id !== 'string') {
      c.report('E1005', b, null, { message: 'A parameter entry is invalid.' });
      return;
    }
    const declared = c.declType(v, b);
    const given = opts.paramTypes && opts.paramTypes[i] ? opts.paramTypes[i] : null;
    if (declared && given && !T.assignable(given, declared).ok) {
      c.report('E2001', b, null, { message: `Parameter '${v.name}' is declared as ${T.fmt(declared)} but receives ${T.fmt(given)}.` });
    }
    params.push({ id: v.id, name: v.name, type: declared || given || ANY, entry: v });
  });
  if (opts.warnEmpty && !(b.stacks && Array.isArray(b.stacks[name]) && b.stacks[name].length > 0)) c.report('W3004', b, name, {});
  return c.withFrame({ kind: opts.kind, returns, loops: 0, tries: [], locals: 0, name: opts.name || null }, () => {
    c.push({ barrier: true });
    params.forEach((p) => c.declare({ id: p.id, name: p.name }, { type: p.type, kind: 'param', block: b }));
    const r = c.stack(b, name, {});
    c.pop();
    return r;
  });
}

def('lit.number', {
  kind: 'expr', category: 'literal', label: '%value%',
  fields: { value: Fd.num({ default: 0 }) },
  analyze() {
    return NUM;
  },
  emit(e, b) {
    const v = e.field(b, 'value');
    return X(numText(v), v < 0 ? P.UN : P.LIT);
  },
});

def('lit.string', {
  kind: 'expr', category: 'literal', label: '"%value%"',
  fields: { value: Fd.str({ default: '' }) },
  analyze() {
    return STR;
  },
  emit(e, b) {
    return X(quote(e.field(b, 'value')), P.LIT);
  },
});

def('lit.bool', {
  kind: 'expr', category: 'literal', label: '%value%',
  fields: { value: Fd.bool(false) },
  analyze() {
    return BOOL;
  },
  emit(e, b) {
    return X(e.field(b, 'value') ? 'true' : 'false', P.LIT);
  },
});

def('lit.nil', {
  kind: 'expr', category: 'literal', label: 'nil',
  analyze() {
    return NIL;
  },
  emit() {
    return X('nil', P.LIT);
  },
});

def('lit.color', {
  kind: 'expr', category: 'literal', label: 'color %value%',
  fields: { value: Fd.str({ default: '#ffffff', pattern: /^#?[0-9a-fA-F]{6}$/, patternText: 'a six digit hex color such as #FF8800' }) },
  analyze() {
    return T.value('Color3');
  },
  emit(e, b) {
    const hex = String(e.field(b, 'value')).replace('#', '');
    const n = (i) => parseInt(hex.slice(i, i + 2), 16);
    return X(`Color3.fromRGB(${n(0)}, ${n(2)}, ${n(4)})`);
  },
});

def('var.declare', {
  kind: 'stmt', label: 'declare %var% = %value%',
  inputs: { value: { type: 'any', optional: true } },
  declares: 'vars[1]',
  analyze(c, b) {
    const v = (b.vars || [])[0];
    if (!v || typeof v.id !== 'string') {
      c.report('E1005', b, null, { message: 'A variable declaration requires exactly one variable.' });
      c.input(b, 'value', { optional: true });
      return;
    }
    const declared = c.declType(v, b);
    let vt = declared;
    if (c.has(b, 'value')) {
      const t = c.input(b, 'value', declared ? { type: declared } : {});
      if (!declared) vt = t.k === 'nil' ? ANY : t;
    } else {
      c.input(b, 'value', { optional: true });
      if (!declared) vt = ANY;
    }
    c.declare(v, { type: vt, kind: 'local', block: b, trackUnused: true });
  },
  emit(e, b) {
    const v = b.vars[0];
    const name = e.bind(v);
    if (e.has(b, 'value')) e.line(`local ${name} = ${e.x(b, 'value')}`, b);
    else e.line(`local ${name}`, b);
  },
});

def('var.get', {
  kind: 'expr', label: '%var%',
  fields: { var: Fd.id() },
  analyze(c, b) {
    const info = c.lookup(b, c.field(b, 'var'), 'var');
    return info ? info.type : ANY;
  },
  emit(e, b) {
    return X(e.ref(e.field(b, 'var')));
  },
});

def('var.set', {
  kind: 'stmt', label: 'set %var% to %value%',
  fields: { var: Fd.id() },
  inputs: { value: { type: 'any' } },
  analyze(c, b) {
    const info = c.assignTarget(b, c.field(b, 'var'), 'var');
    const t = c.input(b, 'value', info ? { type: info.declared } : {});
    if (info) c.assigned(info, t);
  },
  emit(e, b) {
    e.line(`${e.ref(e.field(b, 'var'))} = ${e.x(b, 'value')}`, b);
  },
});

def('var.change', {
  kind: 'stmt', label: 'change %var% by %value%',
  fields: { var: Fd.id(), op: Fd.enum(['add', 'sub', 'mul', 'div'], 'add') },
  inputs: { value: { type: 'any' } },
  analyze(c, b) {
    const op = c.field(b, 'op');
    const info = c.assignTarget(b, c.field(b, 'var'), 'var');
    const tv = c.input(b, 'value', {});
    if (!info) return;
    c.markRead(info);
    const r = arithResult(c, b, op, info.type, tv);
    const check = T.assignable(r, info.declared);
    if (!check.ok) {
      c.report('E2001', b, 'value', { expected: T.fmt(info.declared), actual: T.fmt(r) });
    }
    c.assigned(info, r);
  },
  emit(e, b) {
    const op = SYMS[e.field(b, 'op')];
    const ref = e.ref(e.field(b, 'var'));
    e.line(`${ref} = ${ref} ${op.sym} ${e.x(b, 'value', op.prec + 1)}`, b);
  },
});

def('op.arith', {
  kind: 'expr', category: 'operator', label: '%a% %op% %b%',
  fields: { op: Fd.enum(['add', 'sub', 'mul', 'div', 'idiv', 'mod', 'pow'], 'add') },
  inputs: { a: { type: 'any' }, b: { type: 'any' } },
  analyze(c, b) {
    const ta = c.input(b, 'a', {});
    const tb = c.input(b, 'b', {});
    return arithResult(c, b, c.field(b, 'op'), ta, tb);
  },
  emit(e, b) {
    const op = e.field(b, 'op');
    const s = SYMS[op];
    const info = e.info(b);
    if (op === 'idiv' && !e.native && info.slots.a && info.slots.b && info.slots.a.k === 'number' && info.slots.b.k === 'number') {
      return X(`math.floor(${e.x(b, 'a', P.TERN)} / ${e.x(b, 'b', P.MUL + 1)})`);
    }
    if (op === 'pow') return X(`${e.x(b, 'a', P.POW + 1)} ^ ${e.x(b, 'b', P.POW)}`, s.prec);
    return X(`${e.x(b, 'a', s.prec)} ${s.sym} ${e.x(b, 'b', s.prec + 1)}`, s.prec);
  },
});

def('op.neg', {
  kind: 'expr', category: 'operator', label: '- %a%',
  inputs: { a: { type: 'any' } },
  analyze(c, b) {
    const ta = nullableCheck(c, b, 'a', c.input(b, 'a', {}));
    const r = T.negate(ta);
    if (!r) {
      c.report('E2001', b, 'a', { message: `Operator '-' (negation) cannot be applied to ${T.fmt(ta)}.` });
      return ANY;
    }
    return r;
  },
  emit(e, b) {
    const inner = e.x(b, 'a', P.UN);
    return X(inner.startsWith('-') ? `-(${inner})` : `-${inner}`, P.UN);
  },
});

def('op.compare', {
  kind: 'expr', category: 'operator', label: '%a% %op% %b%',
  fields: { op: Fd.enum(['eq', 'ne', 'lt', 'le', 'gt', 'ge'], 'eq') },
  inputs: { a: { type: 'any' }, b: { type: 'any' } },
  analyze(c, b) {
    const op = c.field(b, 'op');
    const ta = c.input(b, 'a', {});
    const tb = c.input(b, 'b', {});
    if (op === 'eq' || op === 'ne') {
      const sa = T.strip(ta);
      const sb = T.strip(tb);
      if (sa.k !== 'any' && sb.k !== 'any' && sa.k !== 'nil' && sb.k !== 'nil' && sa.k !== sb.k) {
        c.report('E2001', b, null, { message: `Values of type ${T.fmt(ta)} and ${T.fmt(tb)} can never be equal.` });
      }
    } else {
      const sa = nullableCheck(c, b, 'a', ta);
      const sb = nullableCheck(c, b, 'b', tb);
      if (!T.orderable(sa, sb)) {
        c.report('E2001', b, null, { message: `Values of type ${T.fmt(sa)} and ${T.fmt(sb)} cannot be ordered. Only two numbers or two strings can be compared with '${CMP[op]}'.` });
      }
    }
    return BOOL;
  },
  emit(e, b) {
    const op = CMP[e.field(b, 'op')];
    return X(`${e.x(b, 'a', P.CMP + 1)} ${op} ${e.x(b, 'b', P.CMP + 1)}`, P.CMP);
  },
});

def('op.logic', {
  kind: 'expr', category: 'operator', label: '%a% %op% %b%',
  fields: { op: Fd.enum(['and', 'or'], 'and') },
  inputs: { a: { type: 'any' }, b: { type: 'any' } },
  analyze(c, b) {
    const op = c.field(b, 'op');
    const ta = c.input(b, 'a', {});
    const tb = c.input(b, 'b', {});
    return T.logicType(op, ta, tb);
  },
  emit(e, b) {
    const op = e.field(b, 'op');
    const prec = op === 'and' ? P.AND : P.OR;
    return X(`${e.x(b, 'a', prec)} ${op} ${e.x(b, 'b', prec + 1)}`, prec);
  },
});

def('op.not', {
  kind: 'expr', category: 'operator', label: 'not %a%',
  inputs: { a: { type: 'any' } },
  analyze(c, b) {
    conditionWarn(c, b, 'a', c.input(b, 'a', {}));
    return BOOL;
  },
  emit(e, b) {
    return X(`not ${e.x(b, 'a', P.UN)}`, P.UN);
  },
});

def('op.ternary', {
  kind: 'expr', category: 'operator', label: 'if %cond% then %a% else %b%',
  inputs: { cond: { type: 'any' }, a: { type: 'any' }, b: { type: 'any' } },
  analyze(c, b) {
    conditionWarn(c, b, 'cond', c.input(b, 'cond', {}));
    const ta = c.input(b, 'a', {});
    const tb = c.input(b, 'b', {});
    return T.join(ta, tb);
  },
  emit(e, b) {
    const cond = e.x(b, 'cond', P.TERN);
    const a = e.x(b, 'a', P.TERN);
    const d = e.x(b, 'b', P.TERN);
    if (e.native) return X(`if ${cond} then ${a} else ${d}`, P.TERN);
    return X(`(function()\n\tif ${cond} then\n\t\treturn ${e.indentText(a, 2)}\n\telse\n\t\treturn ${e.indentText(d, 2)}\n\tend\nend)()`);
  },
});

def('op.len', {
  kind: 'expr', category: 'operator', label: 'length of %a%',
  inputs: { a: { type: 'any' } },
  analyze(c, b) {
    const ta = nullableCheck(c, b, 'a', c.input(b, 'a', {}));
    if (ta.k !== 'any' && ta.k !== 'string' && ta.k !== 'list') {
      c.report('E2001', b, 'a', { message: `The length operator requires a string or a list but got ${T.fmt(ta)}.` });
    }
    return NUM;
  },
  emit(e, b) {
    return X(`#${e.x(b, 'a', P.UN)}`, P.UN);
  },
});

def('text.join', {
  kind: 'expr', category: 'text', label: 'join',
  fields: { parts: Fd.int({ default: 2, min: 1, max: 64 }) },
  dynamic: 'part1..partN from fields.parts (coerce to text)',
  analyze(c, b) {
    const n = c.field(b, 'parts');
    for (let i = 1; i <= n; i += 1) c.input(b, 'part' + i, { coerce: true });
    return STR;
  },
  emit(e, b) {
    const n = e.field(b, 'parts');
    const out = [];
    for (let i = 1; i <= n; i += 1) out.push(e.str(b, 'part' + i, P.CAT + 1));
    if (out.length === 1) return X(`tostring(${out[0]})`);
    return X(out.join(' .. '), P.CAT);
  },
});

def('util.log', {
  kind: 'stmt', category: 'utility', label: 'log %message%',
  fields: { level: Fd.enum(['info', 'warn', 'error'], 'info') },
  inputs: { message: { type: 'string', coerce: true } },
  analyze(c, b) {
    c.input(b, 'message', { coerce: true });
  },
  emit(e, b) {
    e.line(`Rt.log(${quote(e.field(b, 'level'))}, ${e.str(b, 'message', P.TERN)})`, b);
  },
});


const LOOP_OPS = new Set(['loop.repeat', 'loop.while', 'loop.until', 'loop.forever', 'loop.range', 'loop.each', 'loop.pairs']);
const CLOSURE_OPS = new Set(['fn.lambda', 'ctl.spawn', 'ctl.delay', 'signal.on', 'signal.connect']);

function scanFlow(list, what) {
  if (!Array.isArray(list)) return false;
  for (const blk of list) {
    if (!blk || typeof blk !== 'object') continue;
    if (blk.op === 'ctl.' + what) return true;
    if (LOOP_OPS.has(blk.op) || CLOSURE_OPS.has(blk.op)) continue;
    const stacks = blk.stacks || {};
    for (const key of Object.keys(stacks)) {
      if (scanFlow(stacks[key], what)) return true;
    }
  }
  return false;
}

def('ctl.if', {
  kind: 'stmt', category: 'control', label: 'if',
  fields: { arms: Fd.int({ default: 1, min: 1, max: 32 }), hasElse: Fd.bool(false) },
  dynamic: 'cond1..N and then1..N from fields.arms; else from fields.hasElse',
  stacks: ['then1', 'else'],
  analyze(c, b) {
    const arms = c.field(b, 'arms');
    const hasElse = c.field(b, 'hasElse');
    const falses = [];
    let allTerm = true;
    let pushed = 0;
    for (let i = 1; i <= arms; i += 1) {
      if (i > 1) {
        c.push({});
        pushed += 1;
        falses.forEach((m) => c.narrow(m));
      }
      const ct = c.input(b, 'cond' + i, {});
      conditionWarn(c, b, 'cond' + i, ct);
      const facts = c.facts(c.arg(b, 'cond' + i));
      const r = c.stack(b, 'then' + i, { narrow: [facts.t] });
      if (!r.terminates) allTerm = false;
      falses.push(facts.f);
    }
    let elseTerm = false;
    if (hasElse) {
      const r = c.stack(b, 'else', { narrow: falses });
      elseTerm = r.terminates;
    }
    for (let i = 0; i < pushed; i += 1) c.pop();
    if (hasElse) {
      if (allTerm && elseTerm) c.setInfo(b, { terminates: true });
    } else if (allTerm) {
      falses.forEach((m) => c.narrow(m));
    }
  },
  emit(e, b) {
    const arms = e.field(b, 'arms');
    for (let i = 1; i <= arms; i += 1) {
      e.line(`${i === 1 ? 'if' : 'elseif'} ${e.x(b, 'cond' + i, P.TERN)} then`, b);
      e.indent();
      e.stack(b, 'then' + i);
      e.dedent();
    }
    if (e.field(b, 'hasElse')) {
      e.line('else', b);
      e.indent();
      e.stack(b, 'else');
      e.dedent();
    }
    e.line('end', b);
  },
});

def('ctl.wait', {
  kind: 'stmt', category: 'control', label: 'wait %seconds% seconds',
  inputs: { seconds: { type: 'number', optional: true } },
  analyze(c, b) {
    const t = c.input(b, 'seconds', { type: 'number', optional: true });
    return t;
  },
  emit(e, b) {
    e.line(e.has(b, 'seconds') ? `task.wait(${e.x(b, 'seconds', P.TERN)})` : 'task.wait()', b);
  },
});

def('ctl.spawn', {
  kind: 'stmt', category: 'control', label: 'run in parallel',
  stacks: ['body'],
  analyze(c, b) {
    funcBody(c, b, 'body', [], [], { kind: 'lambda' });
  },
  emit(e, b) {
    e.line(`Rt.spawn(${e.closure(b, 'body', [])})`, b);
  },
});

def('ctl.delay', {
  kind: 'stmt', category: 'control', label: 'after %seconds% seconds',
  inputs: { seconds: { type: 'number' } },
  stacks: ['body'],
  analyze(c, b) {
    c.input(b, 'seconds', { type: 'number' });
    funcBody(c, b, 'body', [], [], { kind: 'lambda' });
  },
  emit(e, b) {
    e.line(`Rt.delay(${e.x(b, 'seconds', P.TERN)}, ${e.closure(b, 'body', [])})`, b);
  },
});

def('ctl.try', {
  kind: 'stmt', category: 'control', label: 'try / catch %error%',
  stacks: ['body', 'catch'],
  declares: 'vars[1] in catch',
  analyze(c, b) {
    c.tryEnter();
    c.stack(b, 'body', {});
    c.tryLeave();
    const v = (b.vars || [])[0];
    const declare = v && typeof v.id === 'string' ? [{ entry: v, type: STR, kind: 'param' }] : [];
    c.stack(b, 'catch', { declare });
  },
  emit(e, b) {
    const ok = e.temp('ok');
    const err = e.temp('err');
    e.line('do', b);
    e.indent();
    e.line(`local ${ok}, ${err} = pcall(${e.closure(b, 'body', [])})`, b);
    e.line(`if not ${ok} then`, b);
    e.indent();
    const v = (b.vars || [])[0];
    if (v && typeof v.id === 'string') e.line(`local ${e.bind(v)} = Rt.errmsg(${err})`, b);
    e.stack(b, 'catch');
    e.dedent();
    e.line('end', b);
    e.dedent();
    e.line('end', b);
  },
});

def('ctl.error', {
  kind: 'cap', category: 'control', label: 'raise error %message%',
  inputs: { message: { type: 'string', coerce: true } },
  analyze(c, b) {
    c.input(b, 'message', { coerce: true });
  },
  emit(e, b) {
    e.line(`error(${e.str(b, 'message', P.TERN)}, 0)`, b);
  },
});

def('ctl.return', {
  kind: 'cap', category: 'control', label: 'return',
  dynamic: 'r1..rN from the returns of the enclosing function, lambda or handler',
  analyze(c, b) {
    const f = c.frame;
    if (f.tries.length > 0) c.report('E3006', b, null, { what: 'return' });
    const rets = f.returns || [];
    rets.forEach((rt, i) => {
      const slot = 'r' + (i + 1);
      if (c.has(b, slot)) {
        c.input(b, slot, { type: rt, code: 'E2005', label: `Return value ${i + 1}` });
      } else {
        c.input(b, slot, { optional: true });
        if (!rt.opt && rt.k !== 'any' && rt.k !== 'nil') {
          c.report('E2005', b, slot, { message: `Return value ${i + 1} of type ${T.fmt(rt)} is missing.` });
        }
      }
    });
    c.setInfo(b, { count: rets.length });
  },
  emit(e, b) {
    const count = e.info(b).count || 0;
    const vals = [];
    for (let i = 1; i <= count; i += 1) vals.push(e.has(b, 'r' + i) ? e.x(b, 'r' + i, P.TERN) : 'nil');
    while (vals.length > 0 && vals[vals.length - 1] === 'nil') vals.pop();
    e.line(vals.length > 0 ? `return ${vals.join(', ')}` : 'return', b);
  },
});

def('ctl.break', {
  kind: 'cap', category: 'control', label: 'break',
  analyze(c, b) {
    c.checkLoopExit(b, 'break');
  },
  emit(e, b) {
    e.loopBreak(b);
  },
});

def('ctl.continue', {
  kind: 'cap', category: 'control', label: 'continue',
  analyze(c, b) {
    c.checkLoopExit(b, 'continue');
  },
  emit(e, b) {
    e.loopContinue(b);
  },
});

def('ctl.stop', {
  kind: 'stmt', category: 'control', label: 'stop program',
  analyze() {},
  emit(e, b) {
    e.line('Rt.stop()', b);
  },
});

def('meta.comment', {
  kind: 'stmt', category: 'meta', label: 'note %text%',
  fields: { text: Fd.str({ default: '' }) },
  analyze() {},
  emit() {},
});

def('loop.repeat', {
  kind: 'stmt', category: 'loop', label: 'repeat %count% times',
  inputs: { count: { type: 'number' } },
  stacks: ['body'],
  analyze(c, b) {
    c.input(b, 'count', { type: 'number' });
    c.stack(b, 'body', { loop: true });
  },
  emit(e, b) {
    e.line(`for _ = 1, ${e.x(b, 'count', P.TERN)} do`, b);
    e.indent();
    e.loopBody(b, 'body', { guard: true });
    e.dedent();
    e.line('end', b);
  },
});

def('loop.while', {
  kind: 'stmt', category: 'loop', label: 'while %cond%',
  inputs: { cond: { type: 'any' } },
  stacks: ['body'],
  analyze(c, b) {
    const ct = c.input(b, 'cond', {});
    conditionWarn(c, b, 'cond', ct);
    const facts = c.facts(c.arg(b, 'cond'));
    c.stack(b, 'body', { loop: true, narrow: [facts.t] });
  },
  emit(e, b) {
    e.line(`while ${e.x(b, 'cond', P.TERN)} do`, b);
    e.indent();
    e.loopBody(b, 'body', { guard: true });
    e.dedent();
    e.line('end', b);
  },
});

def('loop.until', {
  kind: 'stmt', category: 'loop', label: 'repeat until %cond%',
  inputs: { cond: { type: 'any' } },
  stacks: ['body'],
  analyze(c, b) {
    c.stack(b, 'body', { loop: true });
    const ct = c.input(b, 'cond', {});
    conditionWarn(c, b, 'cond', ct);
  },
  emit(e, b) {
    e.line('repeat', b);
    e.indent();
    e.loopBody(b, 'body', { guard: true });
    e.dedent();
    e.line(`until ${e.x(b, 'cond', P.TERN)}`, b);
  },
});

def('loop.forever', {
  kind: 'stmt', category: 'loop', label: 'forever',
  stacks: ['body'],
  analyze(c, b) {
    c.stack(b, 'body', { loop: true });
  },
  emit(e, b) {
    e.line('while true do', b);
    e.indent();
    e.loopBody(b, 'body', { guard: true });
    e.dedent();
    e.line('end', b);
  },
});

function loopVars(c, b, count, label) {
  const vars = b.vars || [];
  const ok = vars.length >= count && vars.slice(0, count).every((v) => v && typeof v.id === 'string');
  if (!ok) c.report('E1005', b, null, { message: `This loop requires ${count === 1 ? 'one variable' : 'two variables'} (${label}).` });
  return ok ? vars : null;
}

def('loop.range', {
  kind: 'stmt', category: 'loop', label: 'for %var% from %from% to %to% step %step%',
  inputs: { from: { type: 'number' }, to: { type: 'number' }, step: { type: 'number', optional: true } },
  stacks: ['body'],
  declares: 'vars[1] in body',
  analyze(c, b) {
    c.input(b, 'from', { type: 'number' });
    c.input(b, 'to', { type: 'number' });
    c.input(b, 'step', { type: 'number', optional: true });
    const vars = loopVars(c, b, 1, 'counter');
    c.stack(b, 'body', { loop: true, declare: vars ? [{ entry: vars[0], type: NUM, kind: 'loop' }] : [] });
  },
  emit(e, b) {
    const name = e.bind(b.vars[0]);
    const step = e.has(b, 'step') ? `, ${e.x(b, 'step', P.TERN)}` : '';
    e.line(`for ${name} = ${e.x(b, 'from', P.TERN)}, ${e.x(b, 'to', P.TERN)}${step} do`, b);
    e.indent();
    e.loopBody(b, 'body', { guard: true });
    e.dedent();
    e.line('end', b);
  },
});

def('loop.each', {
  kind: 'stmt', category: 'loop', label: 'for each %index%, %value% in %list%',
  inputs: { list: { type: 'list<any>' } },
  stacks: ['body'],
  declares: 'vars[1..2] in body',
  analyze(c, b) {
    const lt = nullableCheck(c, b, 'list', c.input(b, 'list', { type: T.list(ANY) }));
    const el = lt && lt.k === 'list' ? lt.el : ANY;
    const vars = loopVars(c, b, 2, 'index and value');
    c.stack(b, 'body', {
      loop: true,
      declare: vars ? [{ entry: vars[0], type: NUM, kind: 'loop' }, { entry: vars[1], type: el, kind: 'loop' }] : [],
    });
  },
  emit(e, b) {
    const idx = e.bind(b.vars[0]);
    const val = e.bind(b.vars[1]);
    e.line(`for ${idx}, ${val} in ipairs(${e.x(b, 'list', P.TERN)}) do`, b);
    e.indent();
    e.loopBody(b, 'body', { guard: false });
    e.dedent();
    e.line('end', b);
  },
});

def('loop.pairs', {
  kind: 'stmt', category: 'loop', label: 'for each %key%, %value% in %dict%',
  inputs: { dict: { type: 'dict<any,any>' } },
  stacks: ['body'],
  declares: 'vars[1..2] in body',
  analyze(c, b) {
    const dt = nullableCheck(c, b, 'dict', c.input(b, 'dict', { type: T.dict(ANY, ANY) }));
    const kt = dt && dt.k === 'dict' ? dt.key : ANY;
    const vt = dt && dt.k === 'dict' ? dt.val : ANY;
    const vars = loopVars(c, b, 2, 'key and value');
    c.stack(b, 'body', {
      loop: true,
      declare: vars ? [{ entry: vars[0], type: kt, kind: 'loop' }, { entry: vars[1], type: vt, kind: 'loop' }] : [],
    });
  },
  emit(e, b) {
    const key = e.bind(b.vars[0]);
    const val = e.bind(b.vars[1]);
    e.line(`for ${key}, ${val} in pairs(${e.x(b, 'dict', P.TERN)}) do`, b);
    e.indent();
    e.loopBody(b, 'body', { guard: false });
    e.dedent();
    e.line('end', b);
  },
});

function fnArgs(c, b, params) {
  params.forEach((p) => {
    if (c.has(b, p.id)) {
      c.input(b, p.id, { type: p.type, label: `Argument '${p.name}'` });
    } else {
      c.input(b, p.id, { optional: true });
      if (!p.type.opt && p.type.k !== 'any') c.report('E1002', b, p.id, { slot: p.name });
    }
  });
}

function argList(e, b, params, keyOf) {
  const out = [];
  params.forEach((p) => {
    const key = keyOf(p);
    out.push(e.has(b, key) ? e.x(b, key, P.TERN) : 'nil');
  });
  while (out.length > 0 && out[out.length - 1] === 'nil') out.pop();
  return out;
}

function callFunction(c, b) {
  const info = c.fnLookup(b, c.field(b, 'fn'));
  if (!info) {
    c.looseArgs(b);
    return null;
  }
  fnArgs(c, b, info.params);
  return info;
}

function emitFnCall(e, b) {
  const info = e.fn(e.field(b, 'fn'));
  const args = argList(e, b, info.params, (p) => p.id);
  return `${info.ref}(${args.join(', ')})`;
}

def('fn.define', {
  kind: 'hat', category: 'function', label: 'define %name%',
  fields: { name: Fd.str({ minLength: 1 }), returns: Fd.types() },
  stacks: ['body'],
  declares: 'vars as parameters',
  analyze(c, b) {
    const info = c.hatFunction(b);
    funcBody(c, b, 'body', b.vars, info.returns, { kind: 'fn', name: info.name });
  },
  emitHat(e, b) {
    e.line(`${e.fn(b.id).ref} = ${e.closure(b, 'body', b.vars)}`, b);
  },
});

def('fn.call', {
  kind: 'expr', category: 'function', label: 'call %fn%',
  fields: { fn: Fd.id() },
  dynamic: 'one input per parameter id of the referenced function',
  analyze(c, b) {
    const info = callFunction(c, b);
    if (!info) return ANY;
    if (info.returns.length === 0) {
      c.report('E2001', b, null, { message: `Function '${info.name}' does not return a value and cannot be used as an expression.` });
      return ANY;
    }
    return info.returns[0];
  },
  emit(e, b) {
    const info = e.fn(e.field(b, 'fn'));
    const text = emitFnCall(e, b);
    return X(info.returns.length === 1 ? text : `(${text})`);
  },
});

def('fn.callStmt', {
  kind: 'stmt', category: 'function', label: 'call %fn%',
  fields: { fn: Fd.id() },
  dynamic: 'one input per parameter id of the referenced function',
  analyze(c, b) {
    callFunction(c, b);
  },
  emit(e, b) {
    e.stmtLine(emitFnCall(e, b), b);
  },
});

def('fn.callInto', {
  kind: 'stmt', category: 'function', label: 'call %fn% into variables',
  fields: { fn: Fd.id() },
  dynamic: 'one input per parameter id of the referenced function',
  declares: 'vars (one per returned value)',
  analyze(c, b) {
    const info = callFunction(c, b);
    const vars = b.vars || [];
    if (info && (vars.length === 0 || vars.length > info.returns.length)) {
      c.report('E1005', b, null, {
        message: `Function '${info.name}' returns ${info.returns.length} value(s) but ${vars.length} variable(s) were declared.`,
      });
    }
    vars.forEach((v, i) => {
      if (!v || typeof v.id !== 'string') {
        c.report('E1005', b, null, { message: 'A variable entry is invalid.' });
        return;
      }
      const given = info && info.returns[i] ? info.returns[i] : ANY;
      const declared = c.declType(v, b);
      if (declared && !T.assignable(given, declared).ok) {
        c.report('E2001', b, null, { message: `Variable '${v.name}' is declared as ${T.fmt(declared)} but receives ${T.fmt(given)}.` });
      }
      c.declare(v, { type: declared || given, kind: 'local', block: b, trackUnused: true });
    });
  },
  emit(e, b) {
    const names = (b.vars || []).map((v) => e.bind(v));
    e.line(`local ${names.join(', ')} = ${emitFnCall(e, b)}`, b);
  },
});

def('fn.lambda', {
  kind: 'expr', category: 'function', label: 'function',
  fields: { returns: Fd.types() },
  stacks: ['body'],
  declares: 'vars as parameters',
  analyze(c, b) {
    const returns = c.types(c.field(b, 'returns'));
    const params = (b.vars || []).map((v) => (v && typeof v.id === 'string' ? c.declType(v, b) || ANY : ANY));
    funcBody(c, b, 'body', b.vars, returns, { kind: 'lambda' });
    return T.fn(params, returns[0] || null);
  },
  emit(e, b) {
    return X(e.closure(b, 'body', b.vars), P.LIT);
  },
});

function invokeSetup(c, b) {
  const ft = nullableCheck(c, b, 'fn', c.input(b, 'fn', { type: T.fn(null, null) }));
  const known = ft && ft.k === 'fn' && ft.params;
  const n = known ? ft.params.length : c.maxSlot(b, 'p');
  for (let i = 1; i <= n; i += 1) {
    const pt = known ? ft.params[i - 1] : ANY;
    if (c.has(b, 'p' + i)) {
      c.input(b, 'p' + i, { type: pt });
    } else {
      c.input(b, 'p' + i, { optional: true });
      if (known && !pt.opt && pt.k !== 'any') c.report('E1002', b, 'p' + i, { slot: 'p' + i });
    }
  }
  c.setInfo(b, { argc: n });
  return ft;
}

function invokeText(e, b) {
  const n = e.info(b).argc || 0;
  const out = [];
  for (let i = 1; i <= n; i += 1) out.push(e.has(b, 'p' + i) ? e.x(b, 'p' + i, P.TERN) : 'nil');
  while (out.length > 0 && out[out.length - 1] === 'nil') out.pop();
  return `${e.x(b, 'fn', P.PRE)}(${out.join(', ')})`;
}

def('fn.invoke', {
  kind: 'expr', category: 'function', label: 'invoke %fn%',
  inputs: { fn: { type: 'fn' } },
  dynamic: 'p1..pN from the type of the function value',
  analyze(c, b) {
    const ft = invokeSetup(c, b);
    return ft && ft.k === 'fn' && ft.ret ? ft.ret : ANY;
  },
  emit(e, b) {
    const ft = e.info(b).slots.fn;
    const text = invokeText(e, b);
    return X(ft && ft.k === 'fn' && ft.ret ? text : `(${text})`);
  },
});

def('fn.invokeStmt', {
  kind: 'stmt', category: 'function', label: 'invoke %fn%',
  inputs: { fn: { type: 'fn' } },
  dynamic: 'p1..pN from the type of the function value',
  analyze(c, b) {
    invokeSetup(c, b);
  },
  emit(e, b) {
    e.stmtLine(invokeText(e, b), b);
  },
});

function resolveSignal(c, b) {
  const name = c.field(b, 'signal');
  const target = c.input(b, 'target', { type: T.instance(null) });
  const tt = nullableCheck(c, b, 'target', target);
  const out = { name, params: [] };
  if (!tt || tt.k === 'any') {
    return out;
  }
  if (tt.k !== 'instance') {
    c.report('E2001', b, 'target', { message: `A signal target must be an Instance but got ${T.fmt(tt)}.` });
    return out;
  }
  const m = Reflection.member(tt, name, 'event');
  if (m.status === 'missing') {
    c.report('E2007', b, 'signal', { member: name, type: T.fmt(tt) });
  } else if (m.status === 'ok') {
    out.params = m.info.params.map((p) => p.type);
  } else {
    if (m.status === 'union') out.params = m.info.params.map((p) => p.type);
    c.unverified(b, 'signal');
  }
  return out;
}

function handlerVars(c, b, sig, kind) {
  const vars = b.vars || [];
  if (vars.length > sig.params.length && sig.params.length > 0) {
    c.report('E1003', b, null, { slot: `parameter ${vars.length}`, op: b.op });
  }
  return funcBody(c, b, 'body', vars, [], { kind, paramTypes: sig.params, warnEmpty: kind === 'handler' });
}

const SIGNAL_FIELDS = { signal: Fd.str({ minLength: 1 }), reentry: Fd.enum(['allow', 'ignore'], 'allow') };

function connectText(e, b) {
  const name = quote(e.field(b, 'signal'));
  const bid = e.bid(b);
  const sig = `Rt.sig(${e.x(b, 'target', P.TERN)}, ${name}, ${bid})`;
  return `Rt.connect(${sig}, ${e.closure(b, 'body', b.vars)}, ${bid}, ${name}, ${quote(e.field(b, 'reentry'))})`;
}

def('event.start', {
  kind: 'hat', category: 'event', label: 'when the program starts',
  stacks: ['body'],
  analyze(c, b) {
    funcBody(c, b, 'body', [], [], { kind: 'handler', warnEmpty: true });
  },
  emitHat(e, b) {
    e.line(`Rt.onStart(${e.closure(b, 'body', [])}, ${e.bid(b)})`, b);
  },
});

def('event.stop', {
  kind: 'hat', category: 'event', label: 'when the program stops',
  stacks: ['body'],
  analyze(c, b) {
    funcBody(c, b, 'body', [], [], { kind: 'handler', warnEmpty: true });
  },
  emitHat(e, b) {
    e.line(`Rt.onStop(${e.closure(b, 'body', [])}, ${e.bid(b)})`, b);
  },
});

def('event.signal', {
  kind: 'hat', category: 'event', label: 'when %target%.%signal% fires',
  fields: SIGNAL_FIELDS,
  inputs: { target: { type: 'Instance' } },
  stacks: ['body'],
  declares: 'vars as signal parameters',
  analyze(c, b) {
    handlerVars(c, b, resolveSignal(c, b), 'handler');
  },
  emitHat(e, b) {
    e.line(connectText(e, b), b);
  },
});

def('event.custom', {
  kind: 'hat', category: 'event', label: 'when event %event% is fired',
  fields: { event: Fd.id() },
  stacks: ['body'],
  declares: 'vars as event parameters',
  analyze(c, b) {
    const ev = c.eventLookup(b, c.field(b, 'event'));
    handlerVars(c, b, { name: null, params: ev ? ev.params.map((p) => p.type) : [] }, 'handler');
  },
  emitHat(e, b) {
    e.line(`Rt.on(${quote(e.field(b, 'event'))}, ${e.closure(b, 'body', b.vars)}, ${e.bid(b)})`, b);
  },
});

def('event.every', {
  kind: 'hat', category: 'event', label: 'every %seconds% seconds',
  inputs: { seconds: { type: 'number' } },
  stacks: ['body'],
  analyze(c, b) {
    c.input(b, 'seconds', { type: 'number' });
    funcBody(c, b, 'body', [], [], { kind: 'handler', warnEmpty: true });
  },
  emitHat(e, b) {
    e.line(`Rt.every(${e.x(b, 'seconds', P.TERN)}, ${e.closure(b, 'body', [])}, ${e.bid(b)})`, b);
  },
});

def('event.fire', {
  kind: 'stmt', category: 'event', label: 'fire event %event%',
  fields: { event: Fd.id() },
  dynamic: 'one input per parameter id of the custom event',
  analyze(c, b) {
    const ev = c.eventLookup(b, c.field(b, 'event'));
    if (!ev) {
      c.looseArgs(b);
      return;
    }
    fnArgs(c, b, ev.params);
  },
  emit(e, b) {
    const ev = e.event(e.field(b, 'event'));
    const args = argList(e, b, ev.params, (p) => p.id);
    e.line(`Rt.fire(${[quote(ev.id)].concat(args).join(', ')})`, b);
  },
});

def('signal.on', {
  kind: 'stmt', category: 'signal', label: 'connect %target%.%signal%',
  fields: SIGNAL_FIELDS,
  inputs: { target: { type: 'Instance' } },
  stacks: ['body'],
  declares: 'vars as signal parameters',
  analyze(c, b) {
    handlerVars(c, b, resolveSignal(c, b), 'lambda');
  },
  emit(e, b) {
    e.line(connectText(e, b), b);
  },
});

def('signal.connect', {
  kind: 'expr', category: 'signal', label: 'connect %target%.%signal% and keep the connection',
  fields: SIGNAL_FIELDS,
  inputs: { target: { type: 'Instance' } },
  stacks: ['body'],
  declares: 'vars as signal parameters',
  analyze(c, b) {
    handlerVars(c, b, resolveSignal(c, b), 'lambda');
    return T.CONN;
  },
  emit(e, b) {
    return X(connectText(e, b));
  },
});

def('signal.disconnect', {
  kind: 'stmt', category: 'signal', label: 'disconnect %connection%',
  inputs: { connection: { type: 'connection?' } },
  analyze(c, b) {
    c.input(b, 'connection', { type: T.opt(T.CONN) });
  },
  emit(e, b) {
    e.line(`Rt.disconnect(${e.x(b, 'connection', P.TERN)})`, b);
  },
});

def('signal.wait', {
  kind: 'expr', category: 'signal', label: 'wait for %target%.%signal%',
  fields: { signal: Fd.str({ minLength: 1 }) },
  inputs: { target: { type: 'Instance' } },
  analyze(c, b) {
    resolveSignal(c, b);
    return ANY;
  },
  emit(e, b) {
    const sig = `Rt.sig(${e.x(b, 'target', P.TERN)}, ${quote(e.field(b, 'signal'))}, ${e.bid(b)})`;
    return X(`Rt.await(${sig})`);
  },
});

function classCheck(c, b, slot, cls, what) {
  if (typeof cls !== 'string' || cls.length === 0) return;
  if (Reflection.classKnown(cls) === false) {
    c.report('E1005', b, slot, { message: `Class '${cls}' does not exist.` });
  } else if (what === 'create' && Reflection.creatable(cls) === false) {
    c.report('E1005', b, slot, { message: `Class '${cls}' cannot be created with Instance.new.` });
  }
}

def('ref.self', {
  kind: 'expr', category: 'object', label: 'this object',
  fields: { class: Fd.str({ optional: true }) },
  analyze(c, b) {
    const cls = c.field(b, 'class');
    if (cls) classCheck(c, b, 'class', cls, 'any');
    return T.instance(cls || null);
  },
  emit(e, b) {
    const cls = e.field(b, 'class');
    if (cls && e.debug) return X(`Rt.cast(Rt.self(), ${quote(cls)}, ${e.bid(b)})`);
    return X('Rt.self()');
  },
});

def('ref.object', {
  kind: 'expr', category: 'object', label: 'object %path%',
  fields: { id: Fd.str({ minLength: 1 }), path: Fd.str({ default: '' }), class: Fd.str({ optional: true }) },
  analyze(c, b) {
    const cls = c.field(b, 'class');
    if (cls) classCheck(c, b, 'class', cls, 'any');
    return T.instance(cls || null);
  },
  emit(e, b) {
    const cls = e.field(b, 'class');
    const extra = cls && e.debug ? `, ${quote(cls)}` : '';
    return X(`Rt.obj(${quote(e.field(b, 'id'))}, ${quote(e.field(b, 'path'))}, ${e.bid(b)}${extra})`);
  },
});

def('ref.service', {
  kind: 'expr', category: 'object', label: 'service %service%',
  fields: { service: Fd.str({ minLength: 1 }) },
  analyze(c, b) {
    const name = c.field(b, 'service');
    if (c.serviceBlocked(name)) {
      c.report('E2008', b, 'service', { service: name });
    } else if (Reflection.isService(name) === false) {
      c.report('E1005', b, 'service', { message: `'${name}' is not a valid Roblox service.` });
    }
    return T.instance(name);
  },
  emit(e, b) {
    return X(`Rt.service(${quote(e.field(b, 'service'))}, ${e.bid(b)})`);
  },
});

const CHILD_METHOD = { find: 'FindFirstChild', wait: 'WaitForChild', findDescendant: 'FindFirstDescendant' };

def('ref.child', {
  kind: 'expr', category: 'object', label: '%mode% child %name% of %parent%',
  fields: { mode: Fd.enum(['find', 'wait', 'findDescendant'], 'find') },
  inputs: { parent: { type: 'Instance' }, name: { type: 'string' } },
  analyze(c, b) {
    const pt = nullableCheck(c, b, 'parent', c.input(b, 'parent', { type: T.opt(T.instance(null)) }));
    c.input(b, 'name', { type: 'string' });
    c.setInfo(b, { mayNil: mayBeNil(c.typeOfSlot(b, 'parent')) });
    if (pt && pt.k === 'any') return T.opt(T.instance(null));
    return T.opt(T.instance(null));
  },
  emit(e, b) {
    const method = CHILD_METHOD[e.field(b, 'mode')];
    const extra = e.field(b, 'mode') === 'wait' ? ', 5' : '';
    const name = e.x(b, 'name', P.TERN);
    if (e.debug && e.info(b).mayNil) return X(`Rt.call(${e.x(b, 'parent', P.TERN)}, ${quote(method)}, ${e.bid(b)}, ${name}${extra})`);
    return X(`${e.x(b, 'parent', P.PRE)}:${method}(${name}${extra})`);
  },
});

def('inst.new', {
  kind: 'expr', category: 'object', label: 'new %class%',
  fields: { class: Fd.str({ minLength: 1 }) },
  inputs: { parent: { type: 'Instance?', optional: true } },
  analyze(c, b) {
    const cls = c.field(b, 'class');
    classCheck(c, b, 'class', cls, 'create');
    c.input(b, 'parent', { type: T.opt(T.instance(null)), optional: true });
    return T.instance(cls);
  },
  emit(e, b) {
    const parent = e.has(b, 'parent') ? e.x(b, 'parent', P.TERN) : 'nil';
    return X(`Rt.create(${quote(e.field(b, 'class'))}, ${parent}, ${e.bid(b)})`);
  },
});

def('inst.cast', {
  kind: 'expr', category: 'object', label: '%value% as %class%',
  fields: { class: Fd.str({ minLength: 1 }) },
  inputs: { value: { type: 'Instance?' } },
  analyze(c, b) {
    const cls = c.field(b, 'class');
    classCheck(c, b, 'class', cls, 'any');
    c.input(b, 'value', { type: T.opt(T.instance(null)) });
    return T.instance(cls);
  },
  emit(e, b) {
    return X(`Rt.cast(${e.x(b, 'value', P.TERN)}, ${quote(e.field(b, 'class'))}, ${e.bid(b)})`);
  },
});

function memberOf(c, b, name, kind) {
  const raw = c.input(b, 'target', {});
  const t = nullableCheck(c, b, 'target', raw);
  const res = { target: t, info: null, status: 'unknown', type: ANY };
  c.setInfo(b, { mayNil: mayBeNil(raw) });
  if (t.k === 'any') return res;
  if (t.k !== 'instance' && t.k !== 'value' && t.k !== 'connection') {
    c.report('E2001', b, 'target', { message: `A value of type ${T.fmt(t)} has no members. Use an Instance or a value type.` });
    res.status = 'invalid';
    return res;
  }
  const m = Reflection.member(t, name, kind);
  res.status = m.status;
  if (m.status === 'missing') {
    c.report('E2007', b, null, { member: name, type: T.fmt(t) });
  } else if (m.status === 'ok' || m.status === 'union') {
    res.info = m.info;
    if (m.status === 'union') c.report('W2003', b, 'target', {});
  } else {
    c.unverified(b, 'target');
  }
  return res;
}

function propAccess(e, b, name) {
  return memberText(e.x(b, 'target', P.PRE), name);
}

def('prop.get', {
  kind: 'expr', category: 'member', label: '%target%.%prop%',
  fields: { prop: Fd.str({ minLength: 1 }) },
  inputs: { target: { type: 'any' } },
  analyze(c, b) {
    const m = memberOf(c, b, c.field(b, 'prop'), 'prop');
    return m.info ? m.info.type : ANY;
  },
  emit(e, b) {
    const name = e.field(b, 'prop');
    if (e.debug && e.info(b).mayNil) return X(`Rt.get(${e.x(b, 'target', P.TERN)}, ${quote(name)}, ${e.bid(b)})`);
    return X(propAccess(e, b, name));
  },
});

def('prop.set', {
  kind: 'stmt', category: 'member', label: 'set %target%.%prop% to %value%',
  fields: { prop: Fd.str({ minLength: 1 }) },
  inputs: { target: { type: 'any' }, value: { type: 'any' } },
  analyze(c, b) {
    const name = c.field(b, 'prop');
    const m = memberOf(c, b, name, 'prop');
    if (m.info && m.info.readOnly) c.report('E2009', b, 'prop', { member: name });
    c.input(b, 'value', m.info ? { type: m.info.type } : {});
  },
  emit(e, b) {
    const name = e.field(b, 'prop');
    if (e.debug && e.info(b).mayNil) {
      e.line(`Rt.set(${e.x(b, 'target', P.TERN)}, ${quote(name)}, ${e.x(b, 'value', P.TERN)}, ${e.bid(b)})`, b);
      return;
    }
    e.stmtLine(`${propAccess(e, b, name)} = ${e.x(b, 'value', P.TERN)}`, b);
  },
});

def('prop.change', {
  kind: 'stmt', category: 'member', label: 'change %target%.%prop% by %value%',
  fields: { prop: Fd.str({ minLength: 1 }), op: Fd.enum(['add', 'sub', 'mul', 'div'], 'add') },
  inputs: { target: { type: 'any' }, value: { type: 'any' } },
  analyze(c, b) {
    const name = c.field(b, 'prop');
    const m = memberOf(c, b, name, 'prop');
    if (m.info && m.info.readOnly) c.report('E2009', b, 'prop', { member: name });
    const tv = c.input(b, 'value', {});
    const cur = m.info ? m.info.type : ANY;
    const r = arithResult(c, b, c.field(b, 'op'), cur, tv);
    if (m.info && !T.assignable(r, m.info.type).ok) {
      c.report('E2001', b, 'value', { expected: T.fmt(m.info.type), actual: T.fmt(r) });
    }
  },
  emit(e, b) {
    const name = e.field(b, 'prop');
    const op = SYMS[e.field(b, 'op')];
    const target = e.x(b, 'target', P.PRE);
    const value = e.x(b, 'value', op.prec + 1);
    if (isSimpleRef(target)) {
      const access = memberText(target, name);
      e.line(`${access} = ${access} ${op.sym} ${value}`, b);
      return;
    }
    const tmp = e.temp('obj');
    const access = memberText(tmp, name);
    e.line('do', b);
    e.indent();
    e.line(`local ${tmp} = ${e.x(b, 'target', P.TERN)}`, b);
    e.line(`${access} = ${access} ${op.sym} ${value}`, b);
    e.dedent();
    e.line('end', b);
  },
});

function attrTarget(c, b) {
  const raw = c.input(b, 'target', { type: T.instance(null) });
  nullableCheck(c, b, 'target', raw);
  c.setInfo(b, { mayNil: mayBeNil(raw) });
}

def('attr.get', {
  kind: 'expr', category: 'member', label: '%target% attribute %name%',
  fields: { name: Fd.str({ minLength: 1 }) },
  inputs: { target: { type: 'Instance' } },
  analyze(c, b) {
    attrTarget(c, b);
    return ANY;
  },
  emit(e, b) {
    const name = quote(e.field(b, 'name'));
    if (e.debug && e.info(b).mayNil) return X(`Rt.call(${e.x(b, 'target', P.TERN)}, "GetAttribute", ${e.bid(b)}, ${name})`);
    return X(`${e.x(b, 'target', P.PRE)}:GetAttribute(${name})`);
  },
});

def('attr.set', {
  kind: 'stmt', category: 'member', label: 'set %target% attribute %name% to %value%',
  fields: { name: Fd.str({ minLength: 1 }) },
  inputs: { target: { type: 'Instance' }, value: { type: 'any' } },
  analyze(c, b) {
    attrTarget(c, b);
    const t = c.input(b, 'value', {});
    const k = t.k;
    if (k === 'list' || k === 'dict' || k === 'instance' || k === 'fn' || k === 'signal' || k === 'connection' || k === 'enum') {
      c.report('E2001', b, 'value', { message: `Attributes cannot store a value of type ${T.fmt(t)}.` });
    }
  },
  emit(e, b) {
    const name = quote(e.field(b, 'name'));
    const value = e.x(b, 'value', P.TERN);
    if (e.debug && e.info(b).mayNil) {
      e.line(`Rt.call(${e.x(b, 'target', P.TERN)}, "SetAttribute", ${e.bid(b)}, ${name}, ${value})`, b);
      return;
    }
    e.stmtLine(`${e.x(b, 'target', P.PRE)}:SetAttribute(${name}, ${value})`, b);
  },
});

def('enum.item', {
  kind: 'expr', category: 'object', label: '%enum%.%item%',
  fields: { enum: Fd.str({ minLength: 1 }), item: Fd.str({ minLength: 1 }) },
  analyze(c, b) {
    const en = c.field(b, 'enum');
    const items = Reflection.enumItems(en);
    if (Reflection.loaded) {
      if (!items) c.report('E1005', b, 'enum', { message: `Enum '${en}' does not exist.` });
      else if (!items.has(c.field(b, 'item'))) c.report('E1005', b, 'item', { message: `'${c.field(b, 'item')}' is not an item of Enum.${en}.` });
    } else {
      c.unverified(b, 'enum');
    }
    return T.enumOf(en);
  },
  emit(e, b) {
    return X(memberText(memberText('Enum', e.field(b, 'enum')), e.field(b, 'item')));
  },
});

const FORBIDDEN_METHODS = new Set(['GetService', 'FindService', 'LoadString', 'loadstring']);

function methodSetup(c, b) {
  const name = c.field(b, 'method');
  const raw = c.input(b, 'target', {});
  const t = nullableCheck(c, b, 'target', raw);
  const out = { sig: null, loose: false, n: 0 };
  c.setInfo(b, { mayNil: mayBeNil(raw) });
  if (!isIdent(name)) {
    c.report('E1005', b, 'method', { message: `'${name}' is not a valid method name.` });
    c.looseArgs(b, ['target']);
    return out;
  }
  if (FORBIDDEN_METHODS.has(name)) {
    c.report('E1005', b, 'method', { message: `Method '${name}' is not available. Use the Service block to access services.` });
    c.looseArgs(b, ['target']);
    return out;
  }
  if (t.k === 'any') {
    out.loose = true;
  } else if (t.k !== 'instance' && t.k !== 'value' && t.k !== 'connection') {
    c.report('E2001', b, 'target', { message: `A value of type ${T.fmt(t)} has no methods. Use an Instance or a value type.` });
    c.looseArgs(b, ['target']);
    return out;
  } else {
    const m = Reflection.member(t, name, 'method');
    if (m.status === 'missing') {
      c.report('E2007', b, 'method', { member: name, type: T.fmt(t) });
      c.looseArgs(b, ['target']);
      return out;
    }
    if (m.status === 'ok') {
      out.sig = m.info;
    } else {
      out.loose = true;
      if (m.status === 'union') c.report('W2003', b, 'target', {});
      else c.unverified(b, 'target');
    }
  }
  if (out.loose || !out.sig) {
    out.n = c.maxSlot(b, 'p');
    for (let i = 1; i <= out.n; i += 1) c.input(b, 'p' + i, { optional: true });
    out.sig = { params: [], returns: [ANY], yields: false };
    c.setInfo(b, { argc: out.n, returnsCount: 2 });
    return out;
  }
  const params = out.sig.params;
  const last = params.length > 0 ? params[params.length - 1] : null;
  const variadic = last && last.variadic ? last : null;
  let n = params.length;
  if (variadic) n = Math.max(params.length - 1, Math.min(c.maxSlot(b, 'p'), L.LIMITS.argc));
  for (let i = 1; i <= n; i += 1) {
    const p = i <= params.length ? params[i - 1] : variadic;
    if (c.has(b, 'p' + i)) {
      c.input(b, 'p' + i, { type: p.type, label: `Argument '${p.name}'` });
    } else {
      c.input(b, 'p' + i, { optional: true });
      if (!p.optional && !p.variadic) c.report('E1002', b, 'p' + i, { slot: p.name });
    }
  }
  out.n = n;
  c.setInfo(b, { argc: n, returnsCount: out.sig.returns.length });
  return out;
}

function methodReturn(c, b, setup, name) {
  const rets = setup.sig ? setup.sig.returns : [];
  let ret = rets.length > 0 ? rets[0] : null;
  const fn = LITERAL_RETURNS[name];
  const lit = c.arg(b, 'p1');
  if (fn && lit && lit.op === 'lit.string' && lit.fields && typeof lit.fields.value === 'string') {
    classCheck(c, b, 'p1', lit.fields.value, 'any');
    if (!setup.loose) ret = fn(lit.fields.value);
  }
  return ret;
}

function methodText(e, b) {
  const info = e.info(b);
  const name = e.field(b, 'method');
  const out = [];
  for (let i = 1; i <= (info.argc || 0); i += 1) out.push(e.has(b, 'p' + i) ? e.x(b, 'p' + i, P.TERN) : 'nil');
  while (out.length > 0 && out[out.length - 1] === 'nil') out.pop();
  if (e.debug && info.mayNil) return `Rt.call(${[e.x(b, 'target', P.TERN), quote(name), e.bid(b)].concat(out).join(', ')})`;
  return `${e.x(b, 'target', P.PRE)}:${name}(${out.join(', ')})`;
}

def('call.method', {
  kind: 'expr', category: 'member', label: '%target%:%method%()',
  fields: { method: Fd.str({ minLength: 1 }) },
  inputs: { target: { type: 'any' } },
  dynamic: 'p1..pN from the method signature',
  analyze(c, b) {
    const name = c.field(b, 'method');
    const s = methodSetup(c, b);
    if (!s.sig) return ANY;
    const ret = methodReturn(c, b, s, name);
    if (!ret) {
      c.report('E2001', b, null, { message: `Method '${name}' does not return a value. Use the statement block instead.` });
      return ANY;
    }
    return ret;
  },
  emit(e, b) {
    const info = e.info(b);
    const text = methodText(e, b);
    return X(info.returnsCount === 1 && !info.loose ? text : `(${text})`);
  },
});

def('call.methodStmt', {
  kind: 'stmt', category: 'member', label: '%target%:%method%()',
  fields: { method: Fd.str({ minLength: 1 }) },
  inputs: { target: { type: 'any' } },
  dynamic: 'p1..pN from the method signature',
  analyze(c, b) {
    const s = methodSetup(c, b);
    if (s.sig) methodReturn(c, b, s, c.field(b, 'method'));
  },
  emit(e, b) {
    e.stmtLine(methodText(e, b), b);
  },
});

function chooseVariant(entry, n) {
  for (const v of entry.variants) {
    const last = v.params.length > 0 ? v.params[v.params.length - 1] : null;
    const max = last && last.variadic ? Infinity : v.params.length;
    if (max >= n) return v;
  }
  return entry.variants[entry.variants.length - 1];
}

function libSetup(c, b) {
  const id = c.field(b, 'sig');
  const entry = LIB[id];
  if (!entry) {
    c.report('E1005', b, 'sig', { message: `Unknown library function '${id}'.` });
    c.looseArgs(b);
    return null;
  }
  if (entry.const) {
    c.setInfo(b, { argc: 0, isConst: true, returnsCount: 1 });
    return { entry, variant: entry.variants[0] };
  }
  const n = Math.min(c.maxSlot(b, 'p'), L.LIMITS.argc);
  const variant = chooseVariant(entry, n);
  const params = variant.params;
  const last = params.length > 0 ? params[params.length - 1] : null;
  const variadic = last && last.variadic ? last : null;
  let count = params.length;
  if (variadic) count = Math.max(params.length - 1, n);
  for (let i = 1; i <= count; i += 1) {
    const p = i <= params.length ? params[i - 1] : variadic;
    if (c.has(b, 'p' + i)) {
      c.input(b, 'p' + i, { type: p.type, label: `Argument '${p.name}'` });
    } else {
      c.input(b, 'p' + i, { optional: true });
      if (!p.optional && !p.variadic) c.report('E1002', b, 'p' + i, { slot: p.name });
    }
  }
  c.setInfo(b, { argc: count, returnsCount: variant.returns.length, returnsAny: variant.returns.some((r) => r.k === 'any') });
  return { entry, variant };
}

function libText(e, b) {
  const info = e.info(b);
  const entry = LIB[e.field(b, 'sig')];
  if (info.isConst) return entry.lua;
  const out = [];
  for (let i = 1; i <= (info.argc || 0); i += 1) out.push(e.has(b, 'p' + i) ? e.x(b, 'p' + i, P.TERN) : 'nil');
  while (out.length > 0 && out[out.length - 1] === 'nil') out.pop();
  return `${entry.lua}(${out.join(', ')})`;
}

def('call.lib', {
  kind: 'expr', category: 'library', label: '%sig%()',
  fields: { sig: Fd.str({ minLength: 1 }) },
  dynamic: 'p1..pN from the library signature',
  analyze(c, b) {
    const s = libSetup(c, b);
    if (!s) return ANY;
    if (s.variant.returns.length === 0) {
      c.report('E2001', b, null, { message: `'${s.entry.id}' does not return a value. Use the statement block instead.` });
      return ANY;
    }
    return s.variant.returns[0];
  },
  emit(e, b) {
    const info = e.info(b);
    const text = libText(e, b);
    if (info.isConst) return X(text);
    return X(info.returnsCount === 1 && !info.returnsAny ? text : `(${text})`);
  },
});

def('call.libStmt', {
  kind: 'stmt', category: 'library', label: '%sig%()',
  fields: { sig: Fd.str({ minLength: 1 }) },
  dynamic: 'p1..pN from the library signature',
  analyze(c, b) {
    const s = libSetup(c, b);
    if (s && s.entry.const) c.report('E1005', b, 'sig', { message: `'${s.entry.id}' is a constant and cannot be used as a statement.` });
  },
  emit(e, b) {
    e.stmtLine(libText(e, b), b);
  },
});

function elementTypeOf(t) {
  return t && t.k === 'list' ? t.el : ANY;
}

function listTarget(c, b, slot) {
  return nullableCheck(c, b, slot, c.input(b, slot, { type: T.list(ANY) }));
}

def('list.create', {
  kind: 'expr', category: 'collection', label: 'list',
  fields: { items: Fd.int({ default: 0, min: 0, max: 64 }), elem: Fd.type({ default: 'auto' }) },
  dynamic: 'item1..itemN from fields.items',
  analyze(c, b) {
    const n = c.field(b, 'items');
    const declared = c.declType({ type: c.field(b, 'elem') }, b);
    let el = declared;
    for (let i = 1; i <= n; i += 1) {
      const t = c.input(b, 'item' + i, declared ? { type: declared } : {});
      if (!declared) el = el ? T.join(el, t) : t;
    }
    return T.list(el && el.k !== 'nil' ? el : ANY);
  },
  emit(e, b) {
    const n = e.field(b, 'items');
    const out = [];
    for (let i = 1; i <= n; i += 1) out.push(e.x(b, 'item' + i, P.TERN));
    return X(`{${out.join(', ')}}`, P.LIT);
  },
});

def('list.get', {
  kind: 'expr', category: 'collection', label: '%list%[%index%]',
  inputs: { list: { type: 'list<any>' }, index: { type: 'number' } },
  analyze(c, b) {
    const el = elementTypeOf(listTarget(c, b, 'list'));
    c.input(b, 'index', { type: 'number' });
    return el.k === 'any' ? ANY : T.opt(el);
  },
  emit(e, b) {
    return X(`${e.x(b, 'list', P.PRE)}[${e.x(b, 'index', P.TERN)}]`);
  },
});

def('list.set', {
  kind: 'stmt', category: 'collection', label: 'set %list%[%index%] to %value%',
  inputs: { list: { type: 'list<any>' }, index: { type: 'number' }, value: { type: 'any' } },
  analyze(c, b) {
    const el = elementTypeOf(listTarget(c, b, 'list'));
    c.input(b, 'index', { type: 'number' });
    c.input(b, 'value', { type: T.opt(el) });
  },
  emit(e, b) {
    e.stmtLine(`${e.x(b, 'list', P.PRE)}[${e.x(b, 'index', P.TERN)}] = ${e.x(b, 'value', P.TERN)}`, b);
  },
});

def('list.add', {
  kind: 'stmt', category: 'collection', label: 'add %value% to %list%',
  inputs: { list: { type: 'list<any>' }, value: { type: 'any' } },
  analyze(c, b) {
    const el = elementTypeOf(listTarget(c, b, 'list'));
    c.input(b, 'value', { type: el });
  },
  emit(e, b) {
    e.line(`table.insert(${e.x(b, 'list', P.TERN)}, ${e.x(b, 'value', P.TERN)})`, b);
  },
});

def('list.insert', {
  kind: 'stmt', category: 'collection', label: 'insert %value% into %list% at %index%',
  inputs: { list: { type: 'list<any>' }, index: { type: 'number' }, value: { type: 'any' } },
  analyze(c, b) {
    const el = elementTypeOf(listTarget(c, b, 'list'));
    c.input(b, 'index', { type: 'number' });
    c.input(b, 'value', { type: el });
  },
  emit(e, b) {
    e.line(`table.insert(${e.x(b, 'list', P.TERN)}, ${e.x(b, 'index', P.TERN)}, ${e.x(b, 'value', P.TERN)})`, b);
  },
});

def('list.removeAt', {
  kind: 'stmt', category: 'collection', label: 'remove item %index% from %list%',
  inputs: { list: { type: 'list<any>' }, index: { type: 'number' } },
  analyze(c, b) {
    listTarget(c, b, 'list');
    c.input(b, 'index', { type: 'number' });
  },
  emit(e, b) {
    e.line(`table.remove(${e.x(b, 'list', P.TERN)}, ${e.x(b, 'index', P.TERN)})`, b);
  },
});

function dictTarget(c, b, slot) {
  return nullableCheck(c, b, slot, c.input(b, slot, { type: T.dict(ANY, ANY) }));
}

def('dict.create', {
  kind: 'expr', category: 'collection', label: 'dictionary',
  fields: {
    pairs: Fd.int({ default: 0, min: 0, max: 64 }),
    keyType: Fd.type({ default: 'auto' }),
    valueType: Fd.type({ default: 'auto' }),
  },
  dynamic: 'key1..keyN and value1..valueN from fields.pairs',
  analyze(c, b) {
    const n = c.field(b, 'pairs');
    const dk = c.declType({ type: c.field(b, 'keyType') }, b);
    const dv = c.declType({ type: c.field(b, 'valueType') }, b);
    let kt = dk;
    let vt = dv;
    for (let i = 1; i <= n; i += 1) {
      const k = c.input(b, 'key' + i, dk ? { type: dk } : {});
      const v = c.input(b, 'value' + i, dv ? { type: dv } : {});
      if (!dk) kt = kt ? T.join(kt, k) : k;
      if (!dv) vt = vt ? T.join(vt, v) : v;
    }
    return T.dict(kt && kt.k !== 'nil' ? kt : STR, vt && vt.k !== 'nil' ? vt : ANY);
  },
  emit(e, b) {
    const n = e.field(b, 'pairs');
    const out = [];
    for (let i = 1; i <= n; i += 1) out.push(`[${e.x(b, 'key' + i, P.TERN)}] = ${e.x(b, 'value' + i, P.TERN)}`);
    return X(`{${out.join(', ')}}`, P.LIT);
  },
});

def('dict.get', {
  kind: 'expr', category: 'collection', label: '%dict%[%key%]',
  inputs: { dict: { type: 'dict<any,any>' }, key: { type: 'any' } },
  analyze(c, b) {
    const dt = dictTarget(c, b, 'dict');
    c.input(b, 'key', { type: dt.k === 'dict' ? dt.key : ANY });
    if (dt.k !== 'dict' || dt.val.k === 'any') return ANY;
    return T.opt(dt.val);
  },
  emit(e, b) {
    return X(`${e.x(b, 'dict', P.PRE)}[${e.x(b, 'key', P.TERN)}]`);
  },
});

def('dict.set', {
  kind: 'stmt', category: 'collection', label: 'set %dict%[%key%] to %value%',
  inputs: { dict: { type: 'dict<any,any>' }, key: { type: 'any' }, value: { type: 'any' } },
  analyze(c, b) {
    const dt = dictTarget(c, b, 'dict');
    c.input(b, 'key', { type: dt.k === 'dict' ? dt.key : ANY });
    c.input(b, 'value', { type: dt.k === 'dict' ? T.opt(dt.val) : ANY });
  },
  emit(e, b) {
    e.stmtLine(`${e.x(b, 'dict', P.PRE)}[${e.x(b, 'key', P.TERN)}] = ${e.x(b, 'value', P.TERN)}`, b);
  },
});

function getDef(op) {
  if (DEFS.has(op)) return DEFS.get(op);
  const alias = ALIASES.get(op);
  return alias ? DEFS.get(alias) : null;
}

function describeField(spec) {
  const out = { kind: spec.kind };
  ['default', 'values', 'min', 'max', 'int', 'minLength', 'optional', 'patternText'].forEach((k) => {
    if (spec[k] !== undefined) out[k] = spec[k];
  });
  return out;
}

function catalog() {
  const out = [];
  DEFS.forEach((d) => {
    const fields = {};
    Object.keys(d.fields).forEach((k) => {
      fields[k] = describeField(d.fields[k]);
    });
    out.push({
      op: d.op,
      kind: d.kind,
      category: d.category,
      label: d.label,
      context: d.context,
      since: d.since,
      fields,
      inputs: d.inputs,
      stacks: d.stacks,
      dynamic: d.dynamic || null,
      declares: d.declares || null,
      aliases: d.aliases || [],
      deprecated: d.deprecated || false,
      replacedBy: d.replacedBy || null,
    });
  });
  return out;
}

module.exports = { P, X, DEFS, ALIASES, getDef, catalog, scanFlow, memberText, mayBeNil, isSimpleRef, numText, SYMS };
