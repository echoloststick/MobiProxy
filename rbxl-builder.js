// Builds a binary Roblox place file (.rbxl, format version 0) from the flat
// { id -> { className, properties, source } } dictionary that PublishSystem.lua sends to /publish.
//
// Layout: header, META, INST (one per class), PROP (one per class property), PRNT, END.
// Binary layout reference: https://dom.rojo.space/binary.html
//
// Every instance of a class must carry every property written for that class, so the Lua side also
// sends `defaults[className][propName]`, the value of a fresh Instance.new(className). A property is
// written for a class only if every instance either has it or has a default for it.

// ---------------------------------------------------------------------------
// LZ4 block compression (no frame), as used by the Roblox chunk format
// ---------------------------------------------------------------------------

const MIN_MATCH = 4;
const HASH_BITS = 16;

function lz4Compress(src) {
	const n = src.length;
	if (n < 13) return null;
	const out = [];
	const table = new Int32Array(1 << HASH_BITS).fill(-1);
	const matchLimit = n - 12; // a match must start before this position
	let anchor = 0;
	let i = 0;

	const pushLength = (len) => {
		while (len >= 255) {
			out.push(255);
			len -= 255;
		}
		out.push(len);
	};

	while (i < matchLimit) {
		const seq = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24);
		const h = Math.imul(seq, 2654435761) >>> (32 - HASH_BITS);
		const ref = table[h];
		table[h] = i;
		if (
			ref >= 0 &&
			i - ref <= 65535 &&
			src[ref] === src[i] && src[ref + 1] === src[i + 1] && src[ref + 2] === src[i + 2] && src[ref + 3] === src[i + 3]
		) {
			let len = MIN_MATCH;
			const maxLen = n - 5 - i; // last 5 bytes are always literals
			while (len < maxLen && src[ref + len] === src[i + len]) len++;

			const literals = i - anchor;
			const matchCode = len - MIN_MATCH;
			out.push(((literals >= 15 ? 15 : literals) << 4) | (matchCode >= 15 ? 15 : matchCode));
			if (literals >= 15) pushLength(literals - 15);
			for (let k = anchor; k < i; k++) out.push(src[k]);
			const offset = i - ref;
			out.push(offset & 255, offset >> 8);
			if (matchCode >= 15) pushLength(matchCode - 15);

			i += len;
			anchor = i;
		} else {
			i++;
		}
	}

	const literals = n - anchor;
	out.push((literals >= 15 ? 15 : literals) << 4);
	if (literals >= 15) pushLength(literals - 15);
	for (let k = anchor; k < n; k++) out.push(src[k]);
	return Buffer.from(out);
}

function lz4Decompress(src, size) {
	const out = Buffer.alloc(size);
	let s = 0;
	let d = 0;
	while (s < src.length) {
		const token = src[s++];
		let literals = token >> 4;
		if (literals === 15) {
			let b;
			do {
				b = src[s++];
				literals += b;
			} while (b === 255);
		}
		src.copy(out, d, s, s + literals);
		s += literals;
		d += literals;
		if (s >= src.length) break;
		const offset = src[s] | (src[s + 1] << 8);
		s += 2;
		let matchLen = token & 15;
		if (matchLen === 15) {
			let b;
			do {
				b = src[s++];
				matchLen += b;
			} while (b === 255);
		}
		matchLen += MIN_MATCH;
		for (let k = 0; k < matchLen; k++) {
			out[d] = out[d - offset];
			d++;
		}
	}
	if (d !== size) throw new Error(`LZ4 size mismatch: ${d} != ${size}`);
	return out;
}

// ---------------------------------------------------------------------------
// Primitive encoders
// ---------------------------------------------------------------------------

function u32(n) {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(n >>> 0, 0);
	return b;
}

function str(s) {
	const data = Buffer.from(String(s), 'utf8');
	return Buffer.concat([u32(data.length), data]);
}

// [A0 A1 A2 A3, B0 B1 B2 B3] -> [A0 B0, A1 B1, A2 B2, A3 B3] with each value written big-endian.
function interleave32(values) {
	const n = values.length;
	const out = Buffer.alloc(n * 4);
	for (let i = 0; i < n; i++) {
		const v = values[i] >>> 0;
		out[i] = v >>> 24;
		out[n + i] = (v >>> 16) & 255;
		out[2 * n + i] = (v >>> 8) & 255;
		out[3 * n + i] = v & 255;
	}
	return out;
}

function zigzag32(v) {
	return ((v << 1) ^ (v >> 31)) >>> 0;
}

