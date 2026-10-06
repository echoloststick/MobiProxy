'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./language');
const B = require('./blocks');

const { T, Reflection, LIMITS, VERSION, LIB, VALUE, makeDiag, isPlainObject, quote, sanitizeName, luaLiteral, RESERVED, LUA_KEYWORDS } = L;
const { ANY, NIL, STR, NUM } = T;
const { P } = B;

const PROGRAM_KEYS = { fv: 'formatVersion', l: 'lang', ft: 'features', m: 'meta', k: 'counters', vs: 'variables', es: 'events', r: 'roots', fl: 'floating' };
const BLOCK_KEYS = { i: 'id', o: 'op', f: 'fields', a: 'args', s: 'stacks', v: 'vars', n: 'note', c: 'collapsed' };

function invert(map) {
  const out = {};
  Object.keys(map).forEach((k) => {
    out[map[k]] = k;
  });
  return out;
}

const PROGRAM_SHORT = invert(PROGRAM_KEYS);
const BLOCK_SHORT = invert(BLOCK_KEYS);

const MIGRATIONS = {};

function mapEntry(entry, toLong) {
  if (!isPlainObject(entry)) return entry;
  const out = {};
  Object.keys(entry).forEach((k) => {
    if (toLong) out[k === 'i' && entry.id === undefined ? 'id' : k] = entry[k];
    else out[k === 'id' ? 'i' : k] = entry[k];
  });
  return out;
}

function mapEntries(list, toLong) {
  return Array.isArray(list) ? list.map((e) => mapEntry(e, toLong)) : list;
}

function mapBlock(raw, toLong) {
  if (!isPlainObject(raw)) return raw;
  const keys = toLong ? BLOCK_KEYS : BLOCK_SHORT;
  const out = {};
  Object.keys(raw).forEach((k) => {
    const nk = keys[k] && (!toLong || raw[keys[k]] === undefined) ? keys[k] : k;
    let value = raw[k];
    const longName = toLong ? nk : k;
    if (longName === 'args' && isPlainObject(value)) {
      const args = {};
      Object.keys(value).forEach((slot) => {
        args[slot] = mapBlock(value[slot], toLong);
      });
      value = args;
    } else if (longName === 'stacks' && isPlainObject(value)) {
      const stacks = {};
      Object.keys(value).forEach((slot) => {
        stacks[slot] = Array.isArray(value[slot]) ? value[slot].map((x) => mapBlock(x, toLong)) : value[slot];
      });
      value = stacks;
    } else if (longName === 'vars') {
      value = mapEntries(value, toLong);
    }
    out[nk] = value;
  });
  return out;
}

function mapPlacements(list, toLong) {
  if (!Array.isArray(list)) return list;
  return list.map((p) => {
    if (!isPlainObject(p)) return p;
    return Object.assign({}, p, { block: mapBlock(p.block, toLong) });
  });
}

function mapProgram(raw, toLong) {
  const keys = toLong ? PROGRAM_KEYS : PROGRAM_SHORT;
  const out = {};
  Object.keys(raw).forEach((k) => {
    const nk = keys[k] && (!toLong || raw[keys[k]] === undefined) ? keys[k] : k;
    const longName = toLong ? nk : k;
    let value = raw[k];
    if (longName === 'variables' && Array.isArray(value)) {
      value = value.map((v) => {
        if (!isPlainObject(v)) return v;
        const m = mapEntry(v, toLong);
        if (m.init !== undefined) m.init = mapBlock(m.init, toLong);
        return m;
      });
    } else if (longName === 'events' && Array.isArray(value)) {
      value = value.map((ev) => {
        if (!isPlainObject(ev)) return ev;
        const m = mapEntry(ev, toLong);
        if (Array.isArray(m.params)) m.params = mapEntries(m.params, toLong);
        return m;
      });
    } else if (longName === 'roots' || longName === 'floating') {
      value = mapPlacements(value, toLong);
    }
    out[nk] = value;
  });
  return out;
}

function compactProgram(program) {
  return mapProgram(JSON.parse(JSON.stringify(program)), false);
}

function encode(program, options) {
  const o = options || {};
  const text = JSON.stringify(compactProgram(program));
  const limit = o.partSize || 190000;
  if (text.length <= limit) return [text];
  const parts = [];
  for (let i = 0; i < text.length; i += limit) parts.push(text.slice(i, i + limit));
  return parts;
}

function corrupt(reason) {
  return makeDiag('E4002', null, null, { reason });
}

function defaultProgram() {
  return {
    format: 'mobi',
    formatVersion: VERSION.format,
    lang: VERSION.lang,
    features: [],
    meta: { name: 'Untitled', context: 'Server' },
    counters: { b: 0, v: 0, e: 0 },
    variables: [],
    events: [],
    roots: [],
    floating: [],
  };
}

function normalizeBlock(blk) {
  if (!isPlainObject(blk)) return;
  const def = B.getDef(blk.op);
  if (def && def.op !== blk.op) blk.op = def.op;
  if (blk.fields !== undefined && !isPlainObject(blk.fields)) blk.fields = {};
  if (blk.args !== undefined && !isPlainObject(blk.args)) blk.args = {};
  if (blk.stacks !== undefined && !isPlainObject(blk.stacks)) blk.stacks = {};
  if (blk.vars !== undefined && !Array.isArray(blk.vars)) blk.vars = [];
  if (blk.args) Object.keys(blk.args).forEach((k) => normalizeBlock(blk.args[k]));
  if (blk.stacks) {
    Object.keys(blk.stacks).forEach((k) => {
      if (Array.isArray(blk.stacks[k])) blk.stacks[k].forEach(normalizeBlock);
    });
  }
}

function idNumber(id, prefix) {
  const m = typeof id === 'string' ? new RegExp('^' + prefix + '(\\d+)$').exec(id) : null;
  return m ? Number(m[1]) : 0;
}

function recountIds(program) {
  const max = { b: 0, v: 0, e: 0 };
  const walk = (blk) => {
    if (!isPlainObject(blk)) return;
    max.b = Math.max(max.b, idNumber(blk.id, 'b'));
    (Array.isArray(blk.vars) ? blk.vars : []).forEach((v) => {
      if (isPlainObject(v)) max.v = Math.max(max.v, idNumber(v.id, 'v'));
    });
    Object.keys(blk.args || {}).forEach((k) => walk(blk.args[k]));
    Object.keys(blk.stacks || {}).forEach((k) => {
      if (Array.isArray(blk.stacks[k])) blk.stacks[k].forEach(walk);
    });
  };
  program.roots.concat(program.floating).forEach((p) => walk(p && p.block));
  program.variables.forEach((v) => {
    if (!isPlainObject(v)) return;
    max.v = Math.max(max.v, idNumber(v.id, 'v'));
    walk(v.init);
  });
  program.events.forEach((ev) => {
    if (!isPlainObject(ev)) return;
    max.e = Math.max(max.e, idNumber(ev.id, 'e'));
    (Array.isArray(ev.params) ? ev.params : []).forEach((p) => {
      if (isPlainObject(p)) max.v = Math.max(max.v, idNumber(p.id, 'v'));
    });
  });
  ['b', 'v', 'e'].forEach((k) => {
    const cur = Number(program.counters[k]);
    program.counters[k] = Number.isFinite(cur) ? Math.max(cur, max[k]) : max[k];
  });
}

