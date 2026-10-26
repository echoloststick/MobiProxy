const lib = require('./library');

const STRING_RET = new Set(['ToString', 'Substring', 'ToUpper', 'ToLower', 'Trim', 'TrimStart', 'TrimEnd', 'Replace', 'PadLeft', 'PadRight', 'Join', 'Format', 'Concat', 'ToUpperInvariant', 'ToLowerInvariant', 'GetFullName']);
const BOOL_RET = new Set(['Contains', 'StartsWith', 'EndsWith', 'ContainsKey', 'ContainsValue', 'IsNullOrEmpty', 'IsNullOrWhiteSpace', 'Any', 'All', 'IsA', 'GetKey', 'GetKeyDown', 'GetKeyUp', 'GetMouseButton', 'GetMouseButtonDown', 'Raycast']);
const INT_RET = new Set(['IndexOf', 'LastIndexOf', 'Count', 'FloorToInt', 'CeilToInt', 'RoundToInt', 'GetChildCount', 'ToInt32', 'ToInt64']);
const LIST_RET = new Set(['GetChildren', 'GetDescendants', 'GetPlayers', 'GetPartBoundsInBox', 'GetPartBoundsInRadius', 'GetTouchingParts', 'GetPartsInPart', 'ToArray', 'ToList', 'Where', 'Select', 'OrderBy', 'OrderByDescending', 'Take', 'Skip', 'Distinct', 'Split', 'GetComponents', 'GetComponentsInChildren', 'FindObjectsOfType', 'ToCharArray']);

const methods = {
	kind(e) {
		if (!e) {
			return { k: 'any' };
		}
		switch (e.k) {
			case 'num':
				return { k: e.float ? 'float' : 'int' };
			case 'str':
				return { k: e.chr ? 'char' : 'string' };
			case 'istr':
				return { k: 'string' };
			case 'bool':
				return { k: 'bool' };
			case 'paren':
				return this.kind(e.e);
			case 'id': {
				const loc = this.lookup(e.name);
				if (loc) {
					return loc.kind;
				}
				if (this.cls) {
					const f = this.findMember(this.cls, e.name);
					if (f) {
						return f.m.kind;
					}
				}
				return this.classes.has(e.name) ? { k: 'class', name: e.name, isStatic: true } : { k: 'any' };
			}
			case 'this':
				return this.cls ? { k: 'class', name: this.cls.name } : { k: 'any' };
			case 'member':
				return this.memberKind(e);
			case 'index': {
				const ok = this.kind(e.obj);
				if (ok.k === 'list') {
					return ok.elem || { k: 'any' };
				}
				if (ok.k === 'dict') {
					return ok.val || { k: 'any' };
				}
				return ok.k === 'string' ? { k: 'char' } : { k: 'any' };
			}
			case 'call':
				return this.callKind(e);
			case 'bin':
				return this.binKind(e);
			case 'un':
				return e.op === '!' ? { k: 'bool' } : this.kind(e.e);
			case 'pre':
			case 'post':
				return this.kind(e.e);
			case 'assign':
				return this.kind(e.l);
			case 'cond':
				return this.kind(e.a);
			case 'cast':
				return lib.typeKind(e.type);
			case 'as':
				return lib.typeKind(e.type);
			case 'is':
				return { k: 'bool' };
			case 'new':
				return e.type ? lib.typeKind(e.type) : { k: 'any' };
			case 'newArr':
				return { k: 'list', elem: e.elem ? lib.typeKind({ n: e.elem.n, a: e.elem.a, arr: Math.max(e.elem.arr, 0) }) : { k: 'any' } };
			default:
				return { k: 'any' };
		}
	},

	memberKind(e) {
		const ok = e.obj ? this.kind(e.obj) : { k: 'any' };
		if (ok.k === 'class' && this.classes.has(ok.name)) {
			const f = this.findMember(this.classes.get(ok.name), e.name);
			if (f) {
				return f.m.kind;
			}
		}
		if (e.name === 'Length' || e.name === 'Count') {
			return { k: 'int' };
		}
		if (ok.k === 'dict' && e.name === 'Keys') {
			return { k: 'list', elem: ok.key };
		}
		if (ok.k === 'dict' && e.name === 'Values') {
			return { k: 'list', elem: ok.val };
		}
		if (['x', 'y', 'z', 'magnitude', 'deltaTime', 'time', 'X', 'Y', 'Z', 'Magnitude'].includes(e.name)) {
			return { k: 'float' };
		}
		return { k: 'any' };
	},

	callKind(e) {
		const f = e.fn;
		if (f.k === 'id' || (f.k === 'member' && f.obj && (f.obj.k === 'this'))) {
			const m = this.cls ? this.findMember(this.cls, f.name) : null;
			if (m && m.m.k === 'method') {
				return m.m.kind;
			}
		}
		if (f.k === 'member' && f.obj && f.obj.k === 'id' && this.classes.has(f.obj.name)) {
			const m = this.findMember(this.classes.get(f.obj.name), f.name);
			if (m && m.m.k === 'method') {
				return m.m.kind;
			}
		}
		const name = f.name;
		const objName = f.k === 'member' && f.obj && f.obj.k === 'id' ? f.obj.name : null;
		if (objName === 'Mathf' || objName === 'Math') {
			if (INT_RET.has(name)) {
				return { k: 'int' };
			}
			if (name === 'Abs' || name === 'Max' || name === 'Min' || name === 'Sign') {
				const ks = e.args.map((a) => this.kind(a.e).k);
				return { k: ks.every((k) => k === 'int') ? 'int' : 'float' };
			}
			return { k: 'float' };
		}
		if (objName === 'Random' && name === 'Range') {
			const ks = e.args.map((a) => this.kind(a.e).k);
			return { k: ks.every((k) => k === 'int') ? 'int' : 'float' };
		}
		if (objName === 'Vector3' && ['Distance', 'Dot', 'Angle'].includes(name)) {
			return { k: 'float' };
		}
		if (objName === 'int' || objName === 'Int32') {
			return { k: 'int' };
		}
		if (objName === 'float' || objName === 'double') {
			return { k: 'float' };
		}
		if (STRING_RET.has(name)) {
			return { k: 'string' };
		}
		if (BOOL_RET.has(name)) {
			return { k: 'bool' };
		}
		if (INT_RET.has(name)) {
			return { k: 'int' };
		}
		if (LIST_RET.has(name)) {
			return { k: 'list', elem: name === 'Split' ? { k: 'string' } : { k: 'any' } };
		}
		return { k: 'any' };
	},

	binKind(e) {
		if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(e.op)) {
			return { k: 'bool' };
		}
		const a = this.kind(e.l);
		const b = this.kind(e.r);
		if (e.op === '??') {
			return a.k === 'any' ? b : a;
		}
		if (e.op === '+' && (a.k === 'string' || b.k === 'string' || a.k === 'char' && b.k === 'string')) {
			return { k: 'string' };
		}
		if (a.k === 'int' && b.k === 'int') {
			return { k: 'int' };
		}
		if ((a.k === 'int' || a.k === 'float') && (b.k === 'int' || b.k === 'float')) {
			return { k: 'float' };
		}
		if (a.k === 'bool' && b.k === 'bool') {
			return { k: 'bool' };
		}
		return a.k !== 'any' && b.k === 'any' ? a : { k: 'any' };
	},
};

module.exports = methods;
