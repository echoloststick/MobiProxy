// SMFX Publish Proxy (Node.js / Express)
// Rotas:
//   POST /publish  -> recebe { url, objects } em JSON, monta o RBXLX e repassa pro Open Cloud
//   GET  /get      -> proxy generico de leitura (usado pra resolver universeId/rootPlaceId,
//                     que o HttpService do jogo nao alcanca direto por serem dominios *.roblox.com)
//   POST /colorize -> recebe { code } em JSON, devolve { colored } em RichText -- usado pelo
//                     Script Editor pra colorir o codigo sem depender do autoformat de aspas
//                     do teclado mobile (que atrapalha se a coloracao for gerada no Lua)
//   POST /ai       -> recebe { prompt } (ja pronto, montado pelo Lua) + header x-api-key com
//                     a key do Gemini (mandada pelo Script do SERVIDOR do jogo, nunca por um
//                     LocalScript), repassa pro Gemini e devolve { response } ou { error}.
//                     Logica isolada em ai.js. O proxy nao guarda a key em lugar nenhum
//                     (nem env var) -- so repassa e esquece, igual o x-api-key de /publish.
//   POST /format   -> recebe { text } (a resposta CRUA da IA) e devolve { richtext }, o mesmo
//                     texto convertido pra Roblox RichText (**negrito** -> <b>, blocos de
//                     codigo ``` -> fonte Code + colorize se for Luau). Logica isolada em
//                     format.js, reaproveitando o colorizeLua do colorize.js.
//   GET  /asset    -> consulta um assetId via Open Cloud (metadata, opcional) + Asset Delivery
//                     (conteudo bruto). A API key (x-api-key) vem do PLAYER, repassada pelo
//                     Lua a partir do RemoteEvent que manda o id do asset -- se o player nao
//                     mandar nenhuma, o asset e tratado como publico (so os endpoints anonimos
//                     sao usados). Com key: primeiro tenta o endpoint AUTENTICADO
//                     apis.roblox.com/asset-delivery-api/v1/assetId/{id} (precisa do escopo
//                     "legacy-assets:manage" na key) -- isso sim autentica como o DONO da key,
//                     entao se o player gerar a propria key pessoal com esse escopo, o Open
//                     Cloud te trata como aquele player de verdade e libera asset PRIVADO dele.
//                     Sem key, o proxy nao consegue baixar conteudo NENHUM -- a Roblox passou
//                     a exigir autenticacao no assetdelivery.roblox.com legado desde 02/04/2025
//                     (antes disso era anonimo; hoje devolve 401 pra QUALQUER asset, publico ou
//                     nao, sem cookie/key). Ou seja: API key deixou de ser so pra asset
//                     privado -- hoje e obrigatoria pra importar qualquer Model pelo proxy,
//                     ponto final. O fallback abaixo pro endpoint legado sem key fica so por
//                     seguranca (sempre vai falhar com 401 na pratica, mas nao trava nada).
//                     Pra formato XML (.rbxmx) E BINARIO (.rbxm): devolve a ARVORE COMPLETA
//                     (classe, propriedades, referencias entre instancias, filhos) -- o
//                     ToolboxHandler reconstroi ela via Instance.new puro, sem InsertService.
//                     O parser binario segue https://github.com/rojo-rbx/rbx-dom/blob/master/docs/binary.md
//                     e foi validado contra os exemplos numericos oficiais da doc antes de
//                     integrar (ver comentario acima de extractAssetTreesFromBinary pra
//                     detalhes/limitacoes conhecidas).

const express = require('express');
const { colorizeLua } = require('./colorize');
const { askGemini, MAX_PROMPT_LENGTH: MAX_AI_PROMPT_LENGTH } = require('./ai');
const { formatAIText } = require('./format');
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

