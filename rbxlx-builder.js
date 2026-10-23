// Monta o RBXLX (XML) a partir do dict achatado por ID que o Lua manda pro
// /publish. Isolado do main.js so por tamanho -- essa logica (propertyXML +
// ordenacao por prioridade de classe + montagem de arvore + emissao de
// tags) nao depende de nada dos parsers de asset (aqueles so LEEM RBXMX/
// RBXM, este aqui so ESCREVE RBXLX).

// ---------------------------------------------------------------------------
// Escape de XML
// ---------------------------------------------------------------------------

const XML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function esc(s) {
	return String(s)
		.replace(ILLEGAL_XML_CHARS, '')
		.replace(/[&<>'"]/g, (c) => XML_ESCAPE[c])
		// A raw carriage return is normalised to \n by every XML parser, so it has to be a character reference.
		.replace(/\r/g, '&#13;');
}

const toInt32 = (v) => Math.max(-2147483648, Math.min(2147483647, Math.trunc(v)));
const toUint32 = (v) => Math.max(0, Math.min(4294967295, Math.trunc(v)));

// BasePart.Color is stored by Studio as Color3uint8 (property name "Color3uint8"), next to BrickColor.
const BASEPART_CLASSES = new Set([
	'Part', 'MeshPart', 'WedgePart', 'CornerWedgePart', 'TrussPart', 'UnionOperation', 'NegateOperation',
	'IntersectOperation', 'SpawnLocation', 'Seat', 'VehicleSeat', 'FlagStand', 'SkateboardPlatform',
]);

// Load order matters: BrickColor snaps Color to the nearest palette entry, so it must be applied BEFORE
// Color3uint8. Properties come from a Lua pairs() loop, so without sorting the order was random and some
// parts randomly lost their exact color.
function propOrder(name) {
	if (name === 'Name') return 0;
	if (name === 'BrickColor') return 1;
	if (name === 'Color' || name === 'Color3uint8') return 3;
	return 2;
}

// Script source goes inside CDATA, the same way Studio writes it. This keeps the text byte-for-byte
// (including \r, quotes and long runs of entities) and avoids any parser differences on entity
// decoding. The only sequence that cannot appear inside CDATA is "]]>", so it is split in two.
function cdata(s) {
	const clean = String(s).replace(ILLEGAL_XML_CHARS, '');
	return '<![CDATA[' + clean.split(']]>').join(']]]]><![CDATA[>') + ']]>';
}

const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);
// Parts inside these containers are welded to the character at runtime and must never be anchored,
// otherwise the Handle stays where it was published and the tool looks invisible.
const HELD_CLASSES = new Set(['Tool', 'Accessory', 'Hat']);
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// Validates the VALUE (not the generated text), so a legitimate string such as an object named
// "null" or "undefined" is no longer discarded.
function isValidValue(kind, value) {
	switch (kind) {
		case 'string':
			return typeof value === 'string';
		case 'Content':
			return value == null || typeof value === 'string';
		case 'bool':
			return typeof value === 'boolean';
		case 'int':
		case 'int64':
		case 'float':
		case 'double':
		case 'token':
			return isFiniteNumber(value);
		case 'BrickColor':
			return !!value && isFiniteNumber(value.number);
		case 'Vector2':
			return !!value && isFiniteNumber(value.x) && isFiniteNumber(value.y);
		case 'Vector3':
			return !!value && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z);
		case 'CFrame':
			return !!value && Array.isArray(value.c) && value.c.length >= 12 && value.c.slice(0, 12).every(isFiniteNumber);
		case 'Color3':
		case 'Color3uint8':
			return !!value && isFiniteNumber(value.r) && isFiniteNumber(value.g) && isFiniteNumber(value.b);
		case 'UDim':
			return !!value && isFiniteNumber(value.scale) && isFiniteNumber(value.offset);
		case 'UDim2':
			return !!value && !!value.x && !!value.y && isFiniteNumber(value.x.scale) && isFiniteNumber(value.x.offset) &&
				isFiniteNumber(value.y.scale) && isFiniteNumber(value.y.offset);
		case 'NumberRange':
			return !!value && isFiniteNumber(value.min) && isFiniteNumber(value.max);
		case 'NumberSequence':
			return !!value && Array.isArray(value.keypoints) && value.keypoints.every((k) => k && isFiniteNumber(k.t) && isFiniteNumber(k.v) && isFiniteNumber(k.e));
		case 'ColorSequence':
			return !!value && Array.isArray(value.keypoints) && value.keypoints.every((k) => k && isFiniteNumber(k.t) && isFiniteNumber(k.r) && isFiniteNumber(k.g) && isFiniteNumber(k.b));
		case 'PhysicalProperties':
			return value == null || (typeof value === 'object' && isFiniteNumber(value.density));
		default:
			return false;
	}
}

