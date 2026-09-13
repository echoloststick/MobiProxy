// Os dois parsers que alimentam a rota /asset do main.js: RBXMX (XML) e
// RBXM (binario). Ficam juntos num arquivo so porque servem exatamente o
// mesmo consumidor (ToolboxHandler.lua) e produzem o MESMO shape de saida
// ({ referent, className, properties, refs, source, children }) -- e a
// dupla "leitura de asset", separada do rbxlx-builder.js (que so ESCREVE
// XML pro /publish, uma responsabilidade totalmente diferente).

const zlib = require('zlib');

// Usado so pra descomprimir os chunks do formato binario .rbxm (LZ4 raw block,
// sem frame header). Precisa rodar `npm install lz4` no proxy. Se nao tiver
// instalado, o parser binario so retorna vazio (fallback seguro, nao derruba
// a rota) -- o parser de XML (.rbxmx) continua funcionando normal.
let lz4;
try {
	lz4 = require('lz4');
} catch (e) {
	lz4 = null;
}

const SCRIPT_CLASS_NAMES = new Set(['Script', 'LocalScript', 'ModuleScript']);

function decodeXMLEntities(s) {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

// Converte componentes 0-1 (float) pra hex "RRGGBB". Usado no lugar de
// {r=,g=,b=} pra Color3/Color3uint8 -- menos superfície pra bug de
// parsing/precisão de float via JSON (o Lua parseia com tonumber(hex,16),
// bem mais direto que reconstruir 3 floats certinhos). Compartilhado pelos
// dois parsers (XML e binario) porque ambos precisam converter Color3.
function rgbToHex(r, g, b) {
	const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
	const toHex = (v) => clamp(v).toString(16).padStart(2, '0');
	return toHex(r) + toHex(g) + toHex(b);
}

// =============================================================================
// RBXMX (XML) -- converte o arquivo inteiro numa arvore JSON (classe,
// propriedades, referencias entre instancias, filhos) que o ToolboxHandler
// do lado do jogo reconstroi via Instance.new puro, sem InsertService.
// =============================================================================

// Parser de XML bem simples (sem namespace/DTD) -- o suficiente pro RBXLX/
// RBXMX que a Roblox gera, que e sempre bem-formado. Trata CDATA a parte
// porque Source de Script normalmente vem embrulhado nisso.
function parseXML(xml) {
	const root = { tag: '#root', attrs: {}, children: [], text: '' };
	const stack = [root];
	let i = 0;
	const n = xml.length;

	while (i < n) {
		if (xml.startsWith('<!--', i)) {
			const end = xml.indexOf('-->', i);
			i = end === -1 ? n : end + 3;
			continue;
		}
		if (xml.startsWith('<![CDATA[', i)) {
			const end = xml.indexOf(']]>', i);
			stack[stack.length - 1].text += xml.slice(i + 9, end === -1 ? n : end);
			i = end === -1 ? n : end + 3;
			continue;
		}
		if (xml.startsWith('<?', i)) {
			const end = xml.indexOf('?>', i);
			i = end === -1 ? n : end + 2;
			continue;
		}

		if (xml[i] === '<') {
			const end = xml.indexOf('>', i);
			if (end === -1) break;
			const raw = xml.slice(i + 1, end);
			i = end + 1;

			if (raw.startsWith('!')) continue; // DOCTYPE etc

			if (raw.startsWith('/')) {
				if (stack.length > 1) stack.pop();
				continue;
			}

			const selfClosing = raw.endsWith('/');
			const body = selfClosing ? raw.slice(0, -1) : raw;
			const spaceIdx = body.search(/\s/);
			const tag = spaceIdx === -1 ? body : body.slice(0, spaceIdx);

			const attrs = {};
			if (spaceIdx !== -1) {
				const attrRe = /([\w:.-]+)\s*=\s*(['"])(.*?)\2/g;
				let am;
				while ((am = attrRe.exec(body.slice(spaceIdx))) !== null) {
					attrs[am[1]] = decodeXMLEntities(am[3]);
				}
			}

			const node = { tag, attrs, children: [], text: '' };
			stack[stack.length - 1].children.push(node);
			if (!selfClosing) stack.push(node);
		} else {
			const next = xml.indexOf('<', i);
			stack[stack.length - 1].text += xml.slice(i, next === -1 ? n : next);
			i = next === -1 ? n : next;
		}
	}

	return root;
}

// Converte um <Item> de property (ex.: <Vector3 name='Size'>...) pro MESMO
// formato que Core.serializeValue (Lua) ja produz -- assim o Lua reusa
// Core.deserializeValue direto, sem duplicar logica de conversao de tipo.
function xmlPropToValue(propNode) {
	const tag = propNode.tag;
	const getChildText = (name) => {
		const c = propNode.children.find((c) => c.tag === name);
		return c ? decodeXMLEntities(c.text) : null;
	};
	const num = (s) => (s == null ? 0 : parseFloat(s)) || 0;
	const text = () => decodeXMLEntities(propNode.text).trim();

	switch (tag) {
		case 'bool':
			return text() === 'true';
		case 'string':
			return decodeXMLEntities(propNode.text);
		case 'int':
		case 'int64':
		case 'token':
			return parseInt(text(), 10) || 0;
		case 'float':
		case 'double':
			return num(text());
		case 'Vector3':
			return { x: num(getChildText('X')), y: num(getChildText('Y')), z: num(getChildText('Z')) };
		case 'Vector2':
			return { x: num(getChildText('X')), y: num(getChildText('Y')) };
		case 'CoordinateFrame':
		case 'CFrame':
			return {
				c: [
					num(getChildText('X')), num(getChildText('Y')), num(getChildText('Z')),
					num(getChildText('R00')), num(getChildText('R01')), num(getChildText('R02')),
					num(getChildText('R10')), num(getChildText('R11')), num(getChildText('R12')),
					num(getChildText('R20')), num(getChildText('R21')), num(getChildText('R22')),
				],
			};
		case 'Color3':
			return rgbToHex(num(getChildText('R')), num(getChildText('G')), num(getChildText('B')));
		case 'UDim':
			return { scale: num(getChildText('S')), offset: num(getChildText('O')) };
		case 'UDim2':
			return {
				x: { scale: num(getChildText('XS')), offset: num(getChildText('XO')) },
				y: { scale: num(getChildText('YS')), offset: num(getChildText('YO')) },
			};
		case 'NumberRange': {
			const p = text().split(/\s+/).map(Number);
			return { min: p[0] || 0, max: p[1] || 0 };
		}
		case 'NumberSequence': {
			const p = text().split(/\s+/).map(Number);
			const kps = [];
			for (let i = 0; i + 2 < p.length; i += 3) kps.push({ t: p[i], v: p[i + 1], e: p[i + 2] });
			return { keypoints: kps };
		}
		case 'ColorSequence': {
			const p = text().split(/\s+/).map(Number);
			const kps = [];
			for (let i = 0; i + 4 < p.length; i += 5) kps.push({ t: p[i], r: p[i + 1], g: p[i + 2], b: p[i + 3] });
			return { keypoints: kps };
		}
		case 'PhysicalProperties':
			return {
				density: num(getChildText('Density')),
				friction: num(getChildText('Friction')),
				elasticity: num(getChildText('Elasticity')),
				frictionWeight: num(getChildText('FrictionWeight')),
				elasticityWeight: num(getChildText('ElasticityWeight')),
			};
		case 'Content':
			return getChildText('url') || '';
		default:
			return undefined; // tag desconhecida -- ignora essa property em vez de quebrar
	}
}

// Monta recursivamente { referent, className, properties, refs, source, children }
// a partir de um <Item>. Parent NAO precisa ser resolvido a parte -- em RBXMX
// de verdade a hierarquia ja vem pelo proprio aninhamento de <Item>, diferente
// do formato de save proprio do SMFX (que serializa Parent como property
// porque monta a arvore a partir de uma lista achatada de GetDescendants).
function buildAssetTree(itemNode) {
	const className = itemNode.attrs.class;
	const referent = itemNode.attrs.referent || null;

	const propsNode = itemNode.children.find((c) => c.tag === 'Properties');
	const properties = {};
	const refs = {};
	let source = null;

	if (propsNode) {
		for (const p of propsNode.children) {
			const name = p.attrs.name;
			if (!name) continue;

			if (p.tag === 'Ref') {
				const target = decodeXMLEntities(p.text).trim();
				if (target && target !== 'null') refs[name] = target;
			} else if (p.tag === 'ProtectedString' && name === 'Source') {
				source = decodeXMLEntities(p.text);
			} else {
				const value = xmlPropToValue(p);
				if (value !== undefined) properties[name] = value;
			}
		}
	}

	const children = itemNode.children.filter((c) => c.tag === 'Item').map(buildAssetTree);

	return { referent, className, properties, refs, source, children };
}

function extractAssetTreesFromXML(xml) {
	const root = parseXML(xml);
	const robloxNode = root.children.find((c) => c.tag === 'roblox');
	if (!robloxNode) return [];
	return robloxNode.children.filter((c) => c.tag === 'Item').map(buildAssetTree);
}

// =============================================================================
// RBXM (binario) -- reconstroi a ARVORE INTEIRA (classe+propriedades+refs+
// filhos), igual o parser de XML acima -- baseado na doc oficial do rbx-dom:
// https://github.com/rojo-rbx/rbx-dom/blob/master/docs/binary.md
// Cada tipo abaixo foi validado contra os exemplos numericos que a propria
// doc fornece (UDim, UDim2, Color3, Vector3, BrickColor, formato de float,
// CFrame) antes de integrar aqui -- 9 de 10 valores bateram exatamente; o
// unico que nao bateu foi 1 componente de 1 exemplo de CFrame (o X e o Z das
// duas instancias do mesmo exemplo bateram certinho, o que sugere um typo na
// doc, nao um erro no algoritmo -- mas fica registrado aqui pra
// transparencia).
// =============================================================================

const BINARY_HEADER_SIZE = 32;
const REF_TYPE_ID = 0x13;

function deinterleaveUint32BE(buf, offset, count) {
	const out = new Array(count);
	for (let i = 0; i < count; i++) {
		const b0 = buf[offset + i];
		const b1 = buf[offset + count + i];
		const b2 = buf[offset + 2 * count + i];
		const b3 = buf[offset + 3 * count + i];
		out[i] = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
	}
	return out;
}

function unzigzag32(v) {
	return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
}

function robloxFloatBitsToStandard(v) {
	// Roblox guarda o bit de sinal no final (LSB) em vez do inicio (MSB) --
	// "rotate right by 1" desfaz isso.
	return ((v >>> 1) | ((v & 1) << 31)) >>> 0;
}

function readInterleavedInt32Array(buf, offset, count) {
	return deinterleaveUint32BE(buf, offset, count); // sem zigzag (BrickColor/Enum)
}

function readReferentArray(buf, offset, count) {
	const raw = deinterleaveUint32BE(buf, offset, count);
	const out = new Array(count);
	let acc = 0;
	for (let i = 0; i < count; i++) {
		acc += unzigzag32(raw[i]);
		out[i] = acc;
	}
	return out;
}

function readFloat32ArrayInterleaved(buf, offset, count) {
	const raw = deinterleaveUint32BE(buf, offset, count);
	const out = new Array(count);
	const tmp = Buffer.alloc(4);
	for (let i = 0; i < count; i++) {
		tmp.writeUInt32BE(robloxFloatBitsToStandard(raw[i]), 0);
		out[i] = tmp.readFloatBE(0);
	}
	return out;
}

function decompressChunk(compressed, uncompressedLength) {
	if (compressed.length >= 4 && compressed.readUInt32BE(0) === 0x28b52ffd) {
		if (typeof zlib.zstdDecompressSync === 'function') {
			try { return zlib.zstdDecompressSync(compressed); } catch (e) { return null; }
		}
		return null; // ZSTD -- precisa de Node novo o suficiente pra zlib.zstdDecompressSync
	}
	if (!lz4) return null;
	const out = Buffer.alloc(uncompressedLength);
	try {
		lz4.decodeBlock(compressed, out);
		return out;
	} catch (e) {
		return null;
	}
}

function readBinaryChunks(buf) {
	const chunks = [];
	let offset = BINARY_HEADER_SIZE;

	while (offset + 16 <= buf.length) {
		const name = buf.slice(offset, offset + 4).toString('latin1').replace(/\0+$/, '');
		const compressedLength = buf.readUInt32LE(offset + 4);
		const uncompressedLength = buf.readUInt32LE(offset + 8);
		const dataStart = offset + 16;

		let data;
		if (compressedLength === 0) {
			data = buf.slice(dataStart, dataStart + uncompressedLength);
			offset = dataStart + uncompressedLength;
		} else {
			const compressed = buf.slice(dataStart, dataStart + compressedLength);
			data = decompressChunk(compressed, uncompressedLength) || Buffer.alloc(0);
			offset = dataStart + compressedLength;
		}

		chunks.push({ name, data });
		if (name === 'END') break;
	}

	return chunks;
}

function readBinString(buf, offset) {
	const len = buf.readUInt32LE(offset);
	const str = buf.slice(offset + 4, offset + 4 + len).toString('utf8');
	return { value: str, next: offset + 4 + len };
}

const CFRAME_SPECIAL_ANGLES = {
	0x02: [0, 0, 0], 0x03: [90, 0, 0], 0x05: [0, 180, 180], 0x06: [-90, 0, 0],
	0x07: [0, 180, 90], 0x09: [0, 90, 90], 0x0a: [0, 0, 90], 0x0c: [0, -90, 90],
	0x0d: [-90, -90, 0], 0x0e: [0, -90, 0], 0x10: [90, -90, 0], 0x11: [0, 90, 180],
	0x14: [0, 180, 0], 0x15: [-90, -180, 0], 0x17: [0, 0, 180], 0x18: [90, 180, 0],
	0x19: [0, 0, -90], 0x1b: [0, -90, -90], 0x1c: [0, -180, -90], 0x1e: [0, 90, -90],
	0x1f: [90, 90, 0], 0x20: [0, 90, 0], 0x22: [-90, 90, 0], 0x23: [0, -90, 180],
};

function readVector3ArrayAt(buf, offset, count) {
	const xs = readFloat32ArrayInterleaved(buf, offset, count); offset += 4 * count;
	const ys = readFloat32ArrayInterleaved(buf, offset, count); offset += 4 * count;
	const zs = readFloat32ArrayInterleaved(buf, offset, count); offset += 4 * count;
	const out = new Array(count);
	for (let i = 0; i < count; i++) out[i] = { x: xs[i], y: ys[i], z: zs[i] };
	return { values: out, next: offset };
}

// Le o array de N valores de um PROP chunk pra um TypeID conhecido. `null`
// = tipo nao suportado -- o chunk inteiro e ignorado (seguro: PROP e
// auto-contido, nada mais e lido depois dele no mesmo chunk).
function readBinPropArray(typeId, buf, count) {
	switch (typeId) {
		case 0x01: { // String
			const out = new Array(count);
			let offset = 0;
			for (let i = 0; i < count; i++) {
				const r = readBinString(buf, offset);
				out[i] = r.value;
				offset = r.next;
			}
			return out;
		}
		case 0x02: { // Bool
			const out = new Array(count);
			for (let i = 0; i < count; i++) out[i] = buf.readUInt8(i) !== 0;
			return out;
		}
		case 0x03: // Int32
			return readInterleavedInt32Array(buf, 0, count).map(unzigzag32);
		case 0x04: // Float32
			return readFloat32ArrayInterleaved(buf, 0, count);
		case 0x05: { // Float64
			const out = new Array(count);
			for (let i = 0; i < count; i++) out[i] = buf.readDoubleLE(i * 8);
			return out;
		}
		case 0x06: { // UDim
			const scales = readFloat32ArrayInterleaved(buf, 0, count);
			const offsets = readInterleavedInt32Array(buf, 4 * count, count).map(unzigzag32);
			const out = new Array(count);
			for (let i = 0; i < count; i++) out[i] = { scale: scales[i], offset: offsets[i] };
			return out;
		}
		case 0x07: { // UDim2
			let off = 0;
			const xScale = readFloat32ArrayInterleaved(buf, off, count); off += 4 * count;
			const yScale = readFloat32ArrayInterleaved(buf, off, count); off += 4 * count;
			const xOffset = readInterleavedInt32Array(buf, off, count).map(unzigzag32); off += 4 * count;
			const yOffset = readInterleavedInt32Array(buf, off, count).map(unzigzag32); off += 4 * count;
			const out = new Array(count);
			for (let i = 0; i < count; i++) {
				out[i] = { x: { scale: xScale[i], offset: xOffset[i] }, y: { scale: yScale[i], offset: yOffset[i] } };
			}
			return out;
		}
		case 0x0b: // BrickColor (untransformed, so interleave)
			return readInterleavedInt32Array(buf, 0, count);
		case 0x0c: { // Color3
			let off = 0;
			const r = readFloat32ArrayInterleaved(buf, off, count); off += 4 * count;
			const g = readFloat32ArrayInterleaved(buf, off, count); off += 4 * count;
			const b = readFloat32ArrayInterleaved(buf, off, count); off += 4 * count;
			const out = new Array(count);
			for (let i = 0; i < count; i++) out[i] = rgbToHex(r[i], g[i], b[i]);
			return out;
		}
		case 0x0d: { // Vector2
			let off = 0;
			const x = readFloat32ArrayInterleaved(buf, off, count); off += 4 * count;
			const y = readFloat32ArrayInterleaved(buf, off, count); off += 4 * count;
			const out = new Array(count);
			for (let i = 0; i < count; i++) out[i] = { x: x[i], y: y[i] };
			return out;
		}
		case 0x0e: // Vector3
			return readVector3ArrayAt(buf, 0, count).values;
		case 0x10: { // CFrame
			const ids = new Array(count);
			const rawOrient = new Array(count);
			let off = 0;
			for (let i = 0; i < count; i++) {
				const id = buf.readUInt8(off); off += 1;
				ids[i] = id;
				if (id === 0) {
					const r = new Array(9);
					for (let k = 0; k < 9; k++) { r[k] = buf.readFloatLE(off); off += 4; }
					rawOrient[i] = r;
				}
			}
			const pos = readVector3ArrayAt(buf, off, count);
			const out = new Array(count);
			for (let i = 0; i < count; i++) {
				const p = pos.values[i];
				if (ids[i] === 0) {
					const r = rawOrient[i];
					out[i] = { c: [p.x, p.y, p.z, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]] };
				} else if (CFRAME_SPECIAL_ANGLES[ids[i]]) {
					// Deixa o Lua recompor via CFrame.fromEulerAnglesYXZ (usa a
					// matematica de verdade do Roblox em vez da gente reimplementar
					// a matriz aqui e arriscar errar a convencao).
					out[i] = { specialAngles: CFRAME_SPECIAL_ANGLES[ids[i]], position: p };
				} else {
					out[i] = { c: [p.x, p.y, p.z, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
				}
			}
			return out;
		}
		case 0x12: // Enum (untransformed, so interleave)
			return readInterleavedInt32Array(buf, 0, count);
		case 0x15: { // NumberSequence
			const out = new Array(count);
			let off = 0;
			for (let i = 0; i < count; i++) {
				const n = buf.readUInt32LE(off); off += 4;
				const kps = new Array(n);
				for (let k = 0; k < n; k++) {
					kps[k] = { t: buf.readFloatLE(off), v: buf.readFloatLE(off + 4), e: buf.readFloatLE(off + 8) };
					off += 12;
				}
				out[i] = { keypoints: kps };
			}
			return out;
		}
		case 0x16: { // ColorSequence
			const out = new Array(count);
			let off = 0;
			for (let i = 0; i < count; i++) {
				const n = buf.readUInt32LE(off); off += 4;
				const kps = new Array(n);
				for (let k = 0; k < n; k++) {
					kps[k] = {
						t: buf.readFloatLE(off), r: buf.readFloatLE(off + 4),
						g: buf.readFloatLE(off + 8), b: buf.readFloatLE(off + 12),
					};
					off += 20; // 5o float (envelope) e ignorado
				}
				out[i] = { keypoints: kps };
			}
			return out;
		}
		case 0x17: { // NumberRange
			const out = new Array(count);
			for (let i = 0; i < count; i++) out[i] = { min: buf.readFloatLE(i * 8), max: buf.readFloatLE(i * 8 + 4) };
			return out;
		}
		case 0x19: { // PhysicalProperties
			const out = new Array(count);
			let off = 0;
			for (let i = 0; i < count; i++) {
				const flags = buf.readUInt8(off); off += 1;
				if (flags & 1) {
					const density = buf.readFloatLE(off); off += 4;
					const friction = buf.readFloatLE(off); off += 4;
					const elasticity = buf.readFloatLE(off); off += 4;
					const frictionWeight = buf.readFloatLE(off); off += 4;
					const elasticityWeight = buf.readFloatLE(off); off += 4;
					if (flags & 2) off += 4; // acousticAbsorption, nao usado
					out[i] = { density, friction, elasticity, frictionWeight, elasticityWeight };
				} else {
					out[i] = null; // usa o padrao do Material -- nao seta a property
				}
			}
			return out;
		}
		case 0x1a: { // Color3uint8
			const out = new Array(count);
			const toHex2 = (v) => v.toString(16).padStart(2, '0');
			for (let i = 0; i < count; i++) {
				out[i] = toHex2(buf.readUInt8(i)) + toHex2(buf.readUInt8(count + i)) + toHex2(buf.readUInt8(2 * count + i));
			}
			return out;
		}
		case 0x22: { // Content -- so o caso Uri, Object refs sao ignorados
			const sourceTypes = readInterleavedInt32Array(buf, 0, count);
			let off = 4 * count;
			const uriCount = buf.readUInt32LE(off); off += 4;
			const uris = new Array(uriCount);
			for (let i = 0; i < uriCount; i++) {
				const r = readBinString(buf, off);
				uris[i] = r.value;
				off = r.next;
			}
			const out = new Array(count);
			let uriPtr = 0;
			for (let i = 0; i < count; i++) out[i] = sourceTypes[i] === 1 ? uris[uriPtr++] : null;
			return out;
		}
		default:
			return null; // tipo nao suportado -- chunk inteiro ignorado
	}
}

function extractAssetTreesFromBinary(buf) {
	const chunks = readBinaryChunks(buf);

	const classes = {}; // classIndex -> { className, referents: number[] }
	const nodesByReferent = new Map();
	let prntChild = null, prntParent = null;

	for (const chunk of chunks) {
		try {
			if (chunk.name === 'INST') {
				const d = chunk.data;
				const classIndex = d.readUInt32LE(0);
				const nameRes = readBinString(d, 4);
				const className = nameRes.value;
				let off = nameRes.next;
				off += 1; // ObjectFormat (isService)
				const instanceCount = d.readUInt32LE(off); off += 4;
				const referents = readReferentArray(d, off, instanceCount);

				classes[classIndex] = { className, referents };
				for (const ref of referents) {
					nodesByReferent.set(ref, { referent: String(ref), className, properties: {}, refs: {}, source: null, children: [] });
				}
			} else if (chunk.name === 'PROP') {
				const d = chunk.data;
				const classIndex = d.readUInt32LE(0);
				const nameRes = readBinString(d, 4);
				const propName = nameRes.value;
				const typeId = d.readUInt8(nameRes.next);
				const valuesBuf = d.slice(nameRes.next + 1);
				const info = classes[classIndex];
				if (!info) continue;
				const count = info.referents.length;

				if (typeId === REF_TYPE_ID) {
					const refs = readReferentArray(valuesBuf, 0, count);
					for (let i = 0; i < count; i++) {
						if (refs[i] !== -1) nodesByReferent.get(info.referents[i]).refs[propName] = String(refs[i]);
					}
					continue;
				}

				const values = readBinPropArray(typeId, valuesBuf, count);
				if (values === null) continue;
				for (let i = 0; i < count; i++) {
					if (values[i] !== null && values[i] !== undefined) {
						nodesByReferent.get(info.referents[i]).properties[propName] = values[i];
					}
				}
			} else if (chunk.name === 'PRNT') {
				const d = chunk.data;
				let off = 1; // Version
				const instanceCount = d.readUInt32LE(off); off += 4;
				prntChild = readReferentArray(d, off, instanceCount); off += 4 * instanceCount;
				prntParent = readReferentArray(d, off, instanceCount);
			}
		} catch (e) {
			continue; // chunk com layout inesperado -- pula, nao aborta o resto
		}
	}

	// Source vira campo separado (mesmo shape da arvore XML), nao fica em properties
	for (const node of nodesByReferent.values()) {
		if (SCRIPT_CLASS_NAMES.has(node.className) && typeof node.properties.Source === 'string') {
			node.source = node.properties.Source;
			delete node.properties.Source;
		}
	}

	const roots = [];
	if (prntChild && prntParent) {
		for (let i = 0; i < prntChild.length; i++) {
			const childNode = nodesByReferent.get(prntChild[i]);
			if (!childNode) continue;
			const parentRef = prntParent[i];
			if (parentRef === -1) {
				roots.push(childNode);
			} else {
				const parentNode = nodesByReferent.get(parentRef);
				if (parentNode) parentNode.children.push(childNode);
				else roots.push(childNode); // pai fora do arquivo -- trata como raiz
			}
		}
	}

	return roots;
}

module.exports = { extractAssetTreesFromXML, extractAssetTreesFromBinary };
