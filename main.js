// SMFX Publish Proxy (Node.js / Express)
// Rotas:
//   POST /publish  -> recebe { url, objects } em JSON, monta o RBXLX e repassa pro Open Cloud
//   GET  /get      -> proxy generico de leitura (usado pra resolver universeId/rootPlaceId,
//                     que o HttpService do jogo nao alcanca direto por serem dominios *.roblox.com)
//   POST /colorize -> recebe { code } em JSON, devolve { colored } em RichText -- usado pelo
//                     Script Editor pra colorir o codigo sem depender do autoformat de aspas
//                     do teclado mobile (que atrapalha se a coloracao for gerada no Lua)
//   GET  /asset    -> consulta um assetId via Open Cloud (metadata) + Asset Delivery
//                     (conteudo bruto). x-api-key aqui e so 1) autenticacao real da chamada
//                     de metadata no Open Cloud e 2) trava de acesso desse proxy (senao
//                     qualquer um que ache a URL do Render consulta asset de graca por aqui).
//                     NAO e repassada pro assetdelivery.roblox.com (endpoint legado, nao
//                     reconhece esse header) -- ou seja, ela NAO desbloqueia asset privado/pago
//                     que a conta dona da chave nao tem direito. O que ela resolve de verdade:
//                     o InsertService:LoadAsset() do lado do jogo sempre devolve Source vazio
//                     pra asset que nao pertence ao jogo/grupo atual (protecao anti-copia da
//                     Roblox) -- aqui a metadata vem de qualquer forma, e o conteudo (quando
//                     publico/gratuito) tambem, o que ja cobre o caso comum de asset da pagina
//                     inicial da Store.
//                     ATENCAO: extracao de Script Source pra asset em formato BINARIO (.rbxm,
//                     o mais comum) e melhor-esforco, nao testado contra um asset real -- ver
//                     comentario acima de extractScriptsFromBinary.

const express = require('express');
const { colorizeLua } = require('./colorize');

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

const app = express();

app.use(express.json({ limit: '50mb' })); // projeto grande gera JSON grande

// ---------------------------------------------------------------------------
// Escape de XML
// ---------------------------------------------------------------------------

