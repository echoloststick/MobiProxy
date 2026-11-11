// SMFX Proxy -- Cloudflare Worker entry (ES Module). Runs the whole proxy; no Render origin needed.
// Render can keep running main.js (Express) in parallel; this file is what Cloudflare executes (see wrangler.jsonc).
//
// Routes: GET /health | GET /get | GET /games, /playergames, /groupgames, /gameinfo
//         GET /asset (parsed with asset-parsers.js) | POST /publish (built with rbxl-builder.js)
// Requires the "nodejs_compat" flag (Buffer / zlib used by the two shared modules).
// Optional bindings: ASSET_CACHE (KV) caches /asset results; OPEN_CLOUD_API_KEY (secret) is the fallback
// API key for /asset when the player does not send one.

import { buildRBXL } from './rbxl-builder.js';
import { extractAssetTreesFromXML, extractAssetTreesFromBinary } from './asset-parsers.js';

const GAMES_PAGE_LIMIT = 50;
const MAX_GAMES_PAGES = 10;
const ASSET_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;
const ASSET_CACHE_MAX_CHARS = 20 * 1024 * 1024;
const PUBLISH_HOST = 'apis.roblox.com';

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

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Asset (Toolbox importer)
// ---------------------------------------------------------------------------

function normalizeAssetType(raw) {
	if (!raw) return null;
	const s = String(raw).toLowerCase();
	if (s.includes('decal') || s.includes('image')) return 'Decal';
	if (s.includes('model') || s.includes('meshpart')) return 'Model';
	return String(raw);
}

async function gunzip(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return Buffer.from(await new Response(stream).arrayBuffer());
}

async function fetchAssetMetadata(id, apiKey) {
	try {
		const res = await fetch(`https://apis.roblox.com/assets/v1/assets/${id}`, { headers: { 'x-api-key': apiKey } });
		if (res.ok) return await res.json();
		console.warn(`[SMFX Proxy] Asset metadata request failed for id ${id}: HTTP ${res.status}`);
	} catch (e) {
		console.warn(`[SMFX Proxy] Asset metadata request error for id ${id}: ${e.message}`);
	}
	return null;
}

