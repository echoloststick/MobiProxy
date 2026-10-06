'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = { format: 1, lang: 1 };

const LIMITS = {
  blocks: 20000,
  roots: 500,
  depth: 60,
  variables: 500,
  nameLength: 40,
  locals: 180,
  listItems: 64,
  argc: 16,
};

const SUPPORTED_FEATURES = [];

const DEFAULT_BLOCKED_SERVICES = [
  'HttpService',
  'MessagingService',
  'DataStoreService',
  'MemoryStoreService',
  'TeleportService',
  'MarketplaceService',
  'BadgeService',
  'OpenCloudService',
  'AnalyticsService',
  'SocialService',
  'AvatarEditorService',
  'InsertService',
  'ContentProvider',
  'AssetService',
  'ScriptContext',
];

const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local',
  'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue', 'goto',
]);

const LUA_GLOBALS = [
  'game', 'workspace', 'script', 'math', 'string', 'table', 'task', 'os', 'utf8', 'bit32', 'coroutine',
  'debug', 'Instance', 'Enum', 'Vector2', 'Vector3', 'CFrame', 'Color3', 'UDim', 'UDim2', 'BrickColor',
  'TweenInfo', 'NumberRange', 'NumberSequence', 'ColorSequence', 'Rect', 'Ray', 'Region3', 'Random',
  'RaycastParams', 'OverlapParams', 'print', 'warn', 'error', 'assert', 'pcall', 'xpcall', 'tostring',
  'tonumber', 'type', 'typeof', 'pairs', 'ipairs', 'next', 'select', 'require', 'unpack', 'rawget',
  'rawset', 'rawequal', 'setmetatable', 'getmetatable', 'wait', 'spawn', 'delay', 'tick', 'time', 'Rt',
  'G', 'F', '_G', '_VERSION', 'shared', 'plugin', 'settings', 'stats', 'version', 'elapsedTime',
  '__mobi_main', '__mobi_runtime',
];

const RESERVED = new Set([...LUA_KEYWORDS, ...LUA_GLOBALS]);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isIdent(s) {
  return typeof s === 'string' && IDENT.test(s) && !LUA_KEYWORDS.has(s);
}

function quote(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 32 || c === 127) out += '\\' + String(c).padStart(3, '0');
    else out += ch;
  }
  return out + '"';
}

function sanitizeName(name, fallback) {
  let s = String(name == null ? '' : name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) s = fallback || 'value';
  if (/^[0-9]/.test(s)) s = '_' + s;
  return s;
}

function luaLiteral(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) return '{' + value.map(luaLiteral).join(', ') + '}';
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => {
    const key = /^\d+$/.test(k) ? '[' + k + ']' : '[' + quote(k) + ']';
    return key + ' = ' + luaLiteral(value[k]);
  });
  return '{' + parts.join(', ') + '}';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const DIAGS = {
  E1001: ['UnknownBlock', 'error', (d) => `Unknown block operation '${d.op}'. The block was preserved but cannot be compiled.`],
  E1002: ['MissingInput', 'error', (d) => `Required input '${d.slot}' is empty.`],
  E1003: ['UnknownSlot', 'error', (d) => `Slot '${d.slot}' is not defined for block '${d.op}'. The value was preserved but is ignored.`],
  E1004: ['DuplicateBlockId', 'error', (d) => `Block id '${d.id}' is used more than once.`],
  E1005: ['InvalidField', 'error', (d) => d.message || 'A field has an invalid value.'],
  E1006: ['BlockKindMismatch', 'error', (d) => d.message || 'This block cannot be placed here.'],
  E1007: ['DepthLimit', 'error', () => `Nesting depth exceeds the limit of ${LIMITS.depth}.`],
  E1008: ['LimitExceeded', 'error', (d) => d.message || 'A program limit was exceeded.'],
  E2001: ['TypeMismatch', 'error', (d) => d.message || `Expected ${d.expected} but got ${d.actual}.`],
  E2002: ['UnknownVariable', 'error', (d) => `Variable '${d.id}' does not exist.`],
  E2003: ['UnknownFunction', 'error', (d) => `Function '${d.id}' does not exist.`],
  E2004: ['DependencyInvalid', 'error', (d) => `Function '${d.name}' contains errors and cannot be called.`],
  E2005: ['InvalidReturn', 'error', (d) => d.message || 'The returned values do not match the function.'],
  E2006: ['ContextMismatch', 'error', (d) => `Block '${d.op}' is not available in the ${d.context} context.`],
  E2007: ['UnknownMember', 'error', (d) => `'${d.member}' is not a valid member of ${d.type}.`],
  E2008: ['ServiceBlocked', 'error', (d) => `Service '${d.service}' is blocked and cannot be used.`],
  E2009: ['ReadOnlyMember', 'error', (d) => `'${d.member}' is read-only and cannot be assigned.`],
  E2010: ['UnknownEvent', 'error', (d) => `Custom event '${d.id}' does not exist.`],
  E3001: ['UseBeforeDeclare', 'error', (d) => `Variable '${d.name}' is used before it is declared.`],
  E3002: ['OutOfScope', 'error', (d) => `Variable '${d.name}' is not accessible in this scope.`],
  E3003: ['BreakOutsideLoop', 'error', (d) => `'${d.what}' can only be used inside a loop.`],
  E3004: ['DuplicateName', 'error', (d) => `${d.what} name '${d.name}' is already in use.`],
  E3005: ['TooManyLocals', 'error', () => `A function cannot declare more than ${LIMITS.locals} local variables.`],
  E3006: ['FlowEscapesTry', 'error', (d) => `'${d.what}' cannot leave a 'try' block. Store the result in a variable and use it after the block.`],
  E4001: ['UnsupportedFormat', 'error', (d) => d.message || 'The program was created by a newer version of MOBI.'],
  E4002: ['CorruptData', 'error', (d) => `The program data could not be decoded: ${d.reason}.`],
  E4003: ['RequiresFeature', 'error', (d) => `The program requires an unsupported feature: ${d.feature}.`],
  W1001: ['FloatingBlock', 'info', (d) => `Floating block '${d.op}' is not part of any script and was ignored.`],
  W2001: ['NullableUse', 'warning', (d) => `A value that may be nil is used where ${d.type} is expected.`],
  W2002: ['ImplicitConversion', 'info', (d) => `A value of type ${d.type} was converted to text.`],
  W2003: ['UncheckedMember', 'warning', () => 'The class of this Instance could not be verified at compile time.'],
  W2004: ['AlwaysTruthy', 'warning', (d) => `A ${d.type} condition is always true in Luau.`],
  W2005: ['ReflectionUnavailable', 'info', () => 'Roblox API reflection data is unavailable. Members and types were not verified.'],
  W3001: ['UnusedVariable', 'warning', (d) => `Variable '${d.name}' is never read.`],
  W3002: ['UnreachableCode', 'warning', () => 'This block can never run because a previous block ends the flow.'],
  W3003: ['ShadowedName', 'warning', (d) => `Name '${d.name}' hides a variable from an outer scope.`],
  W3004: ['EmptyHandler', 'info', () => 'This handler has no blocks.'],
  W4001: ['DeprecatedBlock', 'warning', (d) => `Block '${d.op}' is deprecated${d.replacedBy ? `; use '${d.replacedBy}' instead` : ''}.`],
};