const XML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function esc(s) {
	return String(s).replace(/[&<>'"]/g, (c) => XML_ESCAPE[c]);
}

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
			return `<int name='${n}'>${Math.trunc(value)}</int>`;
		case 'int64':
			return `<int64 name='${n}'>${Math.trunc(value)}</int64>`;
		case 'float':
			return `<float name='${n}'>${value}</float>`;
		case 'double':
			return `<double name='${n}'>${value}</double>`;
		case 'token':
			return `<token name='${n}'>${Math.trunc(value)}</token>`;

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
		case 'UDim':
			return `<UDim name='${n}'><S>${value.scale}</S><O>${Math.trunc(value.offset)}</O></UDim>`;
		case 'UDim2':
			return (
				`<UDim2 name='${n}'><XS>${value.x.scale}</XS><XO>${Math.trunc(value.x.offset)}</XO>` +
				`<YS>${value.y.scale}</YS><YO>${Math.trunc(value.y.offset)}</YO></UDim2>`
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
			return `<int name='${n}'>${Math.trunc(value.number)}</int>`;
		case 'PhysicalProperties':
			return (
				`<PhysicalProperties name='${n}'><CustomPhysics>true</CustomPhysics>` +
				`<Density>${value.density}</Density><Friction>${value.friction}</Friction>` +
				`<Elasticity>${value.elasticity}</Elasticity>` +
				`<FrictionWeight>${value.frictionWeight}</FrictionWeight>` +
				`<ElasticityWeight>${value.elasticityWeight}</ElasticityWeight></PhysicalProperties>`
			);
		case 'Content':
			return `<Content name='${n}'><url>${esc(value)}</url></Content>`;
		default:
			return null; // kind desconhecido -- ignora em vez de quebrar o publish inteiro
	}
}

// ---------------------------------------------------------------------------
// Monta a arvore (Parent -> children) a partir do dict achatado por ID
// ---------------------------------------------------------------------------

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

function buildTree(objects) {
	const nodes = {};
	for (const [idStr, data] of Object.entries(objects)) {
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
		if (parentNode) {
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

function emitNode(node, out, nodes) {
	out.push(`<Item class='${esc(node.className)}' referent='${node.referent}'>`);
	out.push('<Properties>');

	// Lighting.LightingStyle/Technology sao forcadas mais abaixo, direto aqui no proxy --
	// pula qualquer valor que tenha vindo do Lua pra essas duas, pra nao duplicar a tag.
	// Motivo: o Core.getPropertyDefs do Lua monta a lista de properties a partir de um API
	// dump de terceiros que pode nao ter LightingStyle ainda (ou ter Technology marcado
	// Deprecated e filtrado) -- se a property nem aparece nessa lista, forcar do lado Lua
	// nao adianta nada, o loop de save nunca chega nela.
	const isLighting = node.className === 'Lighting';

	for (const [propName, prop] of Object.entries(node.properties)) {
		if (isLighting && (propName === 'LightingStyle' || propName === 'Technology')) continue;
		if (!prop || typeof prop !== 'object') continue;
		const { kind, value } = prop;

		if (kind === 'ref') {
			if (propName !== 'Parent') { // Parent ja virou aninhamento, nao precisa de <Ref>
				const ref = value && value.ref;
				const targetNode = ref != null ? nodes[String(ref)] : null;
				const targetReferent = targetNode ? targetNode.referent : 'null';
				out.push(`<Ref name='${esc(propName)}'>${targetReferent}</Ref>`);
			}
		} else {
			try {
				const xml = propertyXML(propName, kind, value);
				if (xml) out.push(xml);
			} catch (e) {
				// uma property ruim nao pode derrubar o publish inteiro
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

	if (node.source) {
		out.push(`<ProtectedString name='Source'>${esc(node.source)}</ProtectedString>`);
	}

	out.push('</Properties>');

	for (const child of node.children) emitNode(child, out, nodes);

	out.push('</Item>');
}

function buildRBXLX(objects) {
	const { roots, nodes } = buildTree(objects);

	for (const root of roots) sortChildrenRecursive(root);
	roots.sort((a, b) => priorityOf(a.className) - priorityOf(b.className));

	const counter = { n: 0 };
	for (const root of roots) assignReferents(root, counter);

	const out = ["<roblox version='4'>"];
	for (const root of roots) emitNode(root, out, nodes);
	out.push('</roblox>');

	return out.join('');
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

app.post('/publish', async (req, res) => {
	const payload = req.body;
	if (!payload || !payload.objects || !payload.url) {
		return res.status(400).json({ error: 'missing objects or url in JSON body' });
	}

	let xml;
	try {
		xml = buildRBXLX(payload.objects);
	} catch (e) {
		return res.status(500).json({ error: `failed to build xml: ${e.message}` });
	}

	const apiKey = req.headers['x-api-key'];
	if (!apiKey) {
		return res.status(400).json({ error: 'missing x-api-key header' });
	}

	try {
		const upstream = await fetch(payload.url, {
			method: 'POST',
			headers: { 'x-api-key': apiKey, 'Content-Type': 'application/xml' },
			body: xml,
		});
		const body = await upstream.text();
		res.status(upstream.status);
		res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
		res.send(body);
	} catch (e) {
		res.status(502).json({ error: `upstream request failed: ${e.message}` });
	}
});

// Proxy GET generico -- usado pra endpoints de leitura da api.roblox.com/games.roblox.com que
// o HttpService do jogo nao alcanca direto (universeId, rootPlaceId). x-api-key opcional --
// a maioria desses endpoints de leitura sao publicos.
app.get('/get', async (req, res) => {
	const url = req.query.url;
	if (!url) {
		return res.status(400).json({ error: 'missing url query param' });
	}

	const headers = {};
	const apiKey = req.headers['x-api-key'];
	if (apiKey) headers['x-api-key'] = apiKey;

	try {
		const upstream = await fetch(url, { method: 'GET', headers });
		const body = await upstream.text();
		res.status(upstream.status);
		res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
		res.send(body);
	} catch (e) {
		res.status(502).json({ error: `upstream request failed: ${e.message}` });
	}
});

// Colore codigo Luau em RichText, pro Script Editor. Fica no proxy (nao no
// Lua) por dois motivos: o teclado mobile auto-formata aspas/etc quando o
// texto e montado direto no client, e HttpService/regex pesado em Lua e
// mais caro/limitado que fazer isso em JS.
app.post('/colorize', (req, res) => {
	const { code } = req.body || {};
	if (typeof code !== 'string') {
		return res.status(400).json({ error: "campo 'code' obrigatorio" });
	}

	try {
		res.json({ colored: colorizeLua(code) });
	} catch (e) {
		res.status(500).json({ error: `colorize failed: ${e.message}` });
	}
});

// ---------------------------------------------------------------------------
// /asset -- extracao de Script (Name + Source) do conteudo bruto do asset
// ---------------------------------------------------------------------------

const SCRIPT_CLASS_NAMES = new Set(['Script', 'LocalScript', 'ModuleScript']);

function decodeXMLEntities(s) {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

// RBXMX (XML). Casa cada <Item class='Script|LocalScript|ModuleScript' ...>
// ate o </Item> correspondente com regex nao-guloso -- seguro aqui porque
// esses itens normalmente nao tem <Item> filho aninhado.
const SCRIPT_ITEM_RE = /<Item class=["'](Script|LocalScript|ModuleScript)["'][^>]*>([\s\S]*?)<\/Item>/g;
const ITEM_NAME_RE = /<string name=["']Name["']>([\s\S]*?)<\/string>/;
const ITEM_SOURCE_RE = /<ProtectedString name=["']Source["']>([\s\S]*?)<\/ProtectedString>/;

function extractScriptsFromXML(xml) {
	const out = [];
	SCRIPT_ITEM_RE.lastIndex = 0;
	let m;
	while ((m = SCRIPT_ITEM_RE.exec(xml)) !== null) {
		const body = m[2];
		const nameMatch = ITEM_NAME_RE.exec(body);
		const sourceMatch = ITEM_SOURCE_RE.exec(body);
		if (sourceMatch) {
			out.push({
				name: nameMatch ? decodeXMLEntities(nameMatch[1]) : m[1],
				source: decodeXMLEntities(sourceMatch[1]),
			});
		}
	}
	return out;
}

// RBXM (binario). So le o suficiente pra extrair Script Name/Source -- NAO
// reconstroi a arvore inteira (isso exigiria decodificar tambem o array de
// referents, que usa delta+zigzag+interleaving de bytes -- desnecessario
// aqui, ja que so precisamos das strings, na mesma ordem em que aparecem no
// chunk INST de cada classe).
//
// Layout (formato publico, estavel ha anos):
//   header: 32 bytes fixos (magic "<roblox!" + assinatura + versao + counts)
//   depois, uma sequencia de chunks:
//     nome (4 bytes ascii) + compressedLength (u32 LE) + uncompressedLength (u32 LE)
//     + reserved (u32 LE) + dados (LZ4 raw block se compressedLength > 0)
//   chunk INST: classIndex (i32) + string className + isService (1 byte) + numInstances (i32) + ...
//   chunk PROP: classIndex (i32) + string propName + tipo (1 byte) + N valores
//     (aqui so tratamos tipo String = 0x01: cada valor e length (i32 LE) + bytes utf8)
//
// MELHOR-ESFORCO: nao testado contra um asset real. Qualquer chunk com
// layout inesperado e pulado (nao derruba a extracao dos outros).
const BINARY_HEADER_SIZE = 32;
const PROP_TYPE_STRING = 0x01;

function readLengthPrefixedString(buf, offset) {
	const len = buf.readInt32LE(offset);
	const str = buf.slice(offset + 4, offset + 4 + len).toString('utf8');
	return { str, next: offset + 4 + len };
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
			data = Buffer.alloc(uncompressedLength);
			if (lz4) {
				try {
					lz4.decodeBlock(compressed, data);
				} catch (e) {
					data = Buffer.alloc(0); // chunk ilegivel -- ignora, nao aborta o resto
				}
			} else {
				data = Buffer.alloc(0);
			}
			offset = dataStart + compressedLength;
		}

		chunks.push({ name, data });
		if (name === 'END') break;
	}

	return chunks;
}

function extractScriptsFromBinary(buf) {
	if (!lz4) return []; // sem `npm install lz4`, nao da pra descomprimir os chunks

	let chunks;
	try {
		chunks = readBinaryChunks(buf);
	} catch (e) {
		return [];
	}

	const classes = {}; // classIndex -> { className, numInstances }
	const stringProps = {}; // `${classIndex}:${propName}` -> string[]

	for (const chunk of chunks) {
		try {
			if (chunk.name === 'INST') {
				const d = chunk.data;
				const classIndex = d.readInt32LE(0);
				const { str: className, next } = readLengthPrefixedString(d, 4);
				const numInstances = d.readInt32LE(next + 1); // pula o byte isService
				classes[classIndex] = { className, numInstances };
			} else if (chunk.name === 'PROP') {
				const d = chunk.data;
				const classIndex = d.readInt32LE(0);
				const { str: propName, next } = readLengthPrefixedString(d, 4);
				const propType = d.readUInt8(next);
				const info = classes[classIndex];

				if (info && SCRIPT_CLASS_NAMES.has(info.className) && propType === PROP_TYPE_STRING) {
					const values = [];
					let cursor = next + 1;
					for (let i = 0; i < info.numInstances; i++) {
						const r = readLengthPrefixedString(d, cursor);
						values.push(r.str);
						cursor = r.next;
					}
					stringProps[`${classIndex}:${propName}`] = values;
				}
			}
		} catch (e) {
			continue; // chunk com layout inesperado -- pula, nao aborta o resto
		}
	}

	const out = [];
	for (const [classIndex, info] of Object.entries(classes)) {
		if (!SCRIPT_CLASS_NAMES.has(info.className)) continue;
		const names = stringProps[`${classIndex}:Name`] || [];
		const sources = stringProps[`${classIndex}:Source`];
		if (!sources) continue;
		for (let i = 0; i < sources.length; i++) {
			out.push({ name: names[i] || info.className, source: sources[i] });
		}
	}
	return out;
}

// Normaliza o assetType que vem do Open Cloud (o nome/case exato do campo ja
// mudou de versao pra versao da API) pro que o Lua espera.
function normalizeAssetType(raw) {
	if (!raw) return null;
	const s = String(raw).toLowerCase();
	if (s.includes('decal') || s.includes('image')) return 'Decal';
	if (s.includes('model') || s.includes('meshpart')) return 'Model';
	return String(raw);
}

app.get('/asset', async (req, res) => {
	const id = req.query.id;
	if (!id) {
		return res.status(400).json({ error: 'missing id query param' });
	}

	const apiKey = req.headers['x-api-key'];
	if (!apiKey) {
		return res.status(400).json({ error: 'missing x-api-key header' });
	}

	// Metadata via Open Cloud -- best-effort: se o path/formato da resposta
	// mudou de versao (nao confirmado aqui), so seguimos sem assetType, o
	// Lua cai pro que o 
