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
	// Worst-case LZ4 block size is n + n/255 + 16, so one preallocated buffer is always enough.
	// (The previous version pushed every byte into a JS array, which is very slow and memory
	// hungry for large places.)
	const out = Buffer.allocUnsafe(n + Math.floor(n / 255) + 16);
	let op = 0;
	const table = new Int32Array(1 << HASH_BITS).fill(-1);
	const matchLimit = n - 12; // a match must start before this position
	let anchor = 0;
	let i = 0;

	const pushLength = (len) => {
		while (len >= 255) {
			out[op++] = 255;
			len -= 255;
		}
		out[op++] = len;
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
			out[op++] = ((literals >= 15 ? 15 : literals) << 4) | (matchCode >= 15 ? 15 : matchCode);
			if (literals >= 15) pushLength(literals - 15);
			src.copy(out, op, anchor, i);
			op += literals;
			const offset = i - ref;
			out[op++] = offset & 255;
			out[op++] = offset >> 8;
			if (matchCode >= 15) pushLength(matchCode - 15);

			i += len;
			anchor = i;
		} else {
			i++;
		}
	}

	const literals = n - anchor;
	out[op++] = (literals >= 15 ? 15 : literals) << 4;
	if (literals >= 15) pushLength(literals - 15);
	src.copy(out, op, anchor, n);
	op += literals;
	return Buffer.from(out.subarray(0, op));
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

const T = { String: 0x01, Bool: 0x02, Int32: 0x03, Float: 0x04, Double: 0x05, UDim: 0x06, UDim2: 0x07, BrickColor: 0x0b, Color3: 0x0c, Vector2: 0x0d, Vector3: 0x0e, CFrame: 0x10, Enum: 0x12, Ref: 0x13, NumberSequence: 0x15, ColorSequence: 0x16, NumberRange: 0x17, PhysicalProperties: 0x19, Color3uint8: 0x1a, Int64: 0x1b };

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
	// Used for BasePart.Color: three byte planes (all R, then all G, then all B), as in Studio files.
	Color3uint8: {
		type: T.Color3uint8,
		encode: (vs) => {
			const to8 = (x) => Math.max(0, Math.min(255, Math.round(num(x) * 255)));
			return Buffer.from([...vs.map((v) => to8(v.r)), ...vs.map((v) => to8(v.g)), ...vs.map((v) => to8(v.b))]);
		},
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
		// Flags byte: bit 0 = custom values (followed by exactly five floats), bit 1 = an extra
		// AcousticAbsorption float follows. The old code set only bit 0 but wrote a sixth float, so
		// the reader consumed that float as the next instance's flags byte and the whole PROP chunk
		// (and every property after it) was misaligned. Only bit 0 is set here, with five floats.
		encode: (vs) => Buffer.concat(vs.map((v) => (v == null
			? Buffer.from([0])
			: Buffer.concat([Buffer.from([1]), f32(v.density), f32(v.friction), f32(v.elasticity), f32(v.frictionWeight), f32(v.elasticityWeight)])))),
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
	// Derived or read-only values. Applied at load time (before the parent exists) they would move
	// attachments or give parts an initial velocity.
	'WorldCFrame', 'WorldPosition', 'WorldOrientation', 'WorldAxis', 'WorldSecondaryAxis',
	'AssemblyMass', 'AssemblyCenterOfMass', 'AssemblyRootPart', 'Velocity', 'RotVelocity', 'MeshSize',
]);

// BasePart.Color is stored by Studio as Color3uint8 (property name "Color3uint8"), next to BrickColor.
const BASEPART_CLASSES = new Set([
	'Part', 'MeshPart', 'WedgePart', 'CornerWedgePart', 'TrussPart', 'UnionOperation', 'NegateOperation',
	'IntersectOperation', 'SpawnLocation', 'Seat', 'VehicleSeat', 'FlagStand', 'SkateboardPlatform',
]);

// BrickColor snaps Color to the nearest palette entry, so it has to be applied BEFORE Color3uint8.
// Properties come from a Lua pairs() loop, so without sorting the order was random and some parts
// randomly lost their exact color.
function propOrder(name) {
	if (name === 'BrickColor') return 1;
	if (name === 'Color' || name === 'Color3uint8') return 3;
	return 2;
}