async function downloadAssetBytes(id, apiKey) {
	if (apiKey) {
		try {
			const locRes = await fetch(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}`, {
				headers: { 'x-api-key': apiKey },
			});
			if (locRes.ok) {
				const locData = await locRes.json();
				if (locData.location) {
					const fileRes = await fetch(locData.location);
					if (fileRes.ok) {
						let raw = Buffer.from(await fileRes.arrayBuffer());
						// The CDN sometimes sends a gzip body without the Content-Encoding header.
						if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
							try { raw = await gunzip(raw); } catch (e) { /* keep the raw bytes */ }
						}
						return raw;
					}
				}
			} else {
				console.warn(`[SMFX Proxy] Asset delivery request failed for id ${id}: HTTP ${locRes.status}`);
			}
		} catch (e) {
			console.warn(`[SMFX Proxy] Asset delivery request error for id ${id}: ${e.message}`);
		}
	} else {
		console.warn(`[SMFX Proxy] Asset ${id}: no API key received; Roblox requires authentication to download asset content.`);
	}

	// Legacy anonymous endpoint: kept in case Roblox reverts the authentication requirement.
	try {
		const res = await fetch(`https://assetdelivery.roblox.com/v1/asset/?id=${id}`);
		if (res.ok) return Buffer.from(await res.arrayBuffer());
		console.warn(`[SMFX Proxy] Legacy asset download failed for id ${id}: HTTP ${res.status}`);
	} catch (e) {
		console.warn(`[SMFX Proxy] Legacy asset download error for id ${id}: ${e.message}`);
	}
	return null;
}

async function loadAsset(id, apiKey) {
	const meta = apiKey ? await fetchAssetMetadata(id, apiKey) : null;
	const buf = await downloadAssetBytes(id, apiKey);

	let format = null;
	let trees = [];
	const hasContent = Boolean(buf && buf.length > 0);

	if (hasContent) {
		const head = buf.subarray(0, 8).toString('latin1');
		try {
			if (head === '<roblox!') {
				format = 'binary';
				trees = extractAssetTreesFromBinary(buf);
			} else if (head.startsWith('<roblox')) {
				format = 'xml';
				trees = extractAssetTreesFromXML(buf.toString('utf8'));
			}
		} catch (e) {
			console.warn(`[SMFX Proxy] Asset ${id} could not be parsed: ${e.message}`);
			trees = [];
		}
	}

	return {
		assetType: normalizeAssetType(meta && (meta.assetType || meta.AssetType)),
		displayName: (meta && (meta.displayName || meta.name)) || null,
		hasContent,
		format,
		trees,
	};
}

async function handleAsset(request, env, ctx, url) {
	const id = url.searchParams.get('id');
	if (!isPositiveInteger(id)) return jsonResponse({ error: 'missing or invalid id query parameter' }, 400);

	const playerKey = request.headers.get('x-api-key');

	// Results fetched with a player key may be private assets: never cache or serve those from cache.
	const cacheable = Boolean(env.ASSET_CACHE) && !playerKey;
	const cacheKey = `asset:${id}`;

	if (cacheable) {
		try {
			const hit = await env.ASSET_CACHE.get(cacheKey, 'stream');
			if (hit) {
				return new Response(hit, { headers: { 'Content-Type': 'application/json', 'X-Mobi-Cache': 'HIT' } });
			}
		} catch (e) {
			// Cache read failed: load the asset normally.
		}
	}

	let result;
	try {
		result = await loadAsset(id, playerKey || env.OPEN_CLOUD_API_KEY || null);
	} catch (e) {
		return jsonResponse({ error: `asset processing failed: ${e.message}` }, 500);
	}

	const body = JSON.stringify(result);
	if (cacheable && result.hasContent && body.length <= ASSET_CACHE_MAX_CHARS) {
		ctx.waitUntil(env.ASSET_CACHE.put(cacheKey, body, { expirationTtl: ASSET_CACHE_TTL_SECONDS }).catch(() => {}));
	}

	return new Response(body, { headers: { 'Content-Type': 'application/json', 'X-Mobi-Cache': cacheable ? 'MISS' : 'BYPASS' } });
}

// ---------------------------------------------------------------------------
// Publish (builds the binary place file and uploads it through Open Cloud)
// ---------------------------------------------------------------------------

async function handlePublish(request) {
	let payload;
	try {
		payload = await request.json();
	} catch (e) {
		return jsonResponse({ error: 'invalid JSON body' }, 400);
	}
	if (!payload || !payload.objects || !payload.url) {
		return jsonResponse({ error: 'missing objects or url in JSON body' }, 400);
	}

	const apiKey = request.headers.get('x-api-key');
	if (!apiKey) return jsonResponse({ error: 'missing x-api-key header' }, 400);

	let publishUrl;
	try {
		publishUrl = new URL(payload.url);
	} catch (e) {
		return jsonResponse({ error: 'invalid upload url' }, 400);
	}
	if (publishUrl.protocol !== 'https:' || publishUrl.hostname !== PUBLISH_HOST) {
		return jsonResponse({ error: 'upload host not allowed' }, 403);
	}

	let fileBody;
	try {
		const built = buildRBXL(payload.objects, payload.defaults).buffer;
		fileBody = new Uint8Array(built.buffer, built.byteOffset, built.byteLength);
	} catch (e) {
		console.error(`[SMFX Proxy] Binary place build failed: ${e.message}`);
		return jsonResponse({ error: `failed to build the place file: ${e.message}` }, 500);
	}

	try {
		const upstream = await fetch(publishUrl.toString(), {
			method: 'POST',
			headers: { 'x-api-key': apiKey, 'Content-Type': 'application/octet-stream' },
			body: fileBody,
		});
		const body = await upstream.text();
		return new Response(body, {
			status: upstream.status,
			headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
		});
	} catch (e) {
		return jsonResponse({ error: `upstream request failed: ${e.message}` }, 502);
	}
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

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
		if (request.method === 'POST' && path === '/publish') return handlePublish(request);

		return jsonResponse({ error: 'not found' }, 404);
	},
};