const RUNTIME_CODES = {
  R1001: 'NilAccess',
  R1002: 'ClassMismatch',
  R1003: 'InvalidMember',
  R1004: 'AssignFailed',
  R2001: 'ObjectNotFound',
  R2002: 'NilTarget',
  R2003: 'ServiceBlocked',
  R2004: 'ServiceUnavailable',
  R2005: 'InstanceCreateFailed',
  R3001: 'HandlerError',
};

function makeDiag(code, blockId, slot, data) {
  const entry = DIAGS[code];
  const d = data || {};
  return {
    code,
    name: entry[0],
    severity: entry[1],
    blockId: blockId || null,
    slot: slot || null,
    message: entry[2](d),
    data: d,
  };
}

const typeCache = new Map();
const mk = (k, extra) => Object.freeze(Object.assign({ k }, extra || {}));

const ANY = mk('any');
const NIL = mk('nil');
const BOOL = mk('boolean');
const NUM = mk('number');
const STR = mk('string');
const SIGNAL = mk('signal');
const CONN = mk('connection');

function opt(t) {
  if (!t || t.opt || t.k === 'any' || t.k === 'nil') return t;
  return Object.freeze(Object.assign({}, t, { opt: true }));
}

function strip(t) {
  if (!t || !t.opt) return t;
  const copy = Object.assign({}, t);
  delete copy.opt;
  return Object.freeze(copy);
}

function readName(p) {
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(p.s.slice(p.i));
  if (!m) throw new Error('name');
  p.i += m[0].length;
  return m[0];
}

function expectChar(p, ch) {
  if (p.s[p.i] !== ch) throw new Error('expected ' + ch);
  p.i += 1;
}

function parseType(p) {
  const name = readName(p);
  let t;
  switch (name) {
    case 'any': t = ANY; break;
    case 'nil': t = NIL; break;
    case 'boolean': t = BOOL; break;
    case 'number': t = NUM; break;
    case 'string': t = STR; break;
    case 'signal': t = SIGNAL; break;
    case 'connection': t = CONN; break;
    case 'Instance':
      if (p.s[p.i] === '<') {
        p.i += 1;
        const cls = readName(p);
        expectChar(p, '>');
        t = mk('instance', { cls });
      } else {
        t = mk('instance', { cls: null });
      }
      break;
    case 'Enum': {
      expectChar(p, '<');
      const en = readName(p);
      expectChar(p, '>');
      t = mk('enum', { name: en });
      break;
    }
    case 'list': {
      expectChar(p, '<');
      const el = parseType(p);
      expectChar(p, '>');
      t = mk('list', { el });
      break;
    }
    case 'dict': {
      expectChar(p, '<');
      const key = parseType(p);
      expectChar(p, ',');
      const val = parseType(p);
      expectChar(p, '>');
      t = mk('dict', { key, val });
      break;
    }
    case 'fn': {
      let params = null;
      let ret = null;
      if (p.s[p.i] === '(') {
        p.i += 1;
        params = [];
        if (p.s[p.i] !== ')') {
          params.push(parseType(p));
          while (p.s[p.i] === ',') {
            p.i += 1;
            params.push(parseType(p));
          }
        }
        expectChar(p, ')');
        if (p.s[p.i] === ':') {
          p.i += 1;
          ret = parseType(p);
        }
      }
      t = mk('fn', { params, ret });
      break;
    }
    default:
      t = mk('value', { name });
  }
  if (p.s[p.i] === '?') {
    p.i += 1;
    t = opt(t);
  }
  return t;
}

function parse(input) {
  if (input && typeof input === 'object' && input.k) return input;
  if (typeof input !== 'string') return null;
  if (typeCache.has(input)) return typeCache.get(input);
  const p = { s: input.replace(/\s+/g, ''), i: 0 };
  let t = null;
  try {
    t = parseType(p);
    if (p.i !== p.s.length) t = null;
  } catch (e) {
    t = null;
  }
  typeCache.set(input, t);
  return t;
}

