// SMFX Proxy (Node.js / Express)
// Rotas: GET /health | POST /publish (monta RBXL binario e envia ao Open Cloud) | GET /get (leitura *.roblox.com)
// GET /games, /playergames, /groupgames, /gameinfo | GET /asset | /compress, /decompress | /rig/catalog | GET /stats (bytes por rota)

const express = require('express');
const zlib = require('zlib');
const { buildRBXL } = require('./rbxl-builder');
const { extractAssetTreesFromXML, extractAssetTreesFromBinary } = require('./asset-parsers');

const app = express();

require('./metrics').register(app); // contador de bytes por rota (GET /stats)

app.use(express.json({ limit: '50mb' })); // projeto grande gera JSON grande

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

// Health check -- usado por uptime monitors / load balancers pra saber se
// o processo esta vivo. Responde sempre "ok" em texto puro, sem tocar em
// nenhuma dependencia externa (Gemini, Open Cloud, etc): e' so um ping no
// proprio Express. Fica ANTES das outras rotas de proposito, pra nao
// gastar o body parser nem nada pesado num endpoint chamado a cada X
// segundos por monitor.
app.get('/health', (req, res) => {
	res.type('text/plain').send('ok');
});

app.post('/publish', async (req, res) => {
	const payload = req.body;
	if (!payload || !payload.objects || !payload.url) {
		return res.status(400).json({ error: 'missing objects or url in JSON body' });
	}

	// Always binary .rbxl (much smaller than RBXLX).
	let fileBody;
	try {
		fileBody = buildRBXL(payload.objects, payload.defaults).buffer;
	} catch (e) {
		console.error(`[SMFX Proxy] Binary place build failed: ${e.message}`);
		return res.status(500).json({ error: `failed to build the place file: ${e.message}` });
	}
	const contentType = 'application/octet-stream';

	const apiKey = req.headers['x-api-key'];
	if (!apiKey) {
		return res.status(400).json({ error: 'missing x-api-key header' });
	}

	try {
		const upstream = await fetch(payload.url, {
			method: 'POST',
			headers: { 'x-api-key': apiKey, 'Content-Type': contentType },
			body: fileBody,
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

	let host = '';
	try { host = new URL(url).hostname; } catch (e) { /* invalid url */ }
	if (host !== 'roblox.com' && !host.endsWith('.roblox.com')) {
		return res.status(403).json({ error: 'host not allowed' });
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
// isso ja restringe o resultado a jogo publico sozinho, sem precisar de accessFilter explicito
// (por uma particularidade da propria API da Roblox, jogo limitado-a-amigos pode aparecer aqui
// mesmo assim -- e o que a rota /playergames abaixo aproveita de proposito).
const GAMES_PAGE_LIMIT = 50;
const MAX_GAMES_PAGES = 10; // ate 500 jogos -- suficiente pra qualquer criador na pratica

async function fetchGamesPaged(baseUrl, label) {
	const games = [];
	let cursor = '';
	let page = 0;

	do {
		const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
		const url = `${baseUrl}${cursorParam}`;
		const upstream = await fetch(url);

		if (!upstream.ok) {
			console.warn(`[SMFX Proxy] fetchGamesPaged falhou pro ${label}: ${upstream.status}`);
			break;
		}

		const body = await upstream.json();
		for (const item of body.data || []) {
			if (item && item.id != null) {
				const placeId = (item.rootPlace && item.rootPlace.id != null) ? item.rootPlace.id : null;
				games.push({ id: item.id, name: item.name || `Jogo ${item.id}`, placeId });
			}
		}

		cursor = body.nextPageCursor || '';
		page += 1;
	} while (cursor && page < MAX_GAMES_PAGES);

	return games;
}

function fetchUserGames(userId) {
	return fetchGamesPaged(`https://games.roblox.com/v2/users/${userId}/games?limit=${GAMES_PAGE_LIMIT}&sortOrder=Asc`, `userId ${userId}`);
}

function fetchGroupGames(groupId) {
	return fetchGamesPaged(`https://games.roblox.com/v2/groups/${groupId}/games?accessFilter=2&limit=${GAMES_PAGE_LIMIT}&sortOrder=Asc`, `groupId ${groupId}`);
}

// Icone via rbxthumb://type=GameIcon, formato que o proprio engine resolve no client --
// nao precisa mais de chamada nenhuma a thumbnails.roblox.com.
function gameIconUri(universeId) {
	return `rbxthumb://type=GameIcon&id=${universeId}&w=150&h=150`;
}

app.get('/games', async (req, res) => {
	const userId = req.query.userId;
	if (!userId || !/^\d+$/.test(String(userId))) {
		return res.status(400).json({ error: 'missing or invalid userId query param' });
	}

	try {
		const games = await fetchUserGames(userId);
		res.json({ games });
	} catch (e) {
		console.warn(`[SMFX Proxy] /games request falhou pro userId ${userId}:`, e.message);
		res.status(502).json({ error: `upstream request failed: ${e.message}` });
	}
});

// Nome + icone de UM universe, pro PublishSystem disparar o BindableEvent SetGame logo apos
// publicar (o Lua so tem o universeId/placeId nesse momento -- nome depende de dominios
// *.roblox.com que o HttpService do jogo nao alcanca direto; o icone e' so rbxthumb, ver
// gameIconUri acima).
app.get('/gameinfo', async (req, res) => {
	const universeId = req.query.universeId;
	if (!universeId || !/^\d+$/.test(String(universeId))) {
		return res.status(400).json({ error: 'missing or invalid universeId query param' });
	}

	let name = null;
	let placeId = null;
	try {
		const gameRes = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
		if (gameRes.ok) {
			const body = await gameRes.json();
			const entry = body.data && body.data[0];
			name = (entry && entry.name) || null;
			placeId = (entry && entry.rootPlaceId) || null;
		} else {
			console.warn(`[SMFX Proxy] /gameinfo nome falhou pro universeId ${universeId}: ${gameRes.status}`);
		}
	} catch (e) {
		console.warn(`[SMFX Proxy] /gameinfo nome request falhou pro universeId ${universeId}:`, e.message);
	}

	res.json({ name, icon: gameIconUri(universeId), placeId });
});

// Jogos do player (publicados/limitados-a-amigos, ver comentario de /games acima) pra aba
// "Meus Jogos": mesma paginacao do /games, so que tambem preenche o icone (rbxthumb, sem
// chamada extra nenhuma) de cada jogo.
app.get('/playergames', async (req, res) => {
	const userId = req.query.userId;
	if (!userId || !/^\d+$/.test(String(userId))) {
		return res.status(400).json({ error: 'missing or invalid userId query param' });
	}

	try {
		const games = await fetchUserGames(userId);
		for (const game of games) {
			game.icon = gameIconUri(game.id);
		}
		res.json({ games });
	} catch (e) {
		console.warn(`[SMFX Proxy] /playergames request falhou pro userId ${userId}:`, e.message);
		res.status(502).json({ error: `upstream request failed: ${e.message}` });
	}
});

app.get('/groupgames', async (req, res) => {
	const groupId = req.query.groupId;
	if (!groupId || !/^\d+$/.test(String(groupId))) {
		return res.status(400).json({ error: 'missing or invalid groupId query param' });
	}

	try {
		const games = await fetchGroupGames(groupId);
		for (const game of games) {
			game.icon = gameIconUri(game.id);
		}
		res.json({ games });
	} catch (e) {
		console.warn(`[SMFX Proxy] /groupgames request falhou pro groupId ${groupId}:`, e.message);
		res.status(502).json({ error: `upstream request failed: ${e.message}` });
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

require('./compress').register(app, express);
require('./rig-catalog').register(app);

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
	console.log(`[SMFX Proxy] Listening on port ${port}`);
});