function normalize(raw, diags) {
  const program = Object.assign(defaultProgram(), raw);
  ['features', 'variables', 'events', 'roots', 'floating'].forEach((k) => {
    if (!Array.isArray(program[k])) {
      if (raw[k] !== undefined) diags.push(corrupt(`field '${k}' must be a list`));
      program[k] = [];
    }
  });
  if (!isPlainObject(program.meta)) program.meta = {};
  program.meta = Object.assign({ name: 'Untitled', context: 'Server' }, program.meta);
  program.meta.context = program.meta.context === 'Client' ? 'Client' : 'Server';
  if (!isPlainObject(program.counters)) program.counters = {};
  ['roots', 'floating'].forEach((k) => {
    program[k] = program[k].filter((p, i) => {
      const ok = isPlainObject(p) && isPlainObject(p.block);
      if (!ok) diags.push(corrupt(`${k}[${i + 1}] has no block`));
      return ok;
    });
    program[k].forEach((p) => {
      if (!Number.isFinite(p.x)) p.x = 0;
      if (!Number.isFinite(p.y)) p.y = 0;
      normalizeBlock(p.block);
    });
  });
  program.variables = program.variables.filter((v, i) => {
    const ok = isPlainObject(v);
    if (!ok) diags.push(corrupt(`variables[${i + 1}] is not an object`));
    return ok;
  });
  program.variables.forEach((v) => normalizeBlock(v.init));
  program.events = program.events.filter((ev, i) => {
    const ok = isPlainObject(ev);
    if (!ok) diags.push(corrupt(`events[${i + 1}] is not an object`));
    return ok;
  });
  recountIds(program);
  return program;
}

function decode(input) {
  const diags = [];
  let raw = input;
  if (Array.isArray(input) && input.every((p) => typeof p === 'string')) raw = input.join('');
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      diags.push(corrupt('the text is not valid JSON'));
      return { program: null, diagnostics: diags, blocked: true };
    }
  }
  if (!isPlainObject(raw)) {
    diags.push(corrupt('the program must be an object'));
    return { program: null, diagnostics: diags, blocked: true };
  }
  let data = mapProgram(JSON.parse(JSON.stringify(raw)), true);
  if (data.format !== undefined && data.format !== 'mobi') {
    diags.push(corrupt(`unknown container format '${String(data.format)}'`));
    return { program: null, diagnostics: diags, blocked: true };
  }
  let blocked = false;
  const fv = Number.isFinite(data.formatVersion) ? data.formatVersion : 1;
  if (fv > VERSION.format) {
    diags.push(makeDiag('E4001', null, null, { message: `The program uses container format ${fv}, but this compiler supports up to ${VERSION.format}.` }));
    blocked = true;
  } else {
    let cur = fv;
    while (cur < VERSION.format) {
      const step = MIGRATIONS[cur];
      if (typeof step === 'function') data = step(data);
      cur += 1;
    }
  }
  const lang = Number.isFinite(data.lang) ? data.lang : 1;
  if (lang > VERSION.lang) {
    diags.push(makeDiag('E4001', null, null, { message: `The program requires language version ${lang}, but this compiler supports up to ${VERSION.lang}.` }));
    blocked = true;
  }
  (Array.isArray(data.features) ? data.features : []).forEach((f) => {
    if (!L.SUPPORTED_FEATURES.includes(f)) {
      diags.push(makeDiag('E4003', null, null, { feature: String(f) }));
      blocked = true;
    }
  });
  const program = normalize(data, diags);
  program.formatVersion = VERSION.format;
  if (diags.some((d) => d.code === 'E4002')) blocked = true;
  return { program, diagnostics: diags, blocked };
}

function fallbackFor(spec) {
  if (spec.default !== undefined) return spec.default;
  switch (spec.kind) {
    case 'enum': return spec.values[0];
    case 'number': return spec.min !== undefined ? spec.min : 0;
    case 'boolean': return false;
    case 'type': return 'any';
    case 'types': return [];
    default: return '';
  }
}

function fieldProblem(name, spec, v) {
  switch (spec.kind) {
    case 'enum':
      return spec.values.includes(v) ? null : `Field '${name}' must be one of: ${spec.values.join(', ')}.`;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `Field '${name}' must be a finite number.`;
      if (spec.int && !Number.isInteger(v)) return `Field '${name}' must be an integer.`;
      if (spec.min !== undefined && v < spec.min) return `Field '${name}' must be at least ${spec.min}.`;
      if (spec.max !== undefined && v > spec.max) return `Field '${name}' must be at most ${spec.max}.`;
      return null;
    case 'string':
      if (typeof v !== 'string') return `Field '${name}' must be text.`;
      if (spec.minLength !== undefined && v.length < spec.minLength) return `Field '${name}' cannot be empty.`;
      if (spec.pattern && !spec.pattern.test(v)) return `Field '${name}' must be ${spec.patternText || 'in a valid format'}.`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : `Field '${name}' must be true or false.`;
    case 'id':
      return typeof v === 'string' && v.length > 0 ? null : `Field '${name}' must reference an existing item.`;
    case 'type':
      return typeof v === 'string' && (v === 'auto' || T.parse(v)) ? null : `Field '${name}' is not a valid type descriptor.`;
    case 'types':
      return Array.isArray(v) && v.every((s) => typeof s === 'string' && T.parse(s)) ? null : `Field '${name}' must be a list of valid type descriptors.`;
    default:
      return null;
  }
}

function checkFields(def, blk, report) {
  Object.keys(def.fields).forEach((name) => {
    const spec = def.fields[name];
    const v = blk.fields ? blk.fields[name] : undefined;
    if (v === undefined || v === null) {
      if (spec.default === undefined && !spec.optional) report('E1005', blk, name, { message: `Field '${name}' is required.` });
      return;
    }
    const problem = fieldProblem(name, spec, v);
    if (problem) report('E1005', blk, name, { message: problem });
  });
}

function fieldValue(def, blk, name) {
  const spec = def.fields[name];
  if (!spec) return blk.fields ? blk.fields[name] : undefined;
  const v = blk.fields ? blk.fields[name] : undefined;
  if (v === undefined || v === null) return spec.optional ? undefined : fallbackFor(spec);
  return fieldProblem(name, spec, v) ? (spec.optional ? undefined : fallbackFor(spec)) : v;
}