// AI Assistant -- recebe um prompt JA PRONTO (montado pelo servidor Lua,
// com todo o contexto necessario: script atual, erro, pergunta do player,
// etc) e repassa pro Gemini. O proxy so faz a ponte + trata erro; a logica
// de "o que perguntar" fica inteira do lado do jogo. A API key vem no
// header x-api-key -- mandada por um Script do SERVIDOR do jogo (nunca um
// LocalScript, que qualquer explorer consegue abrir). O proxy nao guarda
// essa key em lugar nenhum, nem env var: so repassa pro Gemini e esquece.
app.post('/ai', async (req, res) => {
	const { prompt, model, temperature, maxOutputTokens, systemInstruction } = req.body || {};
	if (typeof prompt !== 'string' || prompt.trim() === '') {
		return res.status(400).json({ error: "campo 'prompt' obrigatorio" });
	}
	if (prompt.length > MAX_AI_PROMPT_LENGTH) {
		return res.status(400).json({ error: `prompt excede o limite de ${MAX_AI_PROMPT_LENGTH} caracteres` });
	}

	const apiKey = req.headers['x-api-key'];
	if (!apiKey) {
		return res.status(400).json({ error: 'missing x-api-key header' });
	}

	try {
		const { text, finishReason } = await askGemini(prompt, apiKey, {
			model,
			temperature,
			maxOutputTokens,
			systemInstruction,
		});
		res.json({ response: text, finishReason });
	} catch (e) {
		console.warn('[SMFX Proxy] /ai falhou:', e.message);
		res.status(502).json({ error: e.message });
	}
});

const MAX_FORMAT_TEXT_LENGTH = 20000;

// Formatação da resposta da IA (markdown -> Roblox RichText). Chamado pelo
// Lua só DEPOIS que o client termina a animação de "digitando" -- não faz
// sentido gastar processamento formatando um texto que ainda vai mudar de
// tamanho na tela a cada frame da animação.
app.post('/format', (req, res) => {
	const { text } = req.body || {};
	if (typeof text !== 'string' || text === '') {
		return res.status(400).json({ error: "campo 'text' obrigatorio" });
	}
	if (text.length > MAX_FORMAT_TEXT_LENGTH) {
		return res.status(400).json({ error: `text excede o limite de ${MAX_FORMAT_TEXT_LENGTH} caracteres` });
	}

	try {
		res.json({ richtext: formatAIText(text) });
	} catch (e) {
		console.warn('[SMFX Proxy] /format falhou:', e.message);
		res.status(500).json({ error: `format failed: ${e.message}` });
	}
});

// ---------------------------------------------------------------------------
// /asset -- pra XML (.rbxmx): converte o arquivo inteiro numa arvore JSON
// (classe, propriedades, referencias entre instancias, filhos) que o
// ToolboxHandler do lado do jogo reconstroi via Instance.new puro, sem
// InsertService. Pra BINARIO (.rbxm): so extrai Script Name/Source
// (melhor-esforco), ver extractScriptsFromBinary mais abaixo -- reconstruir
// a arvore inteira do binario exigiria decodificar arrays de inteiro com
// delta+zigzag+transposicao de bytes, arriscado demais sem testar contra um
// arquivo real (erro sutil aqui corrompe CFrame/posicao em silencio).
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