// Propriedades de runtime/somente leitura que o Studio nunca grava no arquivo. Escrever isso no
// RBXLX nao tem efeito util e foge do formato que o Studio produz.
const NOT_SERIALIZED = new Set([
	'ClassName', 'Sandboxed', 'DistributedGameTime', 'InsertPoint', 'ReceiveAge', 'Mass', 'CenterOfMass',
	'ExtentsCFrame', 'ExtentsSize', 'CurrentPhysicalProperties', 'LocalTransparencyModifier',
	'AssemblyLinearVelocity', 'AssemblyAngularVelocity', 'ClassicChat', 'BubbleChat',
	// Derived or read-only values. Applied at load time (before the parent exists) they would move
	// attachments or give parts an initial velocity.
	'WorldCFrame', 'WorldPosition', 'WorldOrientation', 'WorldAxis', 'WorldSecondaryAxis',
	'AssemblyMass', 'AssemblyCenterOfMass', 'AssemblyRootPart', 'Velocity', 'RotVelocity',
]);

// Nome da property no arquivo (o Studio grava esses dois com sufixo Internal).
const FILE_NAME = {
	Players: { MaxPlayers: 'MaxPlayersInternal', PreferredPlayers: 'PreferredPlayersInternal' },
};

const SERVICE_CLASSES = new Set([
	'Workspace', 'Players', 'Lighting', 'MaterialService', 'ReplicatedFirst', 'ReplicatedStorage',
	'StarterPack', 'StarterGui', 'StarterPlayer', 'Teams', 'ServerStorage', 'ServerScriptService',
	'SoundService', 'Chat', 'TextChatService',
]);

// ---------------------------------------------------------------------------
// Montagem de cada tag de property, a partir do "kind" que o Lua ja resolveu
// (ver resolveKindAndValue no PublishSystem.lua) -- o Lua so classifica o
// dado, quem escreve a tag XML de verdade e aqui.
// ---------------------------------------------------------------------------