function structure(program, report) {
  const seen = new Map();
  let count = 0;
  let limitHit = false;
  const walk = (blk, depth, rootKey) => {
    if (!isPlainObject(blk)) return;
    count += 1;
    if (count > LIMITS.blocks) {
      if (!limitHit) report('E1008', blk, null, { message: `The program exceeds the limit of ${LIMITS.blocks} blocks.` }, rootKey);
      limitHit = true;
      return;
    }
    if (typeof blk.id !== 'string' || blk.id.length === 0) {
      report('E1005', null, null, { message: 'A block has no id.' }, rootKey);
    } else if (seen.has(blk.id)) {
      report('E1004', blk, null, { id: blk.id }, rootKey);
    } else {
      seen.set(blk.id, blk);
    }
    if (typeof blk.op !== 'string') report('E1005', blk, null, { message: 'A block has no operation.' }, rootKey);
    if (depth > LIMITS.depth) {
      report('E1007', blk, null, {}, rootKey);
      return;
    }
    Object.keys(blk.args || {}).forEach((k) => walk(blk.args[k], depth + 1, rootKey));
    Object.keys(blk.stacks || {}).forEach((k) => {
      if (Array.isArray(blk.stacks[k])) blk.stacks[k].forEach((x) => walk(x, depth + 1, rootKey));
    });
  };
  if (program.roots.length > LIMITS.roots) report('E1008', null, null, { message: `The program exceeds the limit of ${LIMITS.roots} scripts.` }, null);
  if (program.variables.length > LIMITS.variables) report('E1008', null, null, { message: `The program exceeds the limit of ${LIMITS.variables} variables.` }, null);
  program.variables.forEach((v) => walk(v.init, 1, 'v:' + v.id));
  program.roots.forEach((p, i) => walk(p.block, 1, 'r' + i));
  program.floating.forEach((p, i) => walk(p.block, 1, 'f' + i));
  return { blocks: count, ids: seen };
}

function rootFrame() {
  return { kind: 'root', returns: [], loops: 0, tries: [], locals: 0, name: null };
}

function baseScope() {
  return { vars: new Map(), narrow: new Map(), barrier: true, params: new Set() };
}

function parseSilently(text) {
  return typeof text === 'string' && text !== 'auto' && text !== '' ? T.parse(text) || ANY : ANY;
}

function article(kind) {
  return kind === 'expr' ? 'a value block' : kind === 'hat' ? 'a script root' : 'a statement';
}

class Analysis {
  constructor(program, options) {
    this.program = program;
    this.options = options;
    this.native = options.native;
    this.blocked = options.blocked;
    this.context = program.meta.context;
    this.diags = [];
    this.warnSeen = new Set();
    this.onceSeen = new Set();
    this.infos = new Map();
    this.usedSlots = new Map();
    this.globals = new Map();
    this.globalOrder = [];
    this.fns = new Map();
    this.events = new Map();
    this.declIndex = new Map();
    this.visited = new Set();
    this.declCache = new Map();
    this.callEdges = [];
    this.errorRoots = new Map();
    this.skipRoots = new Set();
    this.scopes = [baseScope()];
    this.frame = rootFrame();
    this.rootKey = null;
    this.stats = { blocks: 0 };
  }

  report(code, b, slot, data, rootOverride) {
    const d = makeDiag(code, b && typeof b.id === 'string' ? b.id : null, slot, data);
    if (code === 'W2001' || code === 'W2003') {
      const key = `${code}|${d.blockId}|${slot}`;
      if (this.warnSeen.has(key)) return;
      this.warnSeen.add(key);
    }
    d.root = rootOverride !== undefined ? rootOverride : this.rootKey;
    this.diags.push(d);
    if (d.severity === 'error' && d.root) this.errorRoots.set(d.root, (this.errorRoots.get(d.root) || 0) + 1);
  }

  reportOnce(code, data) {
    if (this.onceSeen.has(code)) return;
    this.onceSeen.add(code);
    this.report(code, null, null, data, null);
  }

  unverified(b, slot) {
    if (!Reflection.loaded) this.reportOnce('W2005', {});
    else this.report('W2003', b, slot, {});
  }

  serviceBlocked(name) {
    return this.blocked.has(name);
  }

  defOf(b) {
    return B.getDef(b.op);
  }

  field(b, name) {
    return fieldValue(this.defOf(b), b, name);
  }

  usedSet(b) {
    let s = this.usedSlots.get(b);
    if (!s) {
      s = new Set();
      this.usedSlots.set(b, s);
    }
    return s;
  }

  infoOf(b) {
    let i = this.infos.get(b);
    if (!i) {
      i = { slots: {}, coerced: {}, type: null };
      this.infos.set(b, i);
    }
    return i;
  }

  info(b) {
    return this.infoOf(b);
  }

  setInfo(b, obj) {
    Object.assign(this.infoOf(b), obj);
  }

  typeOfSlot(b, slot) {
    return this.infoOf(b).slots[slot] || null;
  }

  has(b, slot) {
    return !!(b.args && isPlainObject(b.args[slot]));
  }

  arg(b, slot) {
    return b.args ? b.args[slot] : undefined;
  }

  maxSlot(b, prefix) {
    let max = 0;
    Object.keys(b.args || {}).forEach((k) => {
      const m = new RegExp('^' + prefix + '(\\d+)$').exec(k);
      if (m && b.args[k] && Number(m[1]) <= LIMITS.argc) max = Math.max(max, Number(m[1]));
    });
    return max;
  }

  top() {
    return this.scopes[this.scopes.length - 1];
  }

  push(opts) {
    this.scopes.push({ vars: new Map(), narrow: new Map(), barrier: !!(opts && opts.barrier), params: new Set() });
  }

  pop() {
    const s = this.scopes.pop();
    s.vars.forEach((v) => {
      if (v.trackUnused && !v.read) this.report('W3001', v.block, null, { name: v.name });
    });
  }

  withFrame(frame, fn) {
    const saved = this.frame;
    this.frame = frame;
    try {
      return fn();
    } finally {
      this.frame = saved;
    }
  }

  tryEnter() {
    this.frame.tries.push({ loops: this.frame.loops });
  }

  tryLeave() {
    this.frame.tries.pop();
  }

  checkLoopExit(b, what) {
    const f = this.frame;
    if (f.loops === 0) {
      this.report('E3003', b, null, { what });
      return;
    }
    const t = f.tries[f.tries.length - 1];
    if (t && t.loops >= f.loops) this.report('E3006', b, null, { what });
  }

  declType(entry, b) {
    if (!entry || typeof entry !== 'object') return null;
    if (this.declCache.has(entry)) return this.declCache.get(entry);
    let t = null;
    const text = entry.type;
    if (typeof text === 'string' && text !== 'auto' && text !== '') {
      t = T.parse(text);
      if (!t) this.report('E1005', b, null, { message: `'${text}' is not a valid type descriptor.` });
    }
    this.declCache.set(entry, t);
    return t;
  }

  types(list) {
    return (Array.isArray(list) ? list : []).map((s) => (typeof s === 'string' ? T.parse(s) || ANY : ANY));
  }