function fmt(t) {
  if (!t) return 'any';
  let s;
  switch (t.k) {
    case 'instance': s = t.cls ? `Instance<${t.cls}>` : 'Instance'; break;
    case 'enum': s = `Enum<${t.name}>`; break;
    case 'list': s = `list<${fmt(t.el)}>`; break;
    case 'dict': s = `dict<${fmt(t.key)},${fmt(t.val)}>`; break;
    case 'fn':
      s = t.params ? `fn(${t.params.map(fmt).join(',')})${t.ret ? ':' + fmt(t.ret) : ''}` : 'fn';
      break;
    case 'value': s = t.name; break;
    default: s = t.k;
  }
  return t.opt ? s + '?' : s;
}

let classOracle = () => null;

function setClassOracle(fn) {
  classOracle = fn;
}

function baseAssignable(from, to) {
  if (from.k !== to.k) return { ok: false };
  switch (from.k) {
    case 'instance': {
      if (!to.cls) return { ok: true };
      if (!from.cls) return { ok: true, warn: 'W2003' };
      if (from.cls === to.cls) return { ok: true };
      const r = classOracle(from.cls, to.cls);
      if (r === true) return { ok: true };
      if (r === false) return { ok: false };
      return { ok: true, warn: 'W2003' };
    }
    case 'enum': return { ok: from.name === to.name };
    case 'value': return { ok: from.name === to.name };
    case 'list': {
      const r = assignable(from.el, to.el);
      return { ok: r.ok, warn: r.warn };
    }
    case 'dict': {
      const k = assignable(from.key, to.key);
      const v = assignable(from.val, to.val);
      return { ok: k.ok && v.ok, warn: k.warn || v.warn };
    }
    default: return { ok: true };
  }
}

function assignable(from, to) {
  if (!from || !to) return { ok: true };
  if (from.k === 'any' || to.k === 'any') return { ok: true };
  if (from.k === 'nil') return { ok: !!to.opt || to.k === 'nil' };
  if (to.k === 'nil') return { ok: false };
  const base = baseAssignable(strip(from), strip(to));
  if (!base.ok) return { ok: false };
  if (from.opt && !to.opt) return { ok: true, warn: 'W2001' };
  return base.warn ? { ok: true, warn: base.warn } : { ok: true };
}

function join(a, b) {
  if (!a || !b) return ANY;
  if (a.k === 'any' || b.k === 'any') return ANY;
  if (a.k === 'nil' && b.k === 'nil') return NIL;
  if (a.k === 'nil') return opt(b);
  if (b.k === 'nil') return opt(a);
  if (fmt(a) === fmt(b)) return a;
  const ab = assignable(a, b);
  if (ab.ok && !ab.warn) return b;
  const ba = assignable(b, a);
  if (ba.ok && !ba.warn) return a;
  const sa = strip(a);
  const sb = strip(b);
  if (fmt(sa) === fmt(sb)) return opt(sa);
  return ANY;
}

const ADDABLE = new Set(['Vector2', 'Vector3', 'UDim', 'UDim2']);
const VECS = new Set(['Vector2', 'Vector3']);

function arith(op, a, b) {
  if (a.k === 'any' || b.k === 'any') return ANY;
  if (a.k === 'number' && b.k === 'number') return NUM;
  const av = a.k === 'value' ? a.name : null;
  const bv = b.k === 'value' ? b.name : null;
  if (op === 'add' || op === 'sub') {
    if (av && av === bv && ADDABLE.has(av)) return a;
    if (av === 'CFrame' && bv === 'Vector3') return a;
    return null;
  }
  if (op === 'mul') {
    if (av && av === bv && (VECS.has(av) || av === 'CFrame')) return a;
    if (av === 'CFrame' && bv === 'Vector3') return b;
    if (av && VECS.has(av) && b.k === 'number') return a;
    if (bv && VECS.has(bv) && a.k === 'number') return b;
    return null;
  }
  if (op === 'div' || op === 'idiv') {
    if (av && av === bv && VECS.has(av)) return a;
    if (av && VECS.has(av) && b.k === 'number') return a;
    return null;
  }
  return null;
}

function orderable(a, b) {
  if (a.k === 'any' || b.k === 'any') return true;
  return (a.k === 'number' && b.k === 'number') || (a.k === 'string' && b.k === 'string');
}

function negate(a) {
  if (a.k === 'any') return ANY;
  if (a.k === 'number') return NUM;
  if (a.k === 'value' && VECS.has(a.name)) return a;
  return null;
}

function logicType(op, a, b) {
  if (op === 'and') {
    if (a.k === 'boolean' && b.k === 'boolean') return BOOL;
    return ANY;
  }
  if (a.k === 'boolean' && b.k === 'boolean') return BOOL;
  return join(strip(a), b);
}

const T = {
  ANY, NIL, BOOL, NUM, STR, SIGNAL, CONN,
  parse, fmt, opt, strip, assignable, join, mk, setClassOracle,
  arith, orderable, negate, logicType,
  instance: (cls) => mk('instance', { cls: cls || null }),
  list: (el) => mk('list', { el }),
  dict: (key, val) => mk('dict', { key, val }),
  enumOf: (name) => mk('enum', { name }),
  value: (name) => mk('value', { name }),
  fn: (params, ret) => mk('fn', { params: params || null, ret: ret || null }),
};

function parseParam(s) {
  const variadic = s.startsWith('...');
  const body = variadic ? s.slice(3) : s;
  const idx = body.indexOf(':');
  const name = body.slice(0, idx);
  const typeText = body.slice(idx + 1);
  return {
    name,
    type: T.parse(typeText) || ANY,
    typeText,
    optional: variadic || typeText.endsWith('?'),
    variadic,
  };
}

function parseReturns(list) {
  return list.map((r) => T.parse(r) || ANY);
}

const LIB = {};

function lib(id, variants, extra) {
  const entry = Object.assign({ id, lua: id, category: id.split('.')[0] }, extra || {});
  entry.variants = variants.map((v) => ({ params: v[0].map(parseParam), returns: parseReturns(v[1]) }));
  LIB[id] = entry;
}

function one(id, params, returns, extra) {
  lib(id, [[params, returns]], extra);
}