// A column has to hold a value for every instance of the class. When one instance has no usable value
// (and no default was sent), the old code dropped the WHOLE column, so every Part of the class lost its
// Size or Color. Now only that instance receives one of these fallbacks, which mirror engine defaults.
const KIND_FALLBACK = {
	string: '', Content: '', bool: false, int: 0, int64: 0, float: 0, double: 0, token: 0,
	BrickColor: { number: 194 }, Vector2: { x: 0, y: 0 }, Vector3: { x: 0, y: 0, z: 0 },
	CFrame: { c: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, Color3: { r: 1, g: 1, b: 1 },
	UDim: { scale: 0, offset: 0 }, UDim2: { x: { scale: 0, offset: 0 }, y: { scale: 0, offset: 0 } },
	NumberRange: { min: 0, max: 0 }, NumberSequence: { keypoints: [{ t: 0, v: 0, e: 0 }, { t: 1, v: 0, e: 0 }] },
	ColorSequence: { keypoints: [{ t: 0, r: 1, g: 1, b: 1 }, { t: 1, r: 1, g: 1, b: 1 }] },
	PhysicalProperties: null,
};
const PROP_FALLBACK = {
	Size: { kind: 'Vector3', value: { x: 4, y: 1, z: 2 } },
	Color: { kind: 'Color3', value: { r: 163 / 255, g: 162 / 255, b: 165 / 255 } },
	BrickColor: { kind: 'BrickColor', value: { number: 194 } },
	Material: { kind: 'token', value: 256 },
	TopSurface: { kind: 'token', value: 3 },
	BottomSurface: { kind: 'token', value: 4 },
	CanCollide: { kind: 'bool', value: true },
	CanTouch: { kind: 'bool', value: true },
	CanQuery: { kind: 'bool', value: true },
	CastShadow: { kind: 'bool', value: true },
	Visible: { kind: 'bool', value: true },
	Enabled: { kind: 'bool', value: true },
};
function fallbackFor(name, kind) {
	const specific = PROP_FALLBACK[name];
	if (specific && specific.kind === kind) return specific.value;
	return KIND_FALLBACK[kind];
}

// Studio writes these two with the Internal suffix.
const FILE_NAME = {
	Players: { MaxPlayers: 'MaxPlayersInternal', PreferredPlayers: 'PreferredPlayersInternal' },
};

// Values the publisher always sets, regardless of what the Lua side captured.
const FORCED = {
	Lighting: { LightingStyle: { kind: 'token', value: 0 }, Technology: { kind: 'token', value: 4 } },
	MaterialService: { Use2022MaterialsXml: { kind: 'bool', value: true } },
	Terrain: { Decoration: { kind: 'bool', value: true } },
	// Part sizes and joints are already saved at their final scale; letting the engine apply the
	// scale values again on load makes R15 rigs deformed or giant.
	Humanoid: { AutomaticScalingEnabled: { kind: 'bool', value: false } },
};

// Properties typed as the newer Content datatype use a different binary type; the legacy ContentId
// properties (Texture, MeshId, SoundId, ...) are written as strings instead.
const isNewContentProperty = (name) => /Content$/.test(name);

const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);
// Parts inside these containers are welded to the character at runtime and must never be anchored,
// otherwise the Handle stays where it was published and the tool looks invisible.
const HELD_CLASSES = new Set(['Tool', 'Accessory', 'Hat']);

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

// A MeshPart without InitialSize gets its mesh scale from whatever Size it has when the mesh asset
// finishes loading, so rigs and accessories come out differently on every join. InitialSize is the
// mesh's native size, which the save stores as MeshSize.
const isVec3 = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) && v.x > 0 && v.y > 0 && v.z > 0;

function prepareObjects(objects, fillMissing) {
	const result = {};
	let anyMeshSize = false;
	for (const [id, data] of Object.entries(objects)) {
		result[id] = data;
		if (data && data.className === 'MeshPart' && data.properties && !data.properties.InitialSize) {
			const mesh = data.properties.MeshSize;
			if (mesh && mesh.kind === 'Vector3' && isVec3(mesh.value)) {
				anyMeshSize = true;
				result[id] = { ...data, properties: { ...data.properties, InitialSize: mesh } };
			}
		}
	}
	if (fillMissing && anyMeshSize) {
		for (const [id, data] of Object.entries(result)) {
			if (data && data.className === 'MeshPart' && data.properties && !data.properties.InitialSize) {
				const size = data.properties.Size;
				if (size && size.kind === 'Vector3' && isVec3(size.value)) {
					result[id] = { ...data, properties: { ...data.properties, InitialSize: size } };
				}
			}
		}
	}
	return result;
}