  findByName(name) {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      for (const v of this.scopes[i].vars.values()) {
        if (v.name === name) return v;
      }
    }
    for (const g of this.globals.values()) {
      if (g.name === name) return g;
    }
    return null;
  }

  declare(entry, opts) {
    const o = opts || {};
    const scope = this.top();
    const name = entry.name;
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > LIMITS.nameLength) {
      this.report('E1005', o.block, null, { message: `A variable name must be between 1 and ${LIMITS.nameLength} characters.` });
    }
    if (o.kind === 'param') {
      if (scope.params.has(name)) this.report('E3004', o.block, null, { what: 'Parameter', name });
      scope.params.add(name);
    }
    if (this.findByName(name)) this.report('W3003', o.block, null, { name });
    this.frame.locals += 1;
    if (this.frame.locals === LIMITS.locals + 1) this.report('E3005', o.block, null, {});
    const info = {
      id: entry.id,
      name,
      declared: o.type || ANY,
      type: o.type || ANY,
      kind: o.kind || 'local',
      readOnly: o.kind === 'loop',
      global: false,
      read: false,
      block: o.block,
      trackUnused: !!o.trackUnused,
    };
    scope.vars.set(entry.id, info);
    this.visited.add(entry.id);
    return info;
  }

  find(id) {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const v = this.scopes[i].vars.get(id);
      if (v) return v;
    }
    return this.globals.get(id) || null;
  }

  effective(info) {
    if (info.global) return info.type;
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const s = this.scopes[i];
      if (s.vars.has(info.id)) return info.type;
      if (s.narrow.has(info.id)) return s.narrow.get(info.id);
      if (s.barrier) break;
    }
    return info.type;
  }

  view(info) {
    return {
      id: info.id, name: info.name, declared: info.declared, type: this.effective(info),
      readOnly: info.readOnly, global: info.global, ref: info,
    };
  }

  missing(b, id, slot) {
    if (this.declIndex.has(id)) {
      const d = this.declIndex.get(id);
      this.report(this.visited.has(id) ? 'E3002' : 'E3001', b, slot, { name: d.name, id });
    } else {
      this.report('E2002', b, slot, { id });
    }
  }

  lookup(b, id, slot) {
    const found = this.find(id);
    if (!found) {
      this.missing(b, id, slot);
      return null;
    }
    found.read = true;
    return this.view(found);
  }

  assignTarget(b, id, slot) {
    const found = this.find(id);
    if (!found) {
      this.missing(b, id, slot);
      return null;
    }
    if (found.readOnly) this.report('E2009', b, slot, { member: found.name });
    return this.view(found);
  }

  markRead(view) {
    view.ref.read = true;
  }

  clearNarrow(id) {
    this.scopes.forEach((s) => s.narrow.delete(id));
  }

  assigned(view) {
    this.clearNarrow(view.id);
  }

  narrow(map) {
    const s = this.top();
    map.forEach((t, id) => s.narrow.set(id, t));
  }

  peekLocal(id) {
    if (typeof id !== 'string') return null;
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const v = this.scopes[i].vars.get(id);
      if (v) return { id, type: this.effective(v) };
    }
    return null;
  }

  facts(blk) {
    const out = { t: new Map(), f: new Map() };
    if (!isPlainObject(blk)) return out;
    const args = blk.args || {};
    const varOf = (x) => (x && x.op === 'var.get' && x.fields ? this.peekLocal(x.fields.var) : null);
    if (blk.op === 'var.get') {
      const v = varOf(blk);
      if (v && v.type.opt) out.t.set(v.id, T.strip(v.type));
    } else if (blk.op === 'op.compare') {
      const op = blk.fields && blk.fields.op;
      let v = null;
      if (args.a && args.a.op === 'var.get' && args.b && args.b.op === 'lit.nil') v = varOf(args.a);
      else if (args.b && args.b.op === 'var.get' && args.a && args.a.op === 'lit.nil') v = varOf(args.b);
      if (v && v.type.opt) {
        if (op === 'ne') out.t.set(v.id, T.strip(v.type));
        else if (op === 'eq') out.f.set(v.id, T.strip(v.type));
      }
    } else if (blk.op === 'op.not') {
      const inner = this.facts(args.a);
      return { t: inner.f, f: inner.t };
    } else if (blk.op === 'op.logic') {
      const fa = this.facts(args.a);
      const fb = this.facts(args.b);
      const op = blk.fields && blk.fields.op;
      if (op === 'and') {
        fa.t.forEach((t, id) => out.t.set(id, t));
        fb.t.forEach((t, id) => out.t.set(id, t));
      } else if (op === 'or') {
        fa.f.forEach((t, id) => out.f.set(id, t));
        fb.f.forEach((t, id) => out.f.set(id, t));
      }
    }
    return out;
  }

  fnLookup(b, id) {
    const f = this.fns.get(id);
    if (!f) {
      this.report('E2003', b, 'fn', { id });
      return null;
    }
    this.callEdges.push({ root: this.rootKey, fnId: id, block: b });
    return f;
  }

  hatFunction(b) {
    const info = this.fns.get(b.id);
    if (info && info.duplicate) this.report('E3004', b, null, { what: 'Function', name: info.name });
    return info || { id: b.id, name: '', params: [], returns: [] };
  }

  eventLookup(b, id) {
    const ev = this.events.get(id);
    if (!ev) {
      this.report('E2010', b, 'event', { id });
      return null;
    }
    return ev;
  }

  looseArgs(b) {
    const used = this.usedSet(b);
    Object.keys(b.args || {}).forEach((k) => {
      if (used.has(k)) return;
      used.add(k);
      if (isPlainObject(b.args[k])) this.analyzeBlock(b.args[k], 'expr');
    });
  }

  input(b, slot, spec) {
    const s = spec || {};
    this.usedSet(b).add(slot);
    const child = b.args ? b.args[slot] : undefined;
    if (child === undefined || child === null) {
      if (!s.optional) this.report('E1002', b, slot, { slot });
      return s.optional ? null : ANY;
    }
    if (!isPlainObject(child)) {
      this.report('E1005', b, slot, { message: `Input '${slot}' does not contain a block.` });
      return ANY;
    }
    const t = this.analyzeBlock(child, 'expr');
    const info = this.infoOf(b);
    info.slots[slot] = t;
    if (s.type) {
      const exp = typeof s.type === 'string' ? T.parse(s.type) || ANY : s.type;
      const r = T.assignable(t, exp);
      if (!r.ok) {
        const msg = s.label ? `${s.label}: expected ${T.fmt(exp)} but got ${T.fmt(t)}.` : undefined;
        this.report(s.code || 'E2001', b, slot, { expected: T.fmt(exp), actual: T.fmt(t), message: msg });
      } else if (r.warn === 'W2001') {
        this.report('W2001', b, slot, { type: T.fmt(T.strip(exp)) });
      } else if (r.warn === 'W2003') {
        this.report('W2003', b, slot, {});
      }
    }
    if (s.coerce) {
      if (t.k !== 'string' || t.opt) info.coerced[slot] = true;
      if (t.k !== 'string' && t.k !== 'any') this.report('W2002', b, slot, { type: T.fmt(t) });
    }
    return t;
  }

  analyzeBlock(b, role) {
    if (!isPlainObject(b)) return ANY;
    this.usedSet(b);
    const def = B.getDef(b.op);
    if (!def) {
      this.report('E1001', b, null, { op: String(b.op) });
      return ANY;
    }
    const kindOk = role === 'expr' ? def.kind === 'expr' : role === 'hat' ? def.kind === 'hat' : def.kind === 'stmt' || def.kind === 'cap';
    if (!kindOk) {
      const where = role === 'expr' ? 'as a value' : role === 'hat' ? 'as a script root' : 'inside a script body';
      this.report('E1006', b, null, { message: `Block '${b.op}' is ${article(def.kind)} and cannot be used ${where}.` });
      return ANY;
    }
    if (def.context !== 'both' && def.context.toLowerCase() !== String(this.context).toLowerCase()) {
      this.report('E2006', b, null, { op: b.op, context: this.context });
    }
    if (def.deprecated) this.report('W4001', b, null, { op: b.op, replacedBy: def.replacedBy });
    checkFields(def, b, (c, blk, slot, data) => this.report(c, blk, slot, data));
    let t = null;
    try {
      t = def.analyze(this, b);
    } catch (err) {
      this.report('E1005', b, null, { message: 'The block contains malformed data and could not be analyzed.' });
      t = ANY;
    }
    const type = def.kind === 'expr' ? t || ANY : null;
    this.infoOf(b).type = type;
    const used = this.usedSet(b);
    Object.keys(b.args || {}).forEach((k) => {
      if (!used.has(k) && b.args[k]) this.report('E1003', b, k, { slot: k, op: b.op });
    });
    Object.keys(b.stacks || {}).forEach((k) => {
      const list = b.stacks[k];
      if (!used.has(k) && !(Array.isArray(list) && list.length === 0)) this.report('E1003', b, k, { slot: k, op: b.op });
    });
    return type || ANY;
  }

  stack(b, name, opts) {
    const o = opts || {};
    this.usedSet(b).add(name);
    const list = b.stacks ? b.stacks[name] : undefined;
    this.push({});
    (o.narrow || []).forEach((m) => this.narrow(m));
    (o.declare || []).forEach((d) => this.declare(d.entry, { type: d.type, kind: d.kind, block: b }));
    if (o.loop) this.frame.loops += 1;
    let terminates = false;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i += 1) {
        const blk = list[i];
        if (!isPlainObject(blk)) {
          this.report('E1005', b, name, { message: `Stack '${name}' contains an entry that is not a block.` });
          continue;
        }
        if (terminates) {
          this.report('W3002', blk, null, {});
          break;
        }
        const def = B.getDef(blk.op);
        this.analyzeBlock(blk, 'stmt');
        if (def && def.kind === 'cap') terminates = true;
        if (this.infos.has(blk) && this.infoOf(blk).terminates) terminates = true;
      }
    } else if (list !== undefined && list !== null) {
      this.report('E1005', b, name, { message: `Stack '${name}' must be a list of blocks.` });
    }
    if (o.loop) this.frame.loops -= 1;
    this.pop();
    return { terminates };
  }

  collectDecls(blk, rootKey) {
    if (!isPlainObject(blk)) return;
    (Array.isArray(blk.vars) ? blk.vars : []).forEach((v) => {
      if (isPlainObject(v) && typeof v.id === 'string' && !this.declIndex.has(v.id)) this.declIndex.set(v.id, { name: v.name, rootKey });
    });
    Object.keys(blk.args || {}).forEach((k) => this.collectDecls(blk.args[k], rootKey));
    Object.keys(blk.stacks || {}).forEach((k) => {
      if (Array.isArray(blk.stacks[k])) blk.stacks[k].forEach((x) => this.collectDecls(x, rootKey));
    });
  }

  collect() {
    const p = this.program;
    p.roots.forEach((r, i) => {
      if (!this.skipRoots.has('r' + i)) this.collectDecls(r.block, 'r' + i);
    });
    const evNames = new Set();
    p.events.forEach((ev) => {
      if (typeof ev.id !== 'string' || ev.id.length === 0) {
        this.report('E1005', null, null, { message: 'A custom event has no id.' }, null);
        return;
      }
      if (typeof ev.name !== 'string' || ev.name.trim().length === 0 || ev.name.length > LIMITS.nameLength) {
        this.report('E1005', null, null, { message: `The name of custom event '${ev.id}' must be between 1 and ${LIMITS.nameLength} characters.` }, null);
      } else if (evNames.has(ev.name)) {
        this.report('E3004', null, null, { what: 'Event', name: ev.name }, null);
      }
      evNames.add(ev.name);
      const params = [];
      (Array.isArray(ev.params) ? ev.params : []).forEach((q) => {
        if (!isPlainObject(q) || typeof q.id !== 'string') {
          this.report('E1005', null, null, { message: `Event '${ev.name}' has an invalid parameter.` }, null);
          return;
        }
        params.push({ id: q.id, name: q.name, type: parseSilently(q.type) });
      });
      this.events.set(ev.id, { id: ev.id, name: ev.name, params });
    });
    const fnNames = new Map();
    p.roots.forEach((r, i) => {
      const blk = r.block;
      if (!blk || blk.op !== 'fn.define') return;
      const name = blk.fields && typeof blk.fields.name === 'string' ? blk.fields.name : '';
      const params = (Array.isArray(blk.vars) ? blk.vars : [])
        .filter((v) => isPlainObject(v) && typeof v.id === 'string')
        .map((v) => ({ id: v.id, name: v.name, type: parseSilently(v.type) }));
      const returns = this.types(blk.fields && Array.isArray(blk.fields.returns) ? blk.fields.returns : []);
      const duplicate = fnNames.has(name);
      if (!duplicate) fnNames.set(name, blk.id);
      this.fns.set(blk.id, { id: blk.id, name, params, returns, block: blk, rootKey: 'r' + i, duplicate });
    });
    const gNames = new Set();
    p.variables.forEach((v) => {
      if (typeof v.id !== 'string' || v.id.length === 0) {
        this.report('E1005', null, null, { message: 'A global variable has no id.' }, null);
        return;
      }
      if (typeof v.name !== 'string' || v.name.trim().length === 0 || v.name.length > LIMITS.nameLength) {
        this.report('E1005', null, null, { message: `The name of variable '${v.id}' must be between 1 and ${LIMITS.nameLength} characters.` }, 'v:' + v.id);
      } else if (gNames.has(v.name)) {
        this.report('E3004', null, null, { what: 'Variable', name: v.name }, 'v:' + v.id);
      }
      gNames.add(v.name);
      let declared = null;
      if (typeof v.type === 'string' && v.type !== 'auto' && v.type !== '') {
        declared = T.parse(v.type);
        if (!declared) this.report('E1005', null, null, { message: `Variable '${v.name}' has an invalid type '${v.type}'.` }, 'v:' + v.id);
      }
      const info = {
        id: v.id, name: v.name, declared: declared || ANY, type: declared || ANY, readOnly: false,
        global: true, read: false, auto: !declared, entry: v,
      };
      this.globals.set(v.id, info);
      this.globalOrder.push(info);
    });
  }

  analyzeGlobals() {
    this.globalOrder.forEach((g) => {
      const key = 'v:' + g.id;
      if (this.skipRoots.has(key)) return;
      this.rootKey = key;
      this.scopes = [baseScope()];
      this.frame = rootFrame();
      const init = g.entry.init;
      if (init === undefined || init === null) return;
      if (!isPlainObject(init)) {
        this.report('E1005', null, null, { message: `The initial value of '${g.name}' is not a block.` });
        return;
      }
      const t = this.analyzeBlock(init, 'expr');
      if (g.auto) {
        g.declared = t.k === 'nil' ? ANY : t;
        g.type = g.declared;
        return;
      }
      const r = T.assignable(t, g.declared);
      if (!r.ok) this.report('E2001', init, null, { expected: T.fmt(g.declared), actual: T.fmt(t) });
      else if (r.warn === 'W2001') this.report('W2001', init, null, { type: T.fmt(T.strip(g.declared)) });
      else if (r.warn === 'W2003') this.report('W2003', init, null, {});
    });
  }

  analyzeRoots() {
    this.program.roots.forEach((r, i) => {
      const key = 'r' + i;
      if (this.skipRoots.has(key)) return;
      this.rootKey = key;
      this.scopes = [baseScope()];
      this.frame = rootFrame();
      this.analyzeBlock(r.block, 'hat');
    });
    this.program.floating.forEach((r, i) => {
      this.report('W1001', r.block, null, { op: String(r.block.op) }, 'f' + i);
    });
  }

  finish() {
    const flagged = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      this.callEdges.forEach((edge, idx) => {
        if (flagged.has(idx)) return;
        const f = this.fns.get(edge.fnId);
        if (f && (this.errorRoots.get(f.rootKey) || 0) > 0) {
          flagged.add(idx);
          changed = true;
          this.report('E2004', edge.block, null, { name: f.name }, edge.root);
        }
      });
    }
    this.globalOrder.forEach((g) => {
      if (!g.read) this.report('W3001', null, null, { name: g.name }, 'v:' + g.id);
    });
    const order = (key) => {
      if (!key) return -1;
      if (key[0] === 'v') return this.globalOrder.findIndex((g) => 'v:' + g.id === key);
      return (key[0] === 'r' ? 1000 : 100000) + Number(key.slice(1));
    };
    const indexed = this.diags.map((d, i) => ({ d, i, o: order(d.root) }));
    indexed.sort((a, b) => a.o - b.o || a.i - b.i);
    this.diags = indexed.map((x) => x.d);
  }

  invalid(key) {
    return (this.errorRoots.get(key) || 0) > 0;
  }
}

