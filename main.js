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
//   GET  /games    -> lista os jogos PUBLICOS de um userId (games.roblox.com/v2/users/{id}/games).
//                     E' um dominio *.roblox.com, entao o HttpService do jogo nao alcanca direto --
//                     por isso essa rota dedicada, em vez do /get generico (que exigiria montar a
//                     URL toda no Lua). Chamado sem cookie/API key de propósito: esse endpoint so
//                     devolve jogo PUBLICO quando anonimo, que e exatamente o filtro que o SMFX quer
//                     aqui (o seletor de jogos do Publish nao deveria listar universe privado que
//                     ainda nem foi publicado como publico). Pagina automaticamente ate
//                     MAX_GAMES_PAGES paginas de 50 e devolve so { id, name } por jogo -- o Lua so
//                     precisa disso pra montar o seletor.
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
//                     A montagem do XML de saida vive em rbxlx-builder.js; os dois parsers de
//                     leitura (RBXMX e RBXM) vivem juntos em asset-parsers.js.

const express = require('express');
const zlib = require('zlib');
const { colorizeLua } = require('./colorize');
const { askGemini, MAX_PROMPT_LENGTH: MAX_AI_PROMPT_LENGTH } = require('./ai');
const { formatAIText } = require('./format');
const { buildRBXLX } = require('./rbxlx-builder');
const { extractAssetTreesFromXML, extractAssetTreesFromBinary } = require('./asset-parsers');

const app = express();

app.use(express.json({ limit: '50mb' })); // projeto grande gera JSON grande

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

// Lista os jogos PUBLICOS de um userId, pro seletor de jogos do Publish (em vez do player ter
// que digitar o ID do universe na mao). Ver comentario no cabecalho do arquivo pra detalhes de
// por que isso e uma rota dedicada e por que a chamada e sempre anonima (sem cookie/API key) --
// isso ja restringe o resultado a jogo publico sozinho, sem precisar de accessFilter explicito.
const GAMES_PAGE_LIMIT = 50;
const MAX_GAMES_PAGES = 10; // ate 500 jogos -- suficiente pra qualquer criador na pratica

app.get('/games', async (req, res) => {
	const userId = req.query.userId;
	if (!userId || !/^\d+$/.test(String(userId))) {
		return res.status(400).json({ error: 'missing or invalid userId query param' });
	}

	const games = [];
	let cursor = '';
	let page = 0;

	try {
		do {
			const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
			const url = `https://games.roblox.com/v2/users/${userId}/games?limit=${GAMES_PAGE_LIMIT}&sortOrder=Asc${cursorParam}`;
			const upstream = await fetch(url);

			if (!upstream.ok) {
				console.warn(`[SMFX Proxy] /games falhou pro userId ${userId}: ${upstream.status}`);
				break;
			}

			const body = await upstream.json();
			for (const item of body.data || []) {
				if (item && item.id != null) {
					games.push({ id: item.id, name: item.name || `Jogo ${item.id}` });
				}
			}

			cursor = body.nextPageCursor || '';
			page += 1;
		} while (cursor && page < MAX_GAMES_PAGES);

		res.json({ games });
	} catch (e) {
		console.warn(`[SMFX Proxy] /games request falhou pro userId ${userId}:`, e.message);
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