function con(id, type) {
  lib(id, [[[], [type]]], { const: true });
}

['abs', 'acos', 'asin', 'atan', 'ceil', 'cos', 'cosh', 'deg', 'exp', 'floor', 'log10', 'rad', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh'].forEach((n) => {
  one('math.' + n, ['x:number'], ['number']);
});
one('math.atan2', ['y:number', 'x:number'], ['number']);
one('math.clamp', ['x:number', 'min:number', 'max:number'], ['number']);
one('math.fmod', ['x:number', 'y:number'], ['number']);
one('math.log', ['x:number', 'base:number?'], ['number']);
one('math.max', ['a:number', '...rest:number'], ['number']);
one('math.min', ['a:number', '...rest:number'], ['number']);
one('math.modf', ['x:number'], ['number', 'number']);
one('math.noise', ['x:number', 'y:number?', 'z:number?'], ['number']);
one('math.pow', ['x:number', 'y:number'], ['number']);
lib('math.random', [[[], ['number']], [['m:number'], ['number']], [['m:number', 'n:number'], ['number']]]);
one('math.randomseed', ['seed:number'], []);
con('math.pi', 'number');
con('math.huge', 'number');

one('string.byte', ['s:string', 'i:number?', 'j:number?'], ['number']);
one('string.char', ['...codes:number'], ['string']);
one('string.find', ['s:string', 'pattern:string', 'init:number?', 'plain:boolean?'], ['number?', 'number?']);
one('string.format', ['format:string', '...values:any'], ['string']);
one('string.gsub', ['s:string', 'pattern:string', 'replacement:any'], ['string', 'number']);
one('string.len', ['s:string'], ['number']);
one('string.lower', ['s:string'], ['string']);
one('string.match', ['s:string', 'pattern:string', 'init:number?'], ['any']);
one('string.rep', ['s:string', 'n:number', 'sep:string?'], ['string']);
one('string.reverse', ['s:string'], ['string']);
one('string.split', ['s:string', 'separator:string?'], ['list<string>']);
one('string.sub', ['s:string', 'i:number', 'j:number?'], ['string']);
one('string.upper', ['s:string'], ['string']);
one('tostring', ['value:any'], ['string'], { category: 'convert' });
one('tonumber', ['value:any', 'base:number?'], ['number?'], { category: 'convert' });
one('typeof', ['value:any'], ['string'], { category: 'convert' });

one('table.concat', ['list:list<any>', 'separator:string?', 'i:number?', 'j:number?'], ['string']);
one('table.find', ['list:list<any>', 'value:any', 'init:number?'], ['number?']);
one('table.remove', ['list:list<any>', 'position:number?'], ['any']);
one('table.sort', ['list:list<any>', 'comparator:fn?'], []);
one('table.clear', ['table:any'], []);
one('table.clone', ['table:any'], ['any']);
one('table.unpack', ['list:list<any>', 'i:number?', 'j:number?'], ['any']);
one('table.create', ['count:number', 'value:any?'], ['list<any>']);

one('task.wait', ['seconds:number?'], ['number'], { lua: 'Rt.wait', category: 'task' });
one('task.spawn', ['callback:fn', '...args:any'], ['any'], { lua: 'Rt.spawn', category: 'task' });
one('task.defer', ['callback:fn', '...args:any'], ['any'], { lua: 'Rt.defer', category: 'task' });
one('task.delay', ['seconds:number', 'callback:fn', '...args:any'], ['any'], { lua: 'Rt.delay', category: 'task' });
one('task.cancel', ['thread:any'], [], { lua: 'Rt.cancel', category: 'task' });
one('os.time', ['time:dict<string,any>?'], ['number']);
one('os.clock', [], ['number']);
one('os.date', ['format:string?', 'time:number?'], ['string']);

one('utf8.char', ['...codes:number'], ['string']);
one('utf8.len', ['s:string', 'i:number?', 'j:number?'], ['number?']);

['band', 'bor', 'bxor'].forEach((n) => {
  one('bit32.' + n, ['a:number', '...rest:number'], ['number']);
});
one('bit32.bnot', ['x:number'], ['number']);
['lshift', 'rshift', 'arshift'].forEach((n) => {
  one('bit32.' + n, ['x:number', 'disp:number'], ['number']);
});
one('bit32.extract', ['n:number', 'field:number', 'width:number?'], ['number']);