function propertyXML(propName, kind, value) {
	const n = esc(propName);

	switch (kind) {
		case 'bool':
			return `<bool name='${n}'>${value ? 'true' : 'false'}</bool>`;
		case 'string':
			return `<string name='${n}'>${esc(value)}</string>`;
		case 'int':
			return `<int name='${n}'>${toInt32(value)}</int>`;
		case 'int64':
			return `<int64 name='${n}'>${BigInt(Math.trunc(value))}</int64>`;
		case 'float':
			return `<float name='${n}'>${value}</float>`;
		case 'double':
			return `<double name='${n}'>${value}</double>`;
		case 'token':
			return `<token name='${n}'>${toUint32(value)}</token>`;

		case 'Vector3':
			return `<Vector3 name='${n}'><X>${value.x}</X><Y>${value.y}</Y><Z>${value.z}</Z></Vector3>`;
		case 'Vector2':
			return `<Vector2 name='${n}'><X>${value.x}</X><Y>${value.y}</Y></Vector2>`;
		case 'CFrame': {
			const c = value.c;
			return (
				`<CoordinateFrame name='${n}'><X>${c[0]}</X><Y>${c[1]}</Y><Z>${c[2]}</Z>` +
				`<R00>${c[3]}</R00><R01>${c[4]}</R01><R02>${c[5]}</R02>` +
				`<R10>${c[6]}</R10><R11>${c[7]}</R11><R12>${c[8]}</R12>` +
				`<R20>${c[9]}</R20><R21>${c[10]}</R21><R22>${c[11]}</R22></CoordinateFrame>`
			);
		}
		case 'Color3':
			return `<Color3 name='${n}'><R>${value.r}</R><G>${value.g}</G><B>${value.b}</B></Color3>`;
		case 'Color3uint8': {
			const to8 = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
			const packed = (0xff000000 | (to8(value.r) << 16) | (to8(value.g) << 8) | to8(value.b)) >>> 0;
			return `<Color3uint8 name='${n}'>${packed}</Color3uint8>`;
		}
		case 'UDim':
			return `<UDim name='${n}'><S>${value.scale}</S><O>${toInt32(value.offset)}</O></UDim>`;
		case 'UDim2':
			return (
				`<UDim2 name='${n}'><XS>${value.x.scale}</XS><XO>${toInt32(value.x.offset)}</XO>` +
				`<YS>${value.y.scale}</YS><YO>${toInt32(value.y.offset)}</YO></UDim2>`
			);
		case 'NumberRange':
			return `<NumberRange name='${n}'>${value.min} ${value.max}</NumberRange>`;
		case 'NumberSequence': {
			const parts = value.keypoints.map((kp) => `${kp.t} ${kp.v} ${kp.e}`).join(' ');
			return `<NumberSequence name='${n}'>${parts}</NumberSequence>`;
		}
		case 'ColorSequence': {
			const parts = value.keypoints.map((kp) => `${kp.t} ${kp.r} ${kp.g} ${kp.b} 0`).join(' ');
			return `<ColorSequence name='${n}'>${parts}</ColorSequence>`;
		}
		case 'BrickColor':
			return `<int name='${n}'>${toInt32(value.number)}</int>`;
		case 'PhysicalProperties':
			if (value == null) {
				return `<PhysicalProperties name='${n}'><CustomPhysics>false</CustomPhysics></PhysicalProperties>`;
			}
			return (
				`<PhysicalProperties name='${n}'><CustomPhysics>true</CustomPhysics>` +
				`<Density>${value.density}</Density><Friction>${value.friction}</Friction>` +
				`<Elasticity>${value.elasticity}</Elasticity>` +
				`<FrictionWeight>${value.frictionWeight}</FrictionWeight>` +
				`<ElasticityWeight>${value.elasticityWeight}</ElasticityWeight></PhysicalProperties>`
			);
		case 'Content':
			// Empty content must be <null/>; esc(null) would have written the literal URL "null".
			if (value == null || value === '') return `<Content name='${n}'><null></null></Content>`;
			return `<Content name='${n}'><url>${esc(value)}</url></Content>`;
		default:
			return null; // kind desconhecido -- ignora em vez de quebrar o publish inteiro
	}
}

// ---------------------------------------------------------------------------
// Prioridade de classe -- objetos "estruturais" (Parts, Humanoid) precisam
// aparecer no XML ANTES de objetos "dependentes" que reagem à existência
// deles no parse (CharacterMesh so aplica a malha se o Humanoid/BodyPart ja
// existir; Attachment/Motor6D so calculam certo com o pai ja no lugar).
// pairs() no Lua nao garante ordem, entao sem isso a ordem de emissao no
// XML era essencialmente aleatoria -- ordenar aqui resolve isso de vez.
// ---------------------------------------------------------------------------

const STRUCTURAL_PRIORITY = 0;
const DEFAULT_PRIORITY = 5;
const DEPENDENT_PRIORITY = 10;

const STRUCTURAL_CLASSES = new Set([
	'Part', 'MeshPart', 'WedgePart', 'CornerWedgePart', 'UnionOperation', 'NegateOperation',
	'TrussPart', 'VehicleSeat', 'Seat', 'SpawnLocation', 'Model', 'Folder', 'Humanoid',
]);

const DEPENDENT_CLASSES = new Set([
	'CharacterMesh', 'Attachment', 'Motor6D', 'Motor', 'Weld', 'WeldConstraint',
	'RopeConstraint', 'RodConstraint', 'SpecialMesh', 'Decal', 'Texture', 'BodyColors',
]);

function priorityOf(className) {
	if (STRUCTURAL_CLASSES.has(className)) return STRUCTURAL_PRIORITY;
	if (DEPENDENT_CLASSES.has(className)) return DEPENDENT_PRIORITY;
	return DEFAULT_PRIORITY;
}

function sortChildrenRecursive(node) {
	node.children.sort((a, b) => priorityOf(a.className) - priorityOf(b.className));
	for (const child of node.children) sortChildrenRecursive(child);
}

// ---------------------------------------------------------------------------
// Monta a arvore (Parent -> children) a partir do dict achatado por ID
// ---------------------------------------------------------------------------

