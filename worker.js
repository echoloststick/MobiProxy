// SMFX Proxy -- Cloudflare Worker entry (ES Module).
// Render keeps running main.js (Express); Cloudflare runs this file (see wrangler.jsonc).
//
// Handled here (light, no Node APIs): /health, /get, /games, /playergames, /groupgames, /gameinfo.
// Forwarded to the Render origin (ORIGIN_URL): /publish, /asset, /compress, /decompress, /rig/catalog
// and any other route. /asset responses are cached in KV (binding ASSET_CACHE) when available.

const GAMES_PAGE_LIMIT = 50;
const MAX_GAMES_PAGES = 10;
const ASSET_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;
const ASSET_CACHE_MAX_CHARS = 20 * 1024 * 1024;

function jsonResponse(data, status = 200, extraHeaders = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders },
	});
}

function isPositiveInteger(value) {
	return value != null && /^\d+$/.test(String(value));
}

function gameIconUri(universeId) {
	return `rbxthumb://type=GameIcon&id=${universeId}&w=150&h=150`;
}

async function fetchGamesPaged(baseUrl) {
	const games = [];
	let cursor = '';
	let page = 0;

	do {
		const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
		const upstream = await fetch(`${baseUrl}${cursorParam}`);
		if (!upstream.ok) break;

		const body = await upstream.json();
		for (const item of body.data || []) {
			if (item && item.id != null) {
				const placeId = item.rootPlace && item.rootPlace.id != null ? item.rootPlace.id : null;
				games.push({ id: item.id, name: item.name || `Game ${item.id}`, placeId });
			}
		}

		cursor = body.nextPageCursor || '';
		page += 1;
	} while (cursor && page < MAX_GAMES_PAGES);

	return games;
}

function withIcons(games) {
	for (const game of games) game.icon = gameIconUri(game.id);
	return games;
}

async function handleGames(url, kind) {
	const param = kind === 'groups' ? 'groupId' : 'userId';
	const value = url.searchParams.get(param);
	if (!isPositiveInteger(value)) {
		return jsonResponse({ error: `missing or invalid ${param} query parameter` }, 400);
	}

	const base =
		kind === 'groups'
			? `https://games.roblox.com/v2/groups/${value}/games?accessFilter=2&limit=${GAMES_PAGE_LIMIT}&sortOrder=Asc`
			: `https://games.roblox.com/v2/users/${value}/games?limit=${GAMES_PAGE_LIMIT}&sortOrder=Asc`;

	try {
		const games = await fetchGamesPaged(base);
		return jsonResponse({ games: kind === 'plain' ? games : withIcons(games) });
	} catch (e) {
		return jsonResponse({ error: `upstream request failed: ${e.message}` }, 502);
	}
}

async function handleGameInfo(url) {
	const universeId = url.searchParams.get('universeId');
	if (!isPositiveInteger(universeId)) {
		return jsonResponse({ error: 'missing or invalid universeId query parameter' }, 400);
	}

	let name = null;
	let placeId = null;
	try {
		const upstream = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
		if (upstream.ok) {
			const body = await upstream.json();
			const entry = body.data && body.data[0];
			name = (entry && entry.name) || null;
			placeId = (entry && entry.rootPlaceId) || null;
		}
	} catch (e) {
		// Name stays null; the icon is still returned.
	}

	return jsonResponse({ name, icon: gameIconUri(universeId), placeId });
}

async function handleGet(request, url) {
	const target = url.searchParams.get('url');
	if (!target) return jsonResponse({ error: 'missing url query parameter' }, 400);

	let host = '';
	try {
		host = new URL(target).hostname;
	} catch (e) {
		// Invalid URL: host stays empty and is rejected below.
	}
	if (host !== 'roblox.com' && !host.endsWith('.roblox.com')) {
		return jsonResponse({ error: 'host not allowed' }, 403);
	}

	const headers = {};
	const apiKey = request.headers.get('x-api-key');
	if (apiKey) headers['x-api-key'] = apiKey;

	try {
		const upstream = await fetch(target, { method: 'GET', headers });
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
		});
	} catch (e) {
		return jsonResponse({ error: `upstream request failed: ${e.message}` }, 502);
	}
}

function forwardToOrigin(request, env) {
	if (!env.ORIGIN_URL) {
		return jsonResponse({ error: 'ORIGIN_URL is not configured' }, 500);
	}
	const source = new URL(request.url);
	const target = new URL(source.pathname + source.search, env.ORIGIN_URL);
	return fetch(new Request(target, request));
}

async function handleAsset(request, env, ctx, url) {
	const id = url.searchParams.get('id');
	if (!id) return jsonResponse({ error: 'missing id query parameter' }, 400);

	// Requests carrying a player API key may return private assets: never cache or serve those from cache.
	const cacheable = Boolean(env.ASSET_CACHE) && !request.headers.get('x-api-key');
	const cacheKey = `asset:${id}`;

	if (cacheable) {
		try {
			const hit = await env.ASSET_CACHE.get(cacheKey, 'stream');
			if (hit) {
				return new Response(hit, {
					headers: { 'Content-Type': 'application/json', 'X-Mobi-Cache': 'HIT' },
				});
			}
		} catch (e) {
			// Cache read failed: fall through to the origin.
		}
	}

	const response = await forwardToOrigin(request, env);
	if (!cacheable || !response.ok) return response;

	const body = await response.text();
	if (body.length <= ASSET_CACHE_MAX_CHARS && body.includes('"hasContent":true')) {
		ctx.waitUntil(
			env.ASSET_CACHE.put(cacheKey, body, { expirationTtl: ASSET_CACHE_TTL_SECONDS }).catch(() => {})
		);
	}

	return new Response(body, {
		status: response.status,
		headers: { 'Content-Type': 'application/json', 'X-Mobi-Cache': 'MISS' },
	});
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (request.method === 'GET') {
			if (path === '/health') return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
			if (path === '/get') return handleGet(request, url);
			if (path === '/games') return handleGames(url, 'plain');
			if (path === '/playergames') return handleGames(url, 'users');
			if (path === '/groupgames') return handleGames(url, 'groups');
			if (path === '/gameinfo') return handleGameInfo(url);
			if (path === '/asset') return handleAsset(request, env, ctx, url);
		}

		return forwardToOrigin(request, env);
	},
};