lib('Vector3.new', [[[], ['Vector3']], [['x:number', 'y:number', 'z:number'], ['Vector3']]]);
['zero', 'one', 'xAxis', 'yAxis', 'zAxis'].forEach((n) => con('Vector3.' + n, 'Vector3'));
lib('Vector2.new', [[[], ['Vector2']], [['x:number', 'y:number'], ['Vector2']]]);
['zero', 'one', 'xAxis', 'yAxis'].forEach((n) => con('Vector2.' + n, 'Vector2'));
lib('CFrame.new', [
  [[], ['CFrame']],
  [['position:Vector3'], ['CFrame']],
  [['position:Vector3', 'lookAt:Vector3'], ['CFrame']],
  [['x:number', 'y:number', 'z:number'], ['CFrame']],
]);
one('CFrame.Angles', ['rx:number', 'ry:number', 'rz:number'], ['CFrame']);
one('CFrame.fromEulerAnglesXYZ', ['rx:number', 'ry:number', 'rz:number'], ['CFrame']);
one('CFrame.fromEulerAnglesYXZ', ['rx:number', 'ry:number', 'rz:number'], ['CFrame']);
one('CFrame.fromOrientation', ['rx:number', 'ry:number', 'rz:number'], ['CFrame']);
one('CFrame.fromAxisAngle', ['axis:Vector3', 'angle:number'], ['CFrame']);
one('CFrame.lookAt', ['at:Vector3', 'lookAt:Vector3', 'up:Vector3?'], ['CFrame']);
con('CFrame.identity', 'CFrame');
lib('Color3.new', [[[], ['Color3']], [['r:number', 'g:number', 'b:number'], ['Color3']]]);
one('Color3.fromRGB', ['r:number', 'g:number', 'b:number'], ['Color3']);
one('Color3.fromHSV', ['h:number', 's:number', 'v:number'], ['Color3']);
one('Color3.fromHex', ['hex:string'], ['Color3']);
one('UDim.new', ['scale:number', 'offset:number'], ['UDim']);
lib('UDim2.new', [
  [[], ['UDim2']],
  [['xScale:number', 'xOffset:number', 'yScale:number', 'yOffset:number'], ['UDim2']],
  [['x:UDim', 'y:UDim'], ['UDim2']],
]);
one('UDim2.fromScale', ['x:number', 'y:number'], ['UDim2']);
one('UDim2.fromOffset', ['x:number', 'y:number'], ['UDim2']);
lib('BrickColor.new', [[['name:string'], ['BrickColor']], [['number:number'], ['BrickColor']], [['r:number', 'g:number', 'b:number'], ['BrickColor']]]);
one('BrickColor.Random', [], ['BrickColor']);
one('TweenInfo.new', ['time:number?', 'easingStyle:Enum<EasingStyle>?', 'easingDirection:Enum<EasingDirection>?', 'repeatCount:number?', 'reverses:boolean?', 'delayTime:number?'], ['TweenInfo']);
lib('NumberRange.new', [[['value:number'], ['NumberRange']], [['min:number', 'max:number'], ['NumberRange']]]);
lib('NumberSequence.new', [[['value:number'], ['NumberSequence']], [['start:number', 'finish:number'], ['NumberSequence']]]);
lib('ColorSequence.new', [[['color:Color3'], ['ColorSequence']], [['start:Color3', 'finish:Color3'], ['ColorSequence']]]);
lib('Rect.new', [[['minX:number', 'minY:number', 'maxX:number', 'maxY:number'], ['Rect']], [['min:Vector2', 'max:Vector2'], ['Rect']]]);
one('Ray.new', ['origin:Vector3', 'direction:Vector3'], ['Ray']);
one('Region3.new', ['min:Vector3', 'max:Vector3'], ['Region3']);
one('Random.new', ['seed:number?'], ['Random']);
one('RaycastParams.new', [], ['RaycastParams']);
one('OverlapParams.new', [], ['OverlapParams']);

const VALUE = {};

function defineValue(name, spec) {
  const entry = { name, props: new Map(), methods: new Map() };
  Object.keys(spec.props || {}).forEach((p) => {
    entry.props.set(p, { kind: 'prop', name: p, type: T.parse(spec.props[p]) || ANY, readOnly: !spec.writable });
  });
  Object.keys(spec.methods || {}).forEach((m) => {
    const sig = spec.methods[m];
    entry.methods.set(m, { kind: 'method', name: m, params: sig[0].map(parseParam), returns: parseReturns(sig[1]), yields: false });
  });
  VALUE[name] = entry;
}