function buildTree(objects) {
	const nodes = {};
	for (const [idStr, data] of Object.entries(objects)) {
		if (!data || typeof data.className !== 'string') continue;
		nodes[idStr] = {
			className: data.className,
			properties: data.properties || {},
			source: data.source,
			children: [],
		};
	}

	const roots = [];
	for (const node of Object.values(nodes)) {
		const parentProp = node.properties.Parent;
		let parentNode = null;
		if (parentProp && parentProp.kind === 'ref' && parentProp.value && parentProp.value.ref != null) {
			parentNode = nodes[String(parentProp.value.ref)];
		}
		if (parentNode && parentNode !== node) {
			parentNode.children.push(node);
		} else {
			roots.push(node); // sem pai reconhecido (services raiz) vira raiz do arquivo
		}
	}

	return { roots, nodes };
}

function assignReferents(node, counter) {
	counter.n += 1;
	node.referent = 'RBX' + counter.n;
	for (const child of node.children) assignReferents(child, counter);
}

function emitNode(node, out, nodes, diag, insideHeld) {
	const held = insideHeld || HELD_CLASSES.has(node.className);
	out.push(`<Item class='${esc(node.className)}' referent='${node.referent}'>`);
	out.push('<Properties>');

	// Properties "forcadas" por classe -- pulamos qualquer valor que tenha vindo do Lua
	// pra elas, e injetamos a tag correta la embaixo. Motivo (mesmo do Lighting):
	// o Core.getPropertyDefs do Lua monta a lista de properties a partir de um API
	// dump de terceiros que pode nao ter essas properties ainda (ou ter marcado
	// Deprecated e filtrado) -- se a property nem aparece nessa lista, forcar do
	// lado Lua nao adianta nada, o loop de save nunca chega nela.
	//
	//  - Lighting.LightingStyle / Lighting.Technology
	//  - MaterialService.Use2022MaterialsXml
	//  - Terrain.Decoration
	const isLighting = node.className === 'Lighting';
	const isMaterialService = node.className === 'MaterialService';
	const isTerrain = node.className === 'Terrain';

	const entries = [];
	for (const [propName, prop] of Object.entries(node.properties)) {
		if (isLighting && (propName === 'LightingStyle' || propName === 'Technology')) continue;
		if (isMaterialService && propName === 'Use2022MaterialsXml') continue;
		if (isTerrain && propName === 'Decoration') continue;
		if (!prop || typeof prop !== 'object') continue;
		if (NOT_SERIALIZED.has(propName)) continue;
		// Script source is written once, below, as a ProtectedString. If the Lua side also listed
		// "Source" as a regular property, writing it here would produce a duplicate <string> entry.
		if (propName === 'Source' && SCRIPT_CLASSES.has(node.className)) continue;
		// BasePart Position/Orientation/Rotation are derived from CFrame; applying them in a random
		// order next to CFrame can move or rotate the part.
		if (prop.kind === 'Vector3' && BASEPART_CLASSES.has(node.className) &&
			(propName === 'Position' || propName === 'Orientation' || propName === 'Rotation')) continue;
		entries.push([propName, prop]);
	}
	entries.sort((a, b) => propOrder(a[0]) - propOrder(b[0]));

	const written = new Set();
	for (const [propName, prop] of entries) {
		let { kind, value } = prop;
		if (held && propName === 'Anchored' && kind === 'bool' && BASEPART_CLASSES.has(node.className)) {
			value = false;
		}

		if (kind === 'ref') {
			if (propName !== 'Parent') { // Parent ja virou aninhamento, nao precisa de <Ref>
				const ref = value && value.ref;
				const targetNode = ref != null ? nodes[String(ref)] : null;
				const targetReferent = targetNode && targetNode.referent ? targetNode.referent : 'null';
				out.push(`<Ref name='${esc(propName)}'>${targetReferent}</Ref>`);
			}
		} else {
			let fileName = (FILE_NAME[node.className] && FILE_NAME[node.className][propName]) || propName;
			if (propName === 'Color' && kind === 'Color3' && BASEPART_CLASSES.has(node.className)) {
				fileName = 'Color3uint8';
				kind = 'Color3uint8';
			}
			if (written.has(fileName)) continue; // never emit the same property twice
			try {
				if (isValidValue(kind, value)) {
					const xml = propertyXML(fileName, kind, value);
					if (xml) {
						out.push(xml);
						written.add(fileName);
					}
				} else {
					diag.skipped++;
					if (diag.samples.length < 10) diag.samples.push(`${node.className}.${propName} (${kind})`);
				}
			} catch (e) {
				diag.skipped++;
				if (diag.samples.length < 10) diag.samples.push(`${node.className}.${propName} (${kind}): ${e.message}`);
			}
		}
	}

	if (isLighting) {
		// LightingStyle: Enum.LightingStyle.Realistic = 0 (property atual, deprecou Technology
		// em jan/2025 -- confirmado que o Player publicado ja le ela).
		// Technology: Enum.Technology.Future = 4 (mantido por seguranca/compatibilidade).
		out.push("<token name='LightingStyle'>0</token>");
		out.push("<token name='Technology'>4</token>");
	}

	if (isMaterialService) {
		// Use2022MaterialsXml = true -- materiais PBR de 2022.
		// Forcado aqui pra nao depender do API dump do Lua ter essa property.
		out.push("<bool name='Use2022MaterialsXml'>true</bool>");
	}

	if (isTerrain) {
		// Decoration = true -- liga a decoracao do terreno (grama, etc).
		// Forcado aqui pelo mesmo motivo das outras: pode nem aparecer no API dump do Lua.
		out.push("<bool name='Decoration'>true</bool>");
	}

	if (SCRIPT_CLASSES.has(node.className)) {
		// Scripts always get a Source tag (empty when there is no code), like Studio does.
		const fromProp = node.properties.Source && typeof node.properties.Source.value === 'string' ? node.properties.Source.value : '';
		const source = typeof node.source === 'string' ? node.source : fromProp;
		out.push(`<ProtectedString name='Source'>${cdata(source)}</ProtectedString>`);
	}

	out.push('</Properties>');

	for (const child of node.children) emitNode(child, out, nodes, diag, held);

	out.push('</Item>');
}