function analyze(program, options) {
  const an = new Analysis(program, options);
  an.stats = structure(program, (c, b, s, d, root) => an.report(c, b, s, d, root));
  an.diags.forEach((d) => {
    if (d.code === 'E1007' && d.root) an.skipRoots.add(d.root);
  });
  if (an.diags.some((d) => d.code === 'E1008')) {
    an.finish();
    return an;
  }
  an.collect();
  an.analyzeGlobals();
  an.analyzeRoots();
  an.finish();
  return an;
}

const MARK_OPEN = '\u0001';
const MARK_CLOSE = '\u0002';
const MARK_PATTERN = /^(\t*)\u0001([^\u0002]*)\u0002([\s\S]*)$/;

let runtimeCache = null;

function runtimeSource() {
  if (runtimeCache === null) {
    runtimeCache = fs.readFileSync(path.join(__dirname, 'runtime.lua'), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  }
  return runtimeCache;
}

function uniqueIdent(base, used) {
  let name = sanitizeName(base, 'item');
  if (LUA_KEYWORDS.has(name)) name += '_';
  let out = name;
  let n = 2;
  while (used.has(out)) {
    out = `${name}_${n}`;
    n += 1;
  }
  used.add(out);
  return out;
}

class Emitter {
  constructor(program, an, options) {
    this.program = program;
    this.an = an;
    this.options = options;
    this.debug = options.mode === 'debug';
    this.native = options.native;
    this.lines = [];
    this.ids = [];
    this.level = 0;
    this.used = new Set();
    this.varNames = new Map();
    this.counter = 0;
    this.loopFrames = [];
    this.globalNames = new Map();
    this.fnNames = new Map();
    const gUsed = new Set();
    an.globalOrder.forEach((g) => this.globalNames.set(g.id, uniqueIdent(g.name, gUsed)));
    const fUsed = new Set();
    Array.from(an.fns.values()).forEach((f) => this.fnNames.set(f.id, uniqueIdent(f.name, fUsed)));
  }

  beginRoot() {
    this.used = new Set();
    this.varNames = new Map();
    this.counter = 0;
    this.loopFrames = [];
    this.level = 0;
  }

  field(b, name) {
    return this.an.field(b, name);
  }

  info(b) {
    return this.an.infoOf(b);
  }

  has(b, slot) {
    return !!(b.args && isPlainObject(b.args[slot]));
  }

  bid(b) {
    return quote(b.id);
  }

  ref(id) {
    if (this.varNames.has(id)) return this.varNames.get(id);
    const g = this.globalNames.get(id);
    return g ? B.memberText('G', g) : 'nil';
  }

  fn(id) {
    const f = this.an.fns.get(id);
    return Object.assign({}, f, { ref: B.memberText('F', this.fnNames.get(id)) });
  }

  event(id) {
    return this.an.events.get(id);
  }

  bind(entry) {
    let base = sanitizeName(entry.name, 'value');
    if (RESERVED.has(base)) base += '_';
    let name = base;
    let n = 2;
    while (this.used.has(name)) {
      name = `${base}_${n}`;
      n += 1;
    }
    this.used.add(name);
    this.varNames.set(entry.id, name);
    return name;
  }

  temp(prefix) {
    let name;
    do {
      this.counter += 1;
      name = `${prefix}_${this.counter}`;
    } while (this.used.has(name));
    this.used.add(name);
    return name;
  }

  indent() {
    this.level += 1;
  }

  dedent() {
    this.level -= 1;
  }

  indentText(text, n) {
    return String(text).replace(/\n/g, '\n' + '\t'.repeat(n));
  }

  line(text, b) {
    const prefix = '\t'.repeat(this.level);
    const fallback = b && typeof b.id === 'string' ? b.id : null;
    String(text).split('\n').forEach((ln) => {
      const m = MARK_PATTERN.exec(ln);
      if (m) {
        this.lines.push(prefix + m[1] + m[3]);
        this.ids.push(m[2] || fallback);
      } else {
        this.lines.push(prefix + ln);
        this.ids.push(fallback);
      }
    });
  }

  stmtLine(text, b) {
    this.line(text.startsWith('(') ? ';' + text : text, b);
  }

  expr(child) {
    return B.getDef(child.op).emit(this, child);
  }

  xp(b, slot) {
    const child = b.args ? b.args[slot] : undefined;
    if (!isPlainObject(child)) return { t: 'nil', p: P.LIT };
    return this.expr(child);
  }

  x(b, slot, minPrec) {
    const r = this.xp(b, slot);
    return r.p < (minPrec || 0) ? `(${r.t})` : r.t;
  }

  str(b, slot, minPrec) {
    const r = this.xp(b, slot);
    if (this.info(b).coerced[slot]) return `tostring(${r.t})`;
    return r.p < (minPrec || 0) ? `(${r.t})` : r.t;
  }

  stack(b, name) {
    const list = b.stacks ? b.stacks[name] : undefined;
    if (!Array.isArray(list)) return;
    for (const blk of list) {
      if (!isPlainObject(blk)) continue;
      const def = B.getDef(blk.op);
      def.emit(this, blk);
      if (def.kind === 'cap' || (this.an.infos.has(blk) && this.an.infoOf(blk).terminates)) break;
    }
  }

  closure(b, stackName, vars) {
    const saved = { lines: this.lines, ids: this.ids, level: this.level, loops: this.loopFrames };
    this.lines = [];
    this.ids = [];
    this.level = 1;
    this.loopFrames = [];
    const names = (vars || []).filter((v) => v && typeof v.id === 'string').map((v) => this.bind(v));
    this.stack(b, stackName);
    const body = this.lines.map((ln, i) => {
      const m = /^(\t*)([\s\S]*)$/.exec(ln);
      return m[1] + MARK_OPEN + (this.ids[i] || '') + MARK_CLOSE + m[2];
    });
    this.lines = saved.lines;
    this.ids = saved.ids;
    this.level = saved.level;
    this.loopFrames = saved.loops;
    return [`function(${names.join(', ')})`].concat(body).concat(['end']).join('\n');
  }

  loopBody(b, name, opts) {
    const list = b.stacks ? b.stacks[name] : undefined;
    if (opts && opts.guard) this.line(`Rt.guard(${this.bid(b)})`, b);
    const lowered = !this.native && B.scanFlow(list, 'continue');
    if (!lowered) {
      this.loopFrames.push({ lowered: false, flag: null });
      this.stack(b, name);
      this.loopFrames.pop();
      return;
    }
    const flag = B.scanFlow(list, 'break') ? this.temp('brk') : null;
    if (flag) this.line(`local ${flag} = false`, b);
    this.line('repeat', b);
    this.indent();
    this.loopFrames.push({ lowered: true, flag });
    this.stack(b, name);
    this.loopFrames.pop();
    this.dedent();
    this.line('until true', b);
    if (flag) this.line(`if ${flag} then break end`, b);
  }

  loopBreak(b) {
    const f = this.loopFrames[this.loopFrames.length - 1];
    if (f && f.lowered && f.flag) this.line(`${f.flag} = true`, b);
    this.line('break', b);
  }

  loopContinue(b) {
    const f = this.loopFrames[this.loopFrames.length - 1];
    this.line(f && f.lowered ? 'break' : 'continue', b);
  }
}

function configLiteral(options, program) {
  const blocked = {};
  Array.from(options.blocked).sort().forEach((n) => {
    blocked[n] = true;
  });
  return luaLiteral({
    debug: options.mode === 'debug',
    blocked,
    label: String(program.meta.name || 'Program'),
    lang: VERSION.lang,
  });
}

function writePrelude(e, program, options) {
  const config = configLiteral(options, program);
  if (options.prelude === 'injected') {
    e.line('local Rt = __mobi');
  } else if (options.prelude === 'module') {
    e.line(`local Rt = require(${options.runtimeRequire || 'script.Parent:WaitForChild("MobiRuntime")'})(${config})`);
  } else {
    e.line('local Rt = (function(...)');
    e.line(runtimeSource());
    e.line(`end)(${config})`);
  }
  e.line('local G = {}');
  e.line('local F = {}');
}

function emitProgram(program, an, options) {
  const e = new Emitter(program, an, options);
  const skipped = [];
  const reasons = (key) => an.diags.filter((d) => d.root === key && d.severity === 'error').map((d) => d.code);
  writePrelude(e, program, options);
  const emitRoot = (key, blk, wrap, fn) => {
    if (an.invalid(key)) {
      skipped.push({ key, id: blk && blk.id ? blk.id : null, op: blk ? blk.op : null, codes: Array.from(new Set(reasons(key))) });
      return;
    }
    e.beginRoot();
    if (wrap) {
      e.line(`Rt.root(${quote(blk.id)}, function()`, blk);
      e.indent();
    }
    fn();
    if (wrap) {
      e.dedent();
      e.line('end)', blk);
    }
  };
  program.roots.forEach((r, i) => {
    if (r.block.op !== 'fn.define') return;
    emitRoot('r' + i, r.block, false, () => B.getDef(r.block.op).emitHat(e, r.block));
  });
  an.globalOrder.forEach((g) => {
    const init = g.entry.init;
    if (!isPlainObject(init)) return;
    emitRoot('v:' + g.id, init, true, () => {
      e.line(`${e.ref(g.id)} = ${e.expr(init).t}`, init);
    });
  });
  program.roots.forEach((r, i) => {
    if (r.block.op === 'fn.define') return;
    emitRoot('r' + i, r.block, true, () => B.getDef(r.block.op).emitHat(e, r.block));
  });
  e.beginRoot();
  e.line('Rt.ready()');
  e.line('return Rt');
  const lineToBlock = e.ids.slice();
  const blockToLine = {};
  lineToBlock.forEach((id, i) => {
    if (id && blockToLine[id] === undefined) blockToLine[id] = i + 1;
  });
  return { source: e.lines.join('\n') + '\n', sourceMap: { lineToBlock, blockToLine }, skipped };
}

function normalizeOptions(raw) {
  const o = isPlainObject(raw) ? raw : {};
  const list = Array.isArray(o.blockedServices) ? o.blockedServices.filter((s) => typeof s === 'string') : L.DEFAULT_BLOCKED_SERVICES;
  return {
    mode: o.mode === 'release' ? 'release' : 'debug',
    policy: o.policy === 'strict' ? 'strict' : 'lenient',
    native: o.native === true,
    prelude: o.prelude === 'injected' || o.prelude === 'module' ? o.prelude : 'embedded',
    runtimeRequire: typeof o.runtimeRequire === 'string' && o.runtimeRequire.length > 0 ? o.runtimeRequire : null,
    sourceMap: o.sourceMap !== false,
    blocked: new Set(list),
  };
}

function summarize(diags) {
  const out = { errors: 0, warnings: 0, infos: 0 };
  diags.forEach((d) => {
    if (d.severity === 'error') out.errors += 1;
    else if (d.severity === 'warning') out.warnings += 1;
    else out.infos += 1;
  });
  return out;
}

function publicDiag(d) {
  return { code: d.code, name: d.name, severity: d.severity, blockId: d.blockId, slot: d.slot, message: d.message, root: d.root || null, data: d.data };
}

function failure(diags, options, extra) {
  const list = diags.map(publicDiag);
  return Object.assign({
    ok: false, mode: options.mode, policy: options.policy, source: null, sourceMap: null,
    diagnostics: list, skippedRoots: [], stats: Object.assign({ blocks: 0, roots: 0, lines: 0 }, summarize(list)),
    reflection: Reflection.status(),
  }, extra || {});
}

function analyzeInput(input, rawOptions, forCompile) {
  const options = normalizeOptions(rawOptions);
  let dec;
  try {
    dec = decode(input);
  } catch (err) {
    dec = { program: null, diagnostics: [corrupt('the program is nested too deeply or malformed')], blocked: true };
  }
  if (!dec.program || dec.blocked) return { options, failed: failure(dec.diagnostics, options) };
  const program = dec.program;
  const extra = [];
  if (forCompile && program.meta.context === 'Client') extra.push(makeDiag('E4003', null, null, { feature: 'Client context runtime' }));
  const an = analyze(program, { blocked: options.blocked, native: options.native });
  return { options, program, an, diags: dec.diagnostics.concat(extra, an.diags) };
}

function compileSync(input, rawOptions) {
  const ctx = analyzeInput(input, rawOptions, true);
  if (ctx.failed) return ctx.failed;
  const { options, program, an, diags } = ctx;
  const errors = diags.filter((d) => d.severity === 'error');
  const fatal = errors.some((d) => !d.root);
  const ok = options.policy === 'strict' ? errors.length === 0 : !fatal;
  const list = diags.map(publicDiag);
  const stats = Object.assign({
    blocks: an.stats.blocks, roots: program.roots.length, functions: an.fns.size, variables: program.variables.length,
    events: program.events.length, lines: 0,
  }, summarize(list));
  if (!ok) {
    return { ok: false, mode: options.mode, policy: options.policy, source: null, sourceMap: null, diagnostics: list, skippedRoots: [], stats, reflection: Reflection.status() };
  }
  const out = emitProgram(program, an, options);
  stats.lines = out.sourceMap.lineToBlock.length;
  return {
    ok: true, mode: options.mode, policy: options.policy, source: out.source,
    sourceMap: options.sourceMap ? out.sourceMap : null, diagnostics: list, skippedRoots: out.skipped, stats,
    reflection: Reflection.status(),
  };
}

function validateSync(input, rawOptions) {
  const ctx = analyzeInput(input, rawOptions, false);
  if (ctx.failed) return ctx.failed;
  const { options, program, an, diags } = ctx;
  const list = diags.map(publicDiag);
  const sum = summarize(list);
  return {
    ok: sum.errors === 0, mode: options.mode, policy: options.policy, diagnostics: list,
    invalidRoots: Array.from(an.errorRoots.keys()).filter((k) => an.errorRoots.get(k) > 0),
    stats: Object.assign({ blocks: an.stats.blocks, roots: program.roots.length, functions: an.fns.size, variables: program.variables.length, events: program.events.length }, sum),
    reflection: Reflection.status(),
  };
}

function runtimeModuleSource() {
  return 'return function(...)\n' + runtimeSource() + '\nend\n';
}

async function warmReflection(ms) {
  if (Reflection.loaded) return true;
  let timer = null;
  const wait = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms || 3000);
  });
  try {
    return await Promise.race([Reflection.ensureLoaded(), wait]);
  } finally {
    clearTimeout(timer);
  }
}