defineValue('Vector3', {
  props: { X: 'number', Y: 'number', Z: 'number', Magnitude: 'number', Unit: 'Vector3' },
  methods: {
    Dot: [['other:Vector3'], ['number']],
    Cross: [['other:Vector3'], ['Vector3']],
    Lerp: [['goal:Vector3', 'alpha:number'], ['Vector3']],
    Angle: [['other:Vector3', 'axis:Vector3?'], ['number']],
    FuzzyEq: [['other:Vector3', 'epsilon:number?'], ['boolean']],
    Max: [['other:Vector3'], ['Vector3']],
    Min: [['other:Vector3'], ['Vector3']],
    Abs: [[], ['Vector3']],
    Ceil: [[], ['Vector3']],
    Floor: [[], ['Vector3']],
    Sign: [[], ['Vector3']],
  },
});
defineValue('Vector2', {
  props: { X: 'number', Y: 'number', Magnitude: 'number', Unit: 'Vector2' },
  methods: {
    Dot: [['other:Vector2'], ['number']],
    Cross: [['other:Vector2'], ['number']],
    Lerp: [['goal:Vector2', 'alpha:number'], ['Vector2']],
    Angle: [['other:Vector2', 'isSigned:boolean?'], ['number']],
    Max: [['other:Vector2'], ['Vector2']],
    Min: [['other:Vector2'], ['Vector2']],
    Abs: [[], ['Vector2']],
    Ceil: [[], ['Vector2']],
    Floor: [[], ['Vector2']],
    Sign: [[], ['Vector2']],
  },
});
defineValue('CFrame', {
  props: {
    Position: 'Vector3', X: 'number', Y: 'number', Z: 'number', LookVector: 'Vector3', RightVector: 'Vector3',
    UpVector: 'Vector3', Rotation: 'CFrame',
  },
  methods: {
    Inverse: [[], ['CFrame']],
    Lerp: [['goal:CFrame', 'alpha:number'], ['CFrame']],
    ToWorldSpace: [['cf:CFrame'], ['CFrame']],
    ToObjectSpace: [['cf:CFrame'], ['CFrame']],
    PointToWorldSpace: [['v:Vector3'], ['Vector3']],
    PointToObjectSpace: [['v:Vector3'], ['Vector3']],
    VectorToWorldSpace: [['v:Vector3'], ['Vector3']],
    VectorToObjectSpace: [['v:Vector3'], ['Vector3']],
    GetComponents: [[], ['any']],
    ToEulerAnglesXYZ: [[], ['any']],
    ToEulerAnglesYXZ: [[], ['any']],
    ToOrientation: [[], ['any']],
    Orthonormalize: [[], ['CFrame']],
  },
});
defineValue('Color3', {
  props: { R: 'number', G: 'number', B: 'number' },
  methods: {
    Lerp: [['goal:Color3', 'alpha:number'], ['Color3']],
    ToHSV: [[], ['any']],
    ToHex: [[], ['string']],
  },
});
defineValue('UDim', { props: { Scale: 'number', Offset: 'number' }, methods: {} });
defineValue('UDim2', {
  props: { X: 'UDim', Y: 'UDim', Width: 'UDim', Height: 'UDim' },
  methods: { Lerp: [['goal:UDim2', 'alpha:number'], ['UDim2']] },
});
defineValue('BrickColor', {
  props: { Name: 'string', Number: 'number', Color: 'Color3', r: 'number', g: 'number', b: 'number' },
  methods: {},
});
defineValue('TweenInfo', {
  props: {
    Time: 'number', EasingStyle: 'Enum<EasingStyle>', EasingDirection: 'Enum<EasingDirection>',
    RepeatCount: 'number', Reverses: 'boolean', DelayTime: 'number',
  },
  methods: {},
});
defineValue('NumberRange', { props: { Min: 'number', Max: 'number' }, methods: {} });
defineValue('Rect', { props: { Min: 'Vector2', Max: 'Vector2', Width: 'number', Height: 'number' }, methods: {} });
defineValue('Ray', {
  props: { Origin: 'Vector3', Direction: 'Vector3', Unit: 'Ray' },
  methods: { ClosestPoint: [['point:Vector3'], ['Vector3']], Distance: [['point:Vector3'], ['number']] },
});
defineValue('Region3', { props: { CFrame: 'CFrame', Size: 'Vector3' }, methods: {} });
defineValue('Random', {
  props: {},
  methods: {
    NextNumber: [['min:number?', 'max:number?'], ['number']],
    NextInteger: [['min:number', 'max:number'], ['number']],
    NextUnitVector: [[], ['Vector3']],
    Shuffle: [['list:list<any>'], []],
    Clone: [[], ['Random']],
  },
});
defineValue('RaycastResult', {
  props: {
    Instance: 'Instance?', Position: 'Vector3', Normal: 'Vector3', Material: 'Enum<Material>', Distance: 'number',
  },
  methods: {},
});
defineValue('RaycastParams', {
  writable: true,
  props: {
    FilterDescendantsInstances: 'list<Instance>', FilterType: 'Enum<RaycastFilterType>', IgnoreWater: 'boolean',
    CollisionGroup: 'string', RespectCanCollide: 'boolean', BruteForceAllSlow: 'boolean',
  },
  methods: {},
});
defineValue('OverlapParams', {
  writable: true,
  props: {
    FilterDescendantsInstances: 'list<Instance>', FilterType: 'Enum<RaycastFilterType>', MaxParts: 'number',
    CollisionGroup: 'string', RespectCanCollide: 'boolean',
  },
  methods: {},
});
defineValue('connection', {
  props: { Connected: 'boolean' },
  methods: { Disconnect: [[], []] },
});

const BASE = { props: new Map(), methods: new Map(), events: new Map() };

function baseProp(name, type, readOnly) {
  BASE.props.set(name, { kind: 'prop', name, type: T.parse(type), readOnly: !!readOnly });
}

function baseMethod(name, params, returns, yields) {
  BASE.methods.set(name, { kind: 'method', name, params: params.map(parseParam), returns: parseReturns(returns), yields: !!yields });
}

function baseEvent(name, params) {
  BASE.events.set(name, { kind: 'event', name, params: params.map(parseParam) });
}

baseProp('Name', 'string');
baseProp('Parent', 'Instance?');
baseProp('ClassName', 'string', true);
baseProp('Archivable', 'boolean');
baseMethod('Destroy', [], []);
baseMethod('Clone', [], ['Instance?']);
baseMethod('ClearAllChildren', [], []);
baseMethod('FindFirstChild', ['name:string', 'recursive:boolean?'], ['Instance?']);
baseMethod('FindFirstChildOfClass', ['className:string'], ['Instance?']);
baseMethod('FindFirstChildWhichIsA', ['className:string', 'recursive:boolean?'], ['Instance?']);
baseMethod('FindFirstAncestor', ['name:string'], ['Instance?']);
baseMethod('FindFirstAncestorOfClass', ['className:string'], ['Instance?']);
baseMethod('FindFirstAncestorWhichIsA', ['className:string'], ['Instance?']);
baseMethod('FindFirstDescendant', ['name:string'], ['Instance?']);
baseMethod('GetChildren', [], ['list<Instance>']);
baseMethod('GetDescendants', [], ['list<Instance>']);
baseMethod('GetFullName', [], ['string']);
baseMethod('GetAttribute', ['name:string'], ['any']);
baseMethod('SetAttribute', ['name:string', 'value:any'], []);
baseMethod('GetAttributes', [], ['dict<string,any>']);
baseMethod('IsA', ['className:string'], ['boolean']);
baseMethod('IsDescendantOf', ['ancestor:Instance'], ['boolean']);
baseMethod('IsAncestorOf', ['descendant:Instance'], ['boolean']);
baseMethod('WaitForChild', ['name:string', 'timeout:number?'], ['Instance?'], true);
baseMethod('GetPropertyChangedSignal', ['property:string'], ['signal']);
baseMethod('GetAttributeChangedSignal', ['attribute:string'], ['signal']);
baseMethod('AddTag', ['tag:string'], []);
baseMethod('RemoveTag', ['tag:string'], []);
baseMethod('HasTag', ['tag:string'], ['boolean']);
baseMethod('GetTags', [], ['list<string>']);
baseEvent('Changed', ['property:string']);
baseEvent('ChildAdded', ['child:Instance']);
baseEvent('ChildRemoved', ['child:Instance']);
baseEvent('DescendantAdded', ['descendant:Instance']);
baseEvent('DescendantRemoving', ['descendant:Instance']);
baseEvent('AncestryChanged', ['child:Instance', 'parent:Instance?']);
baseEvent('Destroying', []);
baseEvent('AttributeChanged', ['attribute:string']);