function int32Array(values) {
	return interleave32(values.map((v) => zigzag32(Math.trunc(v) | 0)));
}

function uint32Array(values) {
	return interleave32(values.map((v) => Math.trunc(v) >>> 0));
}

function referentArray(values) {
	const deltas = [];
	let previous = 0;
	for (const v of values) {
		deltas.push(zigzag32(v - previous));
		previous = v;
	}
	return interleave32(deltas);
}

const floatScratch = Buffer.alloc(4);

function robloxFloatBits(value) {
	floatScratch.writeFloatBE(Number.isFinite(value) ? value : 0, 0);
	const bits = floatScratch.readUInt32BE(0);
	return ((bits << 1) | (bits >>> 31)) >>> 0;
}

function floatArray(values) {
	return interleave32(values.map(robloxFloatBits));
}

function f32(value) {
	const b = Buffer.alloc(4);
	b.writeFloatLE(Number.isFinite(value) ? value : 0, 0);
	return b;
}

function zigzag64Array(values) {
	const n = values.length;
	const out = Buffer.alloc(n * 8);
	for (let i = 0; i < n; i++) {
		let v = BigInt.asIntN(64, BigInt(Math.trunc(Number(values[i]) || 0)));
		v = BigInt.asUintN(64, (v << 1n) ^ (v >> 63n));
		for (let byte = 0; byte < 8; byte++) {
			out[byte * n + i] = Number((v >> BigInt(56 - 8 * byte)) & 255n);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Property types: each encoder receives the list of per-instance values
// ---------------------------------------------------------------------------

const T = { String: 0x01, Bool: 0x02, Int32: 0x03, Float: 0x04, Double: 0x05, UDim: 0x06, UDim2: 0x07, BrickColor: 0x0b, Color3: 0x0c, Vector2: 0x0d, Vector3: 0x0e, CFrame: 0x10, Enum: 0x12, Ref: 0x13, NumberSequence: 0x15, ColorSequence: 0x16, NumberRange: 0x17, PhysicalProperties: 0x19, Int64: 0x1b };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const ENCODERS = {
	string: { type: T.String, encode: (vs) => Buffer.concat(vs.map((v) => str(v == null ? '' : v))) },
	Content: { type: T.String, encode: (vs) => Buffer.concat(vs.map((v) => str(v == null ? '' : v))) },
	bool: { type: T.Bool, encode: (vs) => Buffer.from(vs.map((v) => (v ? 1 : 0))) },
	int: { type: T.Int32, encode: (vs) => int32Array(vs.map(num)) },
	int64: { type: T.Int64, encode: (vs) => zigzag64Array(vs) },
	float: { type: T.Float, encode: (vs) => floatArray(vs.map(num)) },
	double: {
		type: T.Double,
		encode: (vs) => Buffer.concat(vs.map((v) => { const b = Buffer.alloc(8); b.writeDoubleLE(num(v), 0); return b; })),
	},
	token: { type: T.Enum, encode: (vs) => uint32Array(vs.map(num)) },
	BrickColor: { type: T.BrickColor, encode: (vs) => uint32Array(vs.map((v) => num(v && v.number))) },
	Vector2: { type: T.Vector2, encode: (vs) => Buffer.concat([floatArray(vs.map((v) => num(v.x))), floatArray(vs.map((v) => num(v.y)))]) },
	Vector3: {
		type: T.Vector3,
		encode: (vs) => Buffer.concat([floatArray(vs.map((v) => num(v.x))), floatArray(vs.map((v) => num(v.y))), floatArray(vs.map((v) => num(v.z)))]),
	},
	Color3: {
		type: T.Color3,
		encode: (vs) => Buffer.concat([floatArray(vs.map((v) => num(v.r))), floatArray(vs.map((v) => num(v.g))), floatArray(vs.map((v) => num(v.b)))]),
	},
	UDim: {
		type: T.UDim,
		encode: (vs) => Buffer.concat([floatArray(vs.map((v) => num(v.scale))), int32Array(vs.map((v) => num(v.offset)))]),
	},
	UDim2: {
		type: T.UDim2,
		encode: (vs) => Buffer.concat([
			floatArray(vs.map((v) => num(v.x.scale))), floatArray(vs.map((v) => num(v.y.scale))),
			int32Array(vs.map((v) => num(v.x.offset))), int32Array(vs.map((v) => num(v.y.offset))),
		]),
	},
	NumberRange: { type: T.NumberRange, encode: (vs) => Buffer.concat(vs.map((v) => Buffer.concat([f32(v.min), f32(v.max)]))) },
	NumberSequence: {
		type: T.NumberSequence,
		encode: (vs) => Buffer.concat(vs.map((v) => Buffer.concat([u32(v.keypoints.length), ...v.keypoints.map((k) => Buffer.concat([f32(k.t), f32(k.v), f32(k.e)]))]))),
	},
	ColorSequence: {
		type: T.ColorSequence,
		encode: (vs) => Buffer.concat(vs.map((v) => Buffer.concat([u32(v.keypoints.length), ...v.keypoints.map((k) => Buffer.concat([f32(k.t), f32(k.r), f32(k.g), f32(k.b), f32(0)]))]))),
	},
	CFrame: {
		type: T.CFrame,
		encode: (vs) => {
			const rotations = vs.map((v) => Buffer.concat([Buffer.from([0]), ...v.c.slice(3, 12).map(f32)]));
			return Buffer.concat([
				...rotations,
				floatArray(vs.map((v) => num(v.c[0]))), floatArray(vs.map((v) => num(v.c[1]))), floatArray(vs.map((v) => num(v.c[2]))),
			]);
		},
	},
	PhysicalProperties: {
		type: T.PhysicalProperties,
		// Flag 1 = custom values, followed by six floats (the last is AcousticAbsorption = 1).
		encode: (vs) => Buffer.concat(vs.map((v) => (v == null
			? Buffer.from([0])
			: Buffer.concat([Buffer.from([1]), f32(v.density), f32(v.friction), f32(v.elasticity), f32(v.frictionWeight), f32(v.elasticityWeight), f32(1)])))),
	},
};
const VALIDATORS = {
	string: (v) => typeof v === 'string',
	Content: (v) => v == null || typeof v === 'string',
	bool: (v) => typeof v === 'boolean',
	int: (v) => typeof v === 'number' && Number.isFinite(v),
	int64: (v) => typeof v === 'number' && Number.isFinite(v),
	float: (v) => typeof v === 'number' && Number.isFinite(v),
	double: (v) => typeof v === 'number' && Number.isFinite(v),
	token: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
	BrickColor: (v) => !!v && typeof v.number === 'number',
	Vector2: (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y),
	Vector3: (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z),
	Color3: (v) => !!v && Number.isFinite(v.r) && Number.isFinite(v.g) && Number.isFinite(v.b),
	UDim: (v) => !!v && Number.isFinite(v.scale) && Number.isFinite(v.offset),
	UDim2: (v) => !!v && !!v.x && !!v.y && Number.isFinite(v.x.scale) && Number.isFinite(v.x.offset) && Number.isFinite(v.y.scale) && Number.isFinite(v.y.offset),
	NumberRange: (v) => !!v && Number.isFinite(v.min) && Number.isFinite(v.max),
	NumberSequence: (v) => !!v && Array.isArray(v.keypoints),
	ColorSequence: (v) => !!v && Array.isArray(v.keypoints),
	CFrame: (v) => !!v && Array.isArray(v.c) && v.c.length >= 12 && v.c.every(Number.isFinite),
	PhysicalProperties: (v) => v == null || (typeof v === 'object' && Number.isFinite(v.density)),
};

// ---------------------------------------------------------------------------
// Class / property rules
// ---------------------------------------------------------------------------

const SERVICE_CLASSES = new Set([
	'Workspace', 'Players', 'Lighting', 'MaterialService', 'ReplicatedFirst', 'ReplicatedStorage',
	'StarterPack', 'StarterGui', 'StarterPlayer', 'Teams', 'ServerStorage', 'ServerScriptService',
	'SoundService', 'Chat', 'TextChatService',
]);

// Runtime-only or read-only properties that Studio never writes to a place file.
const NOT_SERIALIZED = new Set([
	'ClassName', 'Sandboxed', 'DistributedGameTime', 'InsertPoint', 'ReceiveAge', 'Mass', 'CenterOfMass',
	'ExtentsCFrame', 'ExtentsSize', 'CurrentPhysicalProperties', 'LocalTransparencyModifier',
	'AssemblyLinearVelocity', 'AssemblyAngularVelocity', 'ClassicChat', 'BubbleChat', 'Parent',
]);

// Studio writes these two with the Internal suffix.
const FILE_NAME = {
	Players: { MaxPlayers: 'MaxPlayersInternal', PreferredPlayers: 'PreferredPlayersInternal' },
};

// Values the publisher always sets, regardless of what the Lua side captured.
const FORCED = {
	Lighting: { LightingStyle: { kind: 'token', value: 0 }, Technology: { kind: 'token', value: 4 } },
	MaterialService: { Use2022MaterialsXml: { kind: 'bool', value: true } },
	Terrain: { Decoration: { kind: 'bool', value: true } },
};

// Properties typed as the newer Content datatype use a different binary type; the legacy ContentId
// properties (Texture, MeshId, SoundId, ...) are written as strings instead.
const isNewContentProperty = (name) => /Content$/.test(name);

const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

function buildTree(objects) {
	const nodes = new Map();
	for (const [id, data] of Object.entries(objects)) {
		if (!data || typeof data.className !== 'string') continue;
		nodes.set(id, { id, className: data.className, properties: data.properties || {}, source: data.source, children: [] });
	}

	const roots = [];
	for (const node of nodes.values()) {
		const parentProp = node.properties.Parent;
		const parentId = parentProp && parentProp.kind === 'ref' && parentProp.value && parentProp.value.ref != null ? String(parentProp.value.ref) : null;
		const parent = parentId ? nodes.get(parentId) : null;
		if (parent && parent !== node) parent.children.push(node);
		else roots.push(node);
	}
	return { nodes, roots: roots.filter((r) => SERVICE_CLASSES.has(r.className)) };
}

const STRUCTURAL = new Set(['Part', 'MeshPart', 'WedgePart', 'CornerWedgePart', 'UnionOperation', 'NegateOperation', 'TrussPart', 'VehicleSeat', 'Seat', 'SpawnLocation', 'Model', 'Folder', 'Humanoid']);
const DEPENDENT = new Set(['CharacterMesh', 'Attachment', 'Motor6D', 'Motor', 'Weld', 'WeldConstraint', 'RopeConstraint', 'RodConstraint', 'SpecialMesh', 'Decal', 'Texture', 'BodyColors']);
const priority = (c) => (STRUCTURAL.has(c) ? 0 : DEPENDENT.has(c) ? 10 : 5);

function orderTree(roots) {
	const ordered = [];
	const seen = new Set();
	const visit = (node) => {
		if (seen.has(node)) return false;
		seen.add(node);
		node.children = node.children.filter(visit);
		node.children.sort((a, b) => priority(a.className) - priority(b.className));
		return true;
	};
	const sortedRoots = roots.filter(visit).sort((a, b) => priority(a.className) - priority(b.className));
	const walk = (node) => {
		ordered.push(node);
		node.children.forEach(walk);
	};
	sortedRoots.forEach(walk);
	return { ordered, roots: sortedRoots };
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

function chunk(name, payload, compress = true) {
	const header = Buffer.alloc(16);
	header.write(name, 0, 'latin1');
	let body = payload;
	let compressedLength = 0;
	if (compress && payload.length > 64) {
		const packed = lz4Compress(payload);
		if (packed && packed.length < payload.length) {
			body = packed;
			compressedLength = packed.length;
		}
	}
	header.writeUInt32LE(compressedLength, 4);
	header.writeUInt32LE(payload.length, 8);
	return Buffer.concat([header, body]);
}

function metaChunk() {
	return chunk('META', Buffer.concat([u32(1), str('ExplicitAutoJoints'), str('true')]), false);
}

function valueOf(node, propName, defaults) {
	const own = node.properties[propName];
	if (own && typeof own === 'object') return own;
	const classDefaults = defaults[node.className];
	return classDefaults && classDefaults[propName] && typeof classDefaults[propName] === 'object' ? classDefaults[propName] : null;
}

function buildRBXL(objects, defaultsByClass) {
	const defaults = defaultsByClass && typeof defaultsByClass === 'object' ? defaultsByClass : {};

	// Terrain and MaterialService need to exist so the forced properties have somewhere to live.
	let source = objects;
	if (!Object.values(objects).some((d) => d && d.className === 'MaterialService')) {
		source = { ...objects, __MaterialService: { className: 'MaterialService', properties: {} } };
	}

	const { roots } = orderTree(buildTree(source).roots);
	const ordered = [];
	const walk = (node) => {
		ordered.push(node);
		node.children.forEach(walk);
	};
	roots.forEach(walk);

	const referentById = new Map();
	ordered.forEach((node, index) => {
		node.referent = index;
		referentById.set(node.id, index);
		if (FORCED[node.className]) {
			node.properties = { ...node.properties };
			for (const [name, forced] of Object.entries(FORCED[node.className])) node.properties[name] = forced;
		}
	});

	// Group by class, keeping referent order.
	const classes = new Map();
	for (const node of ordered) {
		if (!classes.has(node.className)) classes.set(node.className, []);
		classes.get(node.className).push(node);
	}

	const chunks = [];
	const classIds = new Map();
	let nextClassId = 0;

	for (const [className, instances] of classes) {
		const classId = nextClassId++;
		classIds.set(className, classId);
		const isService = SERVICE_CLASSES.has(className);
		const parts = [u32(classId), str(className), Buffer.from([isService ? 1 : 0]), u32(instances.length), referentArray(instances.map((n) => n.referent))];
		if (isService) parts.push(Buffer.alloc(instances.length, 1));
		chunks.push(chunk('INST', Buffer.concat(parts)));
	}

	const nameFor = (className, prop) => (FILE_NAME[className] && FILE_NAME[className][prop]) || prop;

	for (const [className, instances] of classes) {
		const classId = classIds.get(className);
		const propNames = new Set();
		for (const node of instances) {
			for (const [name, prop] of Object.entries(node.properties)) {
				if (NOT_SERIALIZED.has(name) || name === 'Name' || !prop || typeof prop !== 'object') continue;
				propNames.add(name);
			}
		}

		// Name is required on every instance.
		const names = instances.map((n) => {
			const prop = n.properties.Name;
			return prop && typeof prop.value === 'string' && prop.value !== '' ? prop.value : className;
		});
		chunks.push(chunk('PROP', Buffer.concat([u32(classId), str('Name'), Buffer.from([T.String]), ENCODERS.string.encode(names)])));

		if (SCRIPT_CLASSES.has(className)) {
			const sources = instances.map((n) => (typeof n.source === 'string' ? n.source : ''));
			chunks.push(chunk('PROP', Buffer.concat([u32(classId), str('Source'), Buffer.from([T.String]), ENCODERS.string.encode(sources)])));
		}

		for (const name of propNames) {
			if (isNewContentProperty(name)) continue;
			if (name === 'Source' && SCRIPT_CLASSES.has(className)) continue;

			// Reference properties are written as referents; unresolved ones become null (-1).
			const first = instances.map((n) => n.properties[name]).find((p) => p && typeof p === 'object');
			if (!first) continue;

			if (first.kind === 'ref') {
				const values = instances.map((n) => {
					const prop = n.properties[name];
					const targetId = prop && prop.kind === 'ref' && prop.value && prop.value.ref != null ? String(prop.value.ref) : null;
					return targetId != null && referentById.has(targetId) ? referentById.get(targetId) : -1;
				});
				chunks.push(chunk('PROP', Buffer.concat([u32(classId), str(nameFor(className, name)), Buffer.from([T.Ref]), referentArray(values)])));
				continue;
			}

			const encoder = ENCODERS[first.kind];
			const validate = VALIDATORS[first.kind];
			if (!encoder || !validate) continue;

			const values = [];
			let complete = true;
			for (const node of instances) {
				let prop = valueOf(node, name, defaults);
				if (prop && prop.kind !== first.kind) prop = null;
				if (prop && !validate(prop.value)) prop = null;
				if (!prop) {
					if (first.kind === 'PhysicalProperties') {
						values.push(null);
						continue;
					}
					complete = false;
					break;
				}
				values.push(prop.value);
			}
			if (!complete) continue;

			let payload;
			try {
				payload = encoder.encode(values);
			} catch (e) {
				continue;
			}
			chunks.push(chunk('PROP', Buffer.concat([u32(classId), str(nameFor(className, name)), Buffer.from([encoder.type]), payload])));
		}
	}

	// PRNT: children before their parent, siblings in order.
	const childList = [];
	const parentList = [];
	const emit = (node, parent) => {
		node.children.forEach((child) => emit(child, node));
		childList.push(node.referent);
		parentList.push(parent ? parent.referent : -1);
	};
	roots.forEach((root) => emit(root, null));
	chunks.push(chunk('PRNT', Buffer.concat([Buffer.from([0]), u32(childList.length), referentArray(childList), referentArray(parentList)])));
	chunks.push(chunk('END\0', Buffer.from('</roblox>', 'latin1'), false));

	const header = Buffer.alloc(32);
	header.write('<roblox!', 0, 'latin1');
	Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 8);
	header.writeUInt16LE(0, 14);
	header.writeInt32LE(classes.size, 16);
	header.writeInt32LE(ordered.length, 20);

	const buffer = Buffer.concat([header, metaChunk(), ...chunks]);
	return { buffer, items: ordered.length, classes: classes.size };
}

module.exports = { buildRBXL, lz4Compress, lz4Decompress };