// Converte componentes 0-1 (float) pra hex "RRGGBB". Usado no lugar de
// {r=,g=,b=} pra Color3/Color3uint8 -- menos superfície pra bug de
// parsing/precisão de float via JSON (o Lua parseia com tonumber(hex,16),
// bem mais direto que reconstruir 3 floats certinhos).
function rgbToHex(r, g, b) {
	const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
	const toHex = (v) => clamp(v).toString(16).padStart(2, '0');
	return toHex(r) + toHex(g) + toHex(b);
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

// RBXM (binario). Reconstroi a ARVORE INTEIRA (classe+propriedades+refs+
// filhos), igual o parser de XML -- baseado na doc oficial do rbx-dom:
// https://github.com/rojo-rbx/rbx-dom/blob/master/docs/binary.md
// Cada tipo abaixo foi validado contra os exemplos numericos que a propria
// doc fornece (UDim, UDim2, Color3, Vector3, BrickColor, formato de float,
// CFrame) antes de integrar aqui -- 9 de 10 valores bateram exatamente; o
// unico que nao bateu foi 1 componente de 1 exemplo de CFrame (o X e o Z das
// duas instancias do mesmo exemplo bateram certinho, o que sugere um typo na
// doc, nao um erro no algoritmo -- mas fica registrado aqui pra
// transparencia).
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

	// A API key vem do PLAYER (repassada pelo Lua via header, do jeito que
	// ele mandou pelo RemoteEvent junto com o id do asset). Se nao vier
	// (asset publico), so usa os endpoints anonimos -- e por isso essa
	// chave TEM chance real de destravar asset privado do PROPRIO player
	// (diferente de uma key fixa do desenvolvedor): ela autentica como a
	// conta que a gerou, entao se o player gerar a propria key pessoal com
	// o escopo "legacy-assets:manage" e mandar ela, o Open Cloud te trata
	// como aquele player de verdade.
	// Fallback pra OPEN_CLOUD_API_KEY (env var) se o player nao mandar
	// nenhuma -- util pra asset seu/da experiencia mesmo sem o player logar
	// uma key pessoal.
	const apiKey = req.headers['x-api-key'] || process.env.OPEN_CLOUD_API_KEY || null;

	// Metadata via Open Cloud -- best-effort.
	let meta = null;
	if (apiKey) {
		try {
			const metaRes = await fetch(`https://apis.roblox.com/assets/v1/assets/${id}`, {
				headers: { 'x-api-key': apiKey },
			});
			if (metaRes.ok) {
				meta = await metaRes.json();
			} else {
				console.warn(`[SMFX Proxy] /asset metadata falhou pro id ${id}: ${metaRes.status}`);
			}
		} catch (e) {
			console.warn(`[SMFX Proxy] /asset metadata request falhou pro id ${id}:`, e.message);
		}
	}

	// Conteudo bruto. Com API key: usa o endpoint AUTENTICADO do Open Cloud
	// (asset-delivery-api) -- reconhece x-api-key de verdade, e e o unico
	// jeito de baixar conteudo hoje (ver aviso no cabecalho do arquivo: a
	// Roblox fechou o acesso anonimo do endpoint legado em 02/04/2025).
	let buf = null;
	if (apiKey) {
		try {
			const locRes = await fetch(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}`, {
				headers: { 'x-api-key': apiKey },
			});
			if (locRes.ok) {
				const locData = await locRes.json();
				if (locData.location) {
					const fileRes = await fetch(locData.location, { headers: { 'Accept-Encoding': 'gzip' } });
					if (fileRes.ok) {
						let raw = Buffer.from(await fileRes.arrayBuffer());
						// Esse CDN as vezes manda o corpo gzip sem marcar
						// Content-Encoding direito -- detecta pela assinatura
						// (1f 8b) e descomprime na mao se for o caso.
						if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
							try { raw = zlib.gunzipSync(raw); } catch (e) { /* mantem cru se nao for gzip de verdade */ }
						}
						buf = raw;
					}
				}
			} else {
				console.warn(`[SMFX Proxy] /asset-delivery-api falhou pro id ${id}: ${locRes.status}`);
			}
		} catch (e) {
			console.warn(`[SMFX Proxy] /asset-delivery-api request falhou pro id ${id}:`, e.message);
		}
	} else {
		console.warn(`[SMFX Proxy] /asset id ${id}: nenhuma API key recebida -- desde 02/04/2025 a Roblox exige auth pra baixar conteudo de QUALQUER asset, entao isso ja vai cair no fallback abaixo (que tambem vai falhar).`);
	}

	// Fallback pro endpoint legado sem auth -- fica so por seguranca, mas na
	// PRATICA sempre devolve 401 hoje em dia (ver aviso acima). Nao custa
	// nada manter, e se a Roblox reverter isso um dia volta a funcionar sem
	// precisar mexer em nada aqui.
	if (!buf) {
		try {
			const contentRes = await fetch(`https://assetdelivery.roblox.com/v1/asset/?id=${id}`);
			if (contentRes.ok) {
				buf = Buffer.from(await contentRes.arrayBuffer());
			} else {
				console.warn(`[SMFX Proxy] /asset content falhou pro id ${id}: ${contentRes.status}`);
			}
		} catch (e) {
			console.warn(`[SMFX Proxy] /asset content request falhou pro id ${id}:`, e.message);
		}
	}

	let format = null;
	let trees = []; // arvore completa (classe+propriedades+refs+filhos), pra XML e BINARIO
	const hasContent = !!(buf && buf.length > 0);

	if (hasContent) {
		const head = buf.slice(0, 8).toString('latin1');
		try {
			if (head === '<roblox!') {
				format = 'binary';
				trees = extractAssetTreesFromBinary(buf);
			} else if (head.startsWith('<roblox')) {
				format = 'xml';
				trees = extractAssetTreesFromXML(buf.toString('utf8'));
			}
		} catch (e) {
			console.warn(`[SMFX Proxy] /asset falhou parseando conteudo do id ${id}:`, e.message);
			trees = [];
		}
	}

	res.json({
		assetType: normalizeAssetType(meta && (meta.assetType || meta.AssetType)),
		displayName: (meta && (meta.displayName || meta.name)) || null,
		hasContent,
		format, // 'xml' | 'binary' | null
		trees, // [{ referent, className, properties, refs, source, children }]
	});
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
	console.log(`[SMFX Proxy] Listening on port ${port}`);
});