const LITERAL_RETURNS = {
  FindFirstChildOfClass: (c) => T.opt(T.instance(c)),
  FindFirstChildWhichIsA: (c) => T.opt(T.instance(c)),
  FindFirstAncestorOfClass: (c) => T.opt(T.instance(c)),
  FindFirstAncestorWhichIsA: (c) => T.opt(T.instance(c)),
  GetService: (c) => T.instance(c),
};

const NONNULL_RETURNS = new Set(['GetService']);

const R = {
  loaded: false,
  version: null,
  source: null,
  classes: new Map(),
  enums: new Map(),
  index: { props: new Map(), methods: new Map(), events: new Map() },
};

const KIND_KEY = { prop: 'props', method: 'methods', event: 'events' };

function secOk(sec, which) {
  if (!sec) return true;
  if (typeof sec === 'string') return sec === 'None';
  return (sec[which] || 'None') === 'None';
}

function tagList(tags) {
  return Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
}

function mapDumpType(vt, nullable) {
  if (!vt) return ANY;
  const cat = vt.Category;
  const name = vt.Name;
  let t = ANY;
  if (cat === 'Primitive') {
    if (name === 'bool') t = BOOL;
    else if (name === 'string') t = STR;
    else if (name === 'int' || name === 'int64' || name === 'float' || name === 'double') t = NUM;
    else if (name === 'void' || name === 'null') return null;
  } else if (cat === 'Class') {
    t = T.instance(name === 'Instance' || name === 'Object' ? null : name);
    if (nullable) t = T.opt(t);
  } else if (cat === 'Enum') {
    t = T.enumOf(name);
  } else if (cat === 'DataType' || cat === 'Group') {
    if (name === 'Objects') t = T.list(T.instance(null));
    else if (name === 'Array') t = T.list(ANY);
    else if (name === 'Dictionary' || name === 'Map') t = T.dict(STR, ANY);
    else if (name === 'Variant' || name === 'Tuple') t = ANY;
    else if (name === 'Content') t = STR;
    else if (name === 'Function') t = T.fn(null, null);
    else if (name === 'RBXScriptSignal') t = SIGNAL;
    else if (name === 'RBXScriptConnection') t = CONN;
    else if (cat === 'DataType') t = T.value(name);
  }
  return t;
}

function indexMember(kind, cls, member) {
  const map = R.index[KIND_KEY[kind]];
  if (!map.has(member.name)) map.set(member.name, []);
  map.get(member.name).push({ cls, member });
}

function loadDump(json, source) {
  if (!json || !Array.isArray(json.Classes)) throw new Error('The API dump has an unexpected format.');
  const classes = new Map();
  const index = { props: new Map(), methods: new Map(), events: new Map() };
  R.index = index;
  json.Classes.forEach((c) => {
    const entry = {
      name: c.Name,
      superclass: c.Superclass && c.Superclass !== '<<<ROOT>>>' ? c.Superclass : null,
      tags: new Set(tagList(c.Tags)),
      props: new Map(),
      methods: new Map(),
      events: new Map(),
    };
    (c.Members || []).forEach((m) => {
      const tags = tagList(m.Tags);
      if (tags.includes('NotScriptable')) return;
      if (m.MemberType === 'Property') {
        if (!secOk(m.Security, 'Read')) return;
        const readOnly = tags.includes('ReadOnly') || !secOk(m.Security, 'Write');
        const member = { kind: 'prop', name: m.Name, type: mapDumpType(m.ValueType, true) || ANY, readOnly };
        entry.props.set(m.Name, member);
        indexMember('prop', c.Name, member);
      } else if (m.MemberType === 'Function') {
        if (!secOk(m.Security, 'Read')) return;
        const ret = mapDumpType(m.ReturnType, !NONNULL_RETURNS.has(m.Name));
        const params = (m.Parameters || []).map((p) => {
          const optional = p.Default !== undefined;
          const pt = mapDumpType(p.Type, false) || ANY;
          return { name: p.Name, type: optional ? T.opt(pt) : pt, typeText: T.fmt(pt), optional, variadic: false };
        });
        const member = { kind: 'method', name: m.Name, params, returns: ret ? [ret] : [], yields: tags.includes('Yields') };
        entry.methods.set(m.Name, member);
        indexMember('method', c.Name, member);
      } else if (m.MemberType === 'Event') {
        if (!secOk(m.Security, 'Read')) return;
        const params = (m.Parameters || []).map((p) => ({
          name: p.Name, type: mapDumpType(p.Type, false) || ANY, optional: false, variadic: false,
        }));
        const member = { kind: 'event', name: m.Name, params };
        entry.events.set(m.Name, member);
        indexMember('event', c.Name, member);
      }
    });
    classes.set(c.Name, entry);
  });
  const enums = new Map();
  (json.Enums || []).forEach((e) => {
    enums.set(e.Name, new Set((e.Items || []).map((i) => i.Name)));
  });
  R.classes = classes;
  R.enums = enums;
  R.loaded = true;
  R.source = source || null;
  R.version = json.Version !== undefined ? String(json.Version) : null;
  return { classes: classes.size, enums: enums.size };
}

function unload() {
  R.loaded = false;
  R.classes = new Map();
  R.enums = new Map();
  R.index = { props: new Map(), methods: new Map(), events: new Map() };
  R.source = null;
}

function chainFind(clsName, kind, name) {
  let c = R.classes.get(clsName);
  let guard = 0;
  while (c && guard < 64) {
    const m = c[KIND_KEY[kind]].get(name);
    if (m) return m;
    c = c.superclass ? R.classes.get(c.superclass) : null;
    guard += 1;
  }
  return null;
}

