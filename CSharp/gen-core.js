const { CSError } = require('./lexer');
const lib = require('./library');

const ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\0': '\\0', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\x07': '\\a' };

function luaString(s) {
	return '"' + String(s).replace(/[\\"\n\r\t\0\b\f\v\x07]/g, (c) => ESC[c]) + '"';
}

function luaNumber(n) {
	if (n === Infinity) {
		return 'math.huge';
	}
	return String(n);
}

function unparen(s) {
	if (s[0] !== '(' || s[s.length - 1] !== ')') {
		return s;
	}
	let depth = 0;
	let inStr = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (c === '\\') {
				i += 1;
			} else if (c === '"') {
				inStr = false;
			}
			continue;
		}
		if (c === '"') {
			inStr = true;
		} else if (c === '(') {
			depth += 1;
		} else if (c === ')') {
			depth -= 1;
			if (depth === 0 && i < s.length - 1) {
				return s;
			}
		}
	}
	return s.slice(1, -1);
}

class Gen {
	constructor(unit, options) {
		this.unit = unit;
		this.opt = options || {};
		this.out = [];
		this.closers = [];
		this.diags = [];
		this.scopes = [];
		this.classes = new Map();
		this.cls = null;
		this.fn = null;
		this.pre = [];
		this.uid = 0;
	}

	err(msg, node, code) {
		const line = (node && node.line) || this.curLine || 0;
		throw new CSError(msg, line, (node && node.col) || 0, code || 'CS8000');
	}

	warn(msg, node, code) {
		this.diags.push({ code: code || 'CSW001', severity: 'warning', message: msg, line: (node && node.line) || this.curLine || 0, column: 0 });
	}

	tmp(prefix) {
		this.uid += 1;
		return `__${prefix || 't'}${this.uid}`;
	}

	line(text, cs) {
		const indent = '\t'.repeat(this.closers.length);
		for (const part of text.split('\n')) {
			this.out.push({ text: part === '' ? '' : indent + part, cs: cs || this.curLine || 0 });
		}
	}

	open(header, closer, cs) {
		this.line(header, cs);
		this.closers.push(closer || 'end');
	}

	close() {
		const c = this.closers.pop();
		this.line(c);
	}

	capture(fn) {
		const savedOut = this.out;
		const savedClosers = this.closers;
		this.out = [];
		this.closers = [];
		try {
			fn();
			return this.out.map((l) => l.text).join('\n');
		} finally {
			this.out = savedOut;
			this.closers = savedClosers;
		}
	}

	push() {
		this.scopes.push(new Map());
	}

	pop() {
		this.scopes.pop();
	}

	declare(name, kind, lua) {
		this.scopes[this.scopes.length - 1].set(name, { kind: kind || { k: 'any' }, lua: lua || lib.luaName(name) });
	}

	lookup(name) {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			if (this.scopes[i].has(name)) {
				return this.scopes[i].get(name);
			}
		}
		return null;
	}

	findMember(clsInfo, name) {
		let c = clsInfo;
		while (c) {
			if (c.members.has(name)) {
				return { m: c.members.get(name), owner: c };
			}
			c = c.base ? this.classes.get(c.base) : null;
		}
		return null;
	}

	isBehaviour(c) {
		let cur = c;
		while (cur) {
			if (cur.libBase === 'MonoBehaviour') {
				return true;
			}
			cur = cur.base ? this.classes.get(cur.base) : null;
		}
		return false;
	}

	isSimple(s) {
		return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(s);
	}

	iife(lines, ret) {
		const body = lines.concat(ret === null ? [] : [`return ${ret}`]).map((l) => '\t' + l.replace(/\n/g, '\n\t')).join('\n');
		return `(function()\n${body}\nend)()`;
	}

	flushPre() {
		const list = this.pre;
		this.pre = [];
		for (const p of list) {
			this.line(p);
		}
	}
}

module.exports = { Gen, luaString, luaNumber, unparen };