async function compile(input, options) {
  await warmReflection();
  return compileSync(input, options);
}

async function validate(input, options) {
  await warmReflection();
  return validateSync(input, options);
}

function describeParams(list) {
  return list.map((p) => ({ name: p.name, type: p.typeText || T.fmt(p.type), optional: !!p.optional, variadic: !!p.variadic }));
}

function describeMembers(map, kind) {
  return Array.from(map.values()).map((m) => {
    if (kind === 'prop') return { name: m.name, type: T.fmt(m.type), readOnly: !!m.readOnly };
    if (kind === 'method') return { name: m.name, params: describeParams(m.params), returns: m.returns.map(T.fmt), yields: !!m.yields };
    return { name: m.name, params: describeParams(m.params) };
  });
}

function library() {
  const functions = Object.keys(LIB).map((id) => {
    const e = LIB[id];
    return {
      id,
      lua: e.lua,
      category: e.category,
      const: !!e.const,
      variants: e.variants.map((v) => ({ params: describeParams(v.params), returns: v.returns.map(T.fmt) })),
    };
  });
  const values = Object.keys(VALUE).map((name) => ({
    name,
    props: describeMembers(VALUE[name].props, 'prop'),
    methods: describeMembers(VALUE[name].methods, 'method'),
  }));
  return {
    functions,
    values,
    instance: {
      props: describeMembers(L.BASE.props, 'prop'),
      methods: describeMembers(L.BASE.methods, 'method'),
      events: describeMembers(L.BASE.events, 'event'),
    },
    blockedServices: L.DEFAULT_BLOCKED_SERVICES,
  };
}