function build(objects) {
	// Garante que o MaterialService exista como service raiz, mesmo que o Lua nao o
	// mande no dict achatado (ele nao aparece naturalmente no DataModel ate ser
	// tocado). Sem isso, o proxy nao teria onde pendurar o Use2022MaterialsXml forcado.
	let objectsForTree = objects;
	const hasMaterialService = Object.values(objects).some(
		(d) => d && d.className === 'MaterialService'
	);
	if (!hasMaterialService) {
		// ID sintetico com prefixo que nao colide com os IDs numericos do Lua.
		objectsForTree = {
			...objects,
			__MaterialService: { className: 'MaterialService', properties: {} },
		};
	}

	const tree = buildTree(objectsForTree);
	const nodes = tree.nodes;
	// Objetos sem pai reconhecido que nao sao services viram "orfaos" e ficam de fora.
	const roots = tree.roots.filter((root) => SERVICE_CLASSES.has(root.className));

	for (const root of roots) sortChildrenRecursive(root);
	roots.sort((a, b) => priorityOf(a.className) - priorityOf(b.className));

	const counter = { n: 0 };
	for (const root of roots) assignReferents(root, counter);

	const out = [
		'<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" ' +
			'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
			'xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
		'<Meta name="ExplicitAutoJoints">true</Meta>',
	];
	const diag = { skipped: 0, samples: [] };
	for (const root of roots) emitNode(root, out, nodes, diag);
	out.push('</roblox>');

	const lost = Object.entries(nodes).filter(([, n]) => !n.referent);
	const orphans = lost.length;
	if (diag.skipped > 0) {
		console.warn(`[rbxlx-builder] ${diag.skipped} property value(s) were invalid and skipped (e.g. ${diag.samples.join(', ')}).`);
	}
	if (orphans > 0) {
		const names = lost.slice(0, 5).map(([id, n]) => {
			const name = n.properties.Name && typeof n.properties.Name.value === 'string' ? n.properties.Name.value : '?';
			const parent = n.properties.Parent && n.properties.Parent.value ? n.properties.Parent.value.ref : '?';
			return `${n.className} "${name}" (id ${id}, missing parent ${parent})`;
		});
		console.warn(`[rbxlx-builder] ${orphans} instance(s) were not reachable from a service and were left out of the place file, e.g. ${names.join('; ')}.`);
	}
	return { xml: out.join(''), items: counter.n, skipped: diag.skipped, orphans };
}

function buildRBXLX(objects) {
	return build(objects).xml;
}

// Compatibilidade com main.js que ainda importa buildRBXLXReport.
function buildRBXLXReport(objects) {
	const { xml, items, skipped, orphans } = build(objects);
	return { xml, stats: { items, bytes: Buffer.byteLength(xml, 'utf8'), skipped, orphans } };
}

module.exports = { buildRBXLX, buildRBXLXReport };