function isA(a, b) {
  if (!a || !b) return null;
  if (a === b || b === 'Instance') return true;
  if (!R.loaded) return null;
  let c = R.classes.get(a);
  if (!c) return null;
  let guard = 0;
  while (c && guard < 64) {
    if (c.name === b) return true;
    c = c.superclass ? R.classes.get(c.superclass) : null;
    guard += 1;
  }
  return false;
}

T.setClassOracle(isA);

function unify(entries) {
  const first = entries[0].member;
  if (first.kind !== 'prop') return Object.assign({ union: true }, first);
  const same = entries.every((e) => T.fmt(e.member.type) === T.fmt(first.type));
  return {
    kind: 'prop',
    name: first.name,
    type: same ? first.type : ANY,
    readOnly: entries.every((e) => e.member.readOnly),
    union: true,
  };
}

function member(type, name, kind) {
  if (!type) return { status: 'unknown' };
  if (type.k === 'value') {
    const v = VALUE[type.name];
    if (!v) return { status: 'unknown' };
    const m = (kind === 'prop' ? v.props : v.methods).get(name);
    return m ? { status: 'ok', info: m } : { status: 'missing' };
  }
  if (type.k === 'connection') {
    const v = VALUE.connection;
    const m = (kind === 'prop' ? v.props : v.methods).get(name);
    return m ? { status: 'ok', info: m } : { status: 'missing' };
  }
  if (type.k !== 'instance') return { status: 'missing' };
  const key = KIND_KEY[kind];
  if (type.cls && R.loaded) {
    if (!R.classes.has(type.cls)) return { status: 'unknown' };
    const m = chainFind(type.cls, kind, name);
    return m ? { status: 'ok', info: m } : { status: 'missing' };
  }
  const base = BASE[key].get(name);
  if (type.cls && !R.loaded) return base ? { status: 'ok', info: base } : { status: 'unknown' };
  if (base) return { status: 'ok', info: base };
  if (!R.loaded) return { status: 'unknown' };
  const entries = R.index[key].get(name);
  if (!entries || entries.length === 0) return { status: 'missing' };
  return { status: 'union', info: unify(entries) };
}

function classKnown(name) {
  if (!R.loaded) return null;
  return R.classes.has(name);
}

function creatable(name) {
  if (!R.loaded) return null;
  const c = R.classes.get(name);
  return !!c && !c.tags.has('NotCreatable') && !c.tags.has('Service');
}

function isService(name) {
  if (!R.loaded) return null;
  const c = R.classes.get(name);
  return !!c && c.tags.has('Service');
}

function enumItems(name) {
  if (!R.loaded) return null;
  return R.enums.get(name) || null;
}

function describeClass(name) {
  if (!R.loaded) return null;
  const start = R.classes.get(name);
  if (!start) return null;
  const out = { name, superclass: start.superclass, tags: Array.from(start.tags), props: [], methods: [], events: [] };
  let c = start;
  let guard = 0;
  while (c && guard < 64) {
    c.props.forEach((m) => out.props.push({ name: m.name, type: T.fmt(m.type), readOnly: m.readOnly, from: c.name }));
    c.methods.forEach((m) => out.methods.push({
      name: m.name,
      params: m.params.map((p) => ({ name: p.name, type: T.fmt(p.type), optional: p.optional })),
      returns: m.returns.map(T.fmt),
      yields: m.yields,
      from: c.name,
    }));
    c.events.forEach((m) => out.events.push({
      name: m.name,
      params: m.params.map((p) => ({ name: p.name, type: T.fmt(p.type) })),
      from: c.name,
    }));
    c = c.superclass ? R.classes.get(c.superclass) : null;
    guard += 1;
  }
  return out;
}

function status() {
  return { loaded: R.loaded, source: R.source, version: R.version, classes: R.classes.size, enums: R.enums.size };
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

let loading = null;
let lastFailure = 0;

async function loadFromSources(options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 25000;
  const local = opts.file || path.join(__dirname, 'api-dump.json');
  if (fs.existsSync(local)) {
    loadDump(JSON.parse(fs.readFileSync(local, 'utf8')), 'file');
    return true;
  }
  const urls = [];
  if (process.env.MOBI_API_DUMP_URL) urls.push(process.env.MOBI_API_DUMP_URL);
  try {
    const version = await fetchText('https://setup.rbxcdn.com/versionQTStudio', 8000);
    if (/^version-/.test(version)) urls.push(`https://setup.rbxcdn.com/${version}-Full-API-Dump.json`);
  } catch (e) {
    urls.push();
  }
  urls.push('https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Full-API-Dump.json');
  for (const url of urls) {
    try {
      loadDump(await fetchJson(url, timeoutMs), url);
      return true;
    } catch (e) {
      continue;
    }
  }
  return false;
}

async function ensureLoaded(options) {
  if (R.loaded) return true;
  const forced = !!(options && (options.file || options.force));
  if (!forced && Date.now() - lastFailure < 60000) return false;
  if (!loading) {
    loading = loadFromSources(options)
      .then((ok) => {
        if (!ok) lastFailure = Date.now();
        return ok;
      })
      .catch(() => {
        lastFailure = Date.now();
        return false;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

const Reflection = {
  member, isA, classKnown, creatable, isService, enumItems, describeClass, status,
  loadDump, unload, ensureLoaded,
  get loaded() {
    return R.loaded;
  },
  classNames: () => Array.from(R.classes.keys()).sort(),
};

module.exports = {
  VERSION, LIMITS, SUPPORTED_FEATURES, DEFAULT_BLOCKED_SERVICES, RESERVED, LUA_KEYWORDS,
  isIdent, quote, sanitizeName, luaLiteral, isPlainObject,
  DIAGS, RUNTIME_CODES, makeDiag,
  T, LIB, VALUE, BASE, LITERAL_RETURNS, Reflection,
};