function buildRBXL(rawObjects, defaultsByClass) {
	const objects = prepareObjects(rawObjects, true);
	const defaults = defaultsByClass && typeof defaultsByClass === 'object' ? defaultsByClass : {};
	const warnings = [];

	// Terrain and MaterialService need to exist so the forced properties have somewhere to live.
	let source = objects;
	if (!Object.values(objects).some((d) => d && d.className === 'MaterialService')) {
		source = { ...objects, __MaterialService: { className: 'MaterialService', properties: {} } };
	}

	const tree = buildTree(source);
	const { roots } = orderTree(tree.roots);
	const ordered = [];
	const walk = (node, insideHeld) => {
		node.held = insideHeld || HELD_CLASSES.has(node.className);
		ordered.push(node);
		node.children.forEach((child) => walk(child, node.held));
	};
	roots.forEach((root) => walk(root, false));

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
			const sources = instances.map((n) => {
				if (typeof n.source === 'string') return n.source;
				const prop = n.properties.Source;
				return prop && typeof prop.value === 'string' ? prop.value : '';
			});
			chunks.push(chunk('PROP', Buffer.concat([u32(classId), str('Source'), Buffer.from([T.String]), ENCODERS.string.encode(sources)])));
		}

		for (const name of [...propNames].sort((a, b) => propOrder(a) - propOrder(b))) {
			if (isNewContentProperty(name)) continue;
			if (name === 'Source' && SCRIPT_CLASSES.has(className)) continue;
			// BasePart Position/Orientation/Rotation are derived from CFrame.
			if (BASEPART_CLASSES.has(className) && (name === 'Position' || name === 'Orientation' || name === 'Rotation')) continue;

			// Reference properties are written as referents; unresolved ones become null (-1).
			// The column type comes from the first instance with a VALID value, so one bad value on
			// the first instance no longer discards the whole column.
			const first = instances
				.map((n) => n.properties[name])
				.find((p) => p && typeof p === 'object' && (p.kind === 'ref' || (VALIDATORS[p.kind] && VALIDATORS[p.kind](p.value))));
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

			const validate = VALIDATORS[first.kind];
			// BasePart.Color goes to the file as Color3uint8, like Studio does.
			const asColor3uint8 = name === 'Color' && first.kind === 'Color3' && BASEPART_CLASSES.has(className);
			const encoder = asColor3uint8 ? ENCODERS.Color3uint8 : ENCODERS[first.kind];
			const fileName = asColor3uint8 ? 'Color3uint8' : nameFor(className, name);
			if (!encoder || !validate) continue;

			const values = [];
			let fallbackCount = 0;
			for (const node of instances) {
				// Own value first, then the class default, then a fallback for this instance only.
				const own = node.properties[name];
				const dflt = defaults[className] && defaults[className][name];
				const usable = [own, dflt].find((p) => p && typeof p === 'object' && p.kind === first.kind && validate(p.value));
				if (name === 'Anchored' && node.held && first.kind === 'bool' && BASEPART_CLASSES.has(className)) {
					values.push(false);
				} else if (usable) {
					values.push(usable.value);
				} else {
					values.push(fallbackFor(name, first.kind));
					fallbackCount++;
				}
			}
			if (fallbackCount > 0) {
				warnings.push(`${className}.${name}: ${fallbackCount} of ${instances.length} instance(s) had no usable value; a fallback value was written for them.`);
			}

			let payload;
			try {
				payload = encoder.encode(values);
			} catch (e) {
				warnings.push(`${className}.${name}: property could not be encoded and was skipped (${e.message}).`);
				continue;
			}
			chunks.push(chunk('PROP', Buffer.concat([u32(classId), str(fileName), Buffer.from([encoder.type]), payload])));
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
	const placed = new Set(ordered.map((n) => n.id));
	const lost = [...tree.nodes.values()].filter((n) => !placed.has(n.id));
	const orphans = lost.length;
	if (orphans > 0) {
		const names = lost.slice(0, 5).map((n) => {
			const name = n.properties.Name && typeof n.properties.Name.value === 'string' ? n.properties.Name.value : '?';
			const parent = n.properties.Parent && n.properties.Parent.value ? n.properties.Parent.value.ref : '?';
			return `${n.className} "${name}" (id ${n.id}, missing parent ${parent})`;
		});
		warnings.push(`${orphans} instance(s) were not reachable from a service and were left out of the place file, e.g. ${names.join('; ')}.`);
	}
	for (const w of warnings.slice(0, 20)) console.warn('[rbxl-builder] ' + w);
	return { buffer, items: ordered.length, classes: classes.size, warnings, orphans };
}

module.exports = { buildRBXL, lz4Compress, lz4Decompress };