function blocksCatalog() {
  return { version: VERSION, limits: LIMITS, ops: B.catalog() };
}

function reflect(className) {
  return Reflection.describeClass(className);
}

function inputFrom(body) {
  if (body.program !== undefined) return body.program;
  if (body.parts !== undefined) return body.parts;
  return body.encoded;
}

function register(app, express) {
  const ex = express || require('express');
  const router = ex.Router();
  router.use(ex.json({ limit: '8mb' }));

  const guarded = (fn) => async (req, res) => {
    try {
      const body = isPlainObject(req.body) ? req.body : {};
      res.json(await fn(body, req));
    } catch (err) {
      res.status(500).json({ ok: false, error: `The MOBI compiler failed unexpectedly: ${err && err.message ? err.message : String(err)}` });
    }
  };

  router.get('/status', (req, res) => {
    res.json({ ok: true, version: VERSION, operations: B.DEFS.size, reflection: Reflection.status() });
  });
  router.get('/blocks', (req, res) => {
    res.json(blocksCatalog());
  });
  router.get('/library', (req, res) => {
    res.json(library());
  });
  router.get('/runtime', (req, res) => {
    res.type('text/plain').send(req.query.format === 'module' ? runtimeModuleSource() : runtimeSource());
  });
  router.get('/reflect/:className', async (req, res) => {
    try {
      await warmReflection();
      const info = reflect(req.params.className);
      if (!info) {
        res.status(404).json({ ok: false, error: `Class '${req.params.className}' was not found, or Roblox API reflection data is unavailable.` });
        return;
      }
      res.json({ ok: true, class: info });
    } catch (err) {
      res.status(500).json({ ok: false, error: `The reflection lookup failed: ${err && err.message ? err.message : String(err)}` });
    }
  });
  router.post('/compile', guarded((body) => compile(inputFrom(body), body.options)));
  router.post('/validate', guarded((body) => validate(inputFrom(body), body.options)));
  router.post('/decode', guarded((body) => {
    const d = decode(inputFrom(body));
    return { ok: !!d.program && !d.blocked, program: d.program, diagnostics: d.diagnostics.map(publicDiag) };
  }));
  router.post('/encode', guarded((body) => {
    const d = decode(inputFrom(body));
    if (!d.program || d.blocked) return { ok: false, parts: [], diagnostics: d.diagnostics.map(publicDiag) };
    return { ok: true, parts: encode(d.program, body.options), diagnostics: d.diagnostics.map(publicDiag) };
  }));
  router.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ ok: false, error: status === 413 ? 'The request body exceeds the size limit.' : 'The request body could not be read as JSON.' });
  });
  app.use('/mobi', router);
  return router;
}

module.exports = {
  VERSION, LIMITS, compile, validate, compileSync, validateSync, decode, encode, blocksCatalog, library, reflect,
  register, runtimeSource, runtimeModuleSource, Reflection, DIAGS: L.DIAGS, RUNTIME_CODES: L.RUNTIME_CODES,
  _internal: { analyze, emitProgram, normalizeOptions, Emitter },
};
