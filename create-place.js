// SMFX Proxy -- Creates a place (new experience) or a subplace through the Roblox web APIs.
// Route: POST /createplace   body: { name, cookie, placeId? }   (placeId present => create a subplace in that experience)
//
// SECURITY: the player's .ROBLOSECURITY cookie exists only inside one request. It is never stored, cached,
// logged or returned, and error messages are built only from Roblox's own error text.

const TEMPLATE_PLACE_ID = 95206881; // Roblox "Baseplate" template
const MAX_NAME_LENGTH = 50;
const MAX_COOKIE_LENGTH = 4096;
const COOKIE_PREFIX = '.ROBLOSECURITY=';
const COOKIE_PATTERN = /^[A-Za-z0-9_|:.\-+\/=%]+$/;
const ERROR_TEXT_LIMIT = 200;
const PASSTHROUGH_STATUS = [401, 403, 404, 429];

function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

class RobloxError extends Error {
	constructor(message, status) {
		super(message);
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function cleanCookie(raw) {
	if (typeof raw !== 'string') return null;
	let value = raw.trim();
	if (value.toUpperCase().startsWith(COOKIE_PREFIX)) value = value.slice(COOKIE_PREFIX.length);
	value = value.replace(/;+$/, '').replace(/^"|"$/g, '').trim();
	// The strict character set also rules out header injection (no spaces, line breaks or separators).
	if (value.length === 0 || value.length > MAX_COOKIE_LENGTH || !COOKIE_PATTERN.test(value)) return null;
	return value;
}

function cleanName(raw) {
	if (typeof raw !== 'string') return null;
	const value = raw.trim();
	if (value.length === 0 || value.length > MAX_NAME_LENGTH || /[\u0000-\u001f]/.test(value)) return null;
	return value;
}

function cleanId(raw) {
	const text = String(raw).trim();
	return /^\d{1,15}$/.test(text) && Number(text) > 0 ? text : null;
}

// ---------------------------------------------------------------------------
// Roblox requests
// ---------------------------------------------------------------------------

async function readJson(response) {
	try {
		return JSON.parse(await response.text());
	} catch (e) {
		return {};
	}
}

function errorText(data, fallback) {
	const first = data && Array.isArray(data.errors) ? data.errors[0] : null;
	const text = (first && first.message) || (data && data.message) || fallback;
	return String(text).slice(0, ERROR_TEXT_LIMIT);
}

// Sends one authenticated request. Roblox answers the first write with 403 plus an X-CSRF-TOKEN header; the
// request is then repeated once with that token.
async function send(session, method, url, body) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const headers = {
			Cookie: `${COOKIE_PREFIX}${session.cookie}`,
			Accept: 'application/json',
			'Content-Type': 'application/json',
		};
		if (session.csrf) headers['X-CSRF-TOKEN'] = session.csrf;

		const response = await fetch(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		const token = response.headers.get('x-csrf-token');
		if (response.status === 403 && attempt === 0 && token) {
			session.csrf = token;
			try {
				await response.body?.cancel();
			} catch (e) {
				// Body already closed.
			}
			continue;
		}
		return response;
	}
}

async function robloxRequest(session, method, url, body, failure) {
	const response = await send(session, method, url, body);
	const data = await readJson(response);
	if (!response.ok) {
		const reason =
			response.status === 401 ? 'The cookie is invalid or has expired' : errorText(data, `HTTP ${response.status}`);
		throw new RobloxError(`${failure}: ${reason}`, response.status);
	}
	return data;
}

async function resolveUniverseId(placeId) {
	const response = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
	const data = await readJson(response);
	if (!response.ok || !data.universeId) throw new RobloxError('The given place could not be found', 404);
	return String(data.universeId);
}

// Renaming is best effort: the place already exists at this point, so a failure becomes a warning.
async function tryRename(session, url, name, label, warnings) {
	try {
		await robloxRequest(session, 'PATCH', url, { name }, `Could not rename the ${label}`);
	} catch (e) {
		warnings.push(e instanceof RobloxError ? e.message : `Could not rename the ${label}`);
	}
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleCreatePlace(request) {
	let payload;
	try {
		payload = await request.json();
	} catch (e) {
		return jsonResponse({ ok: false, error: 'Invalid request body: expected JSON.' }, 400);
	}
	if (!payload || typeof payload !== 'object') {
		return jsonResponse({ ok: false, error: 'Invalid request body: expected a JSON object.' }, 400);
	}

	const name = cleanName(payload.name);
	const cookie = cleanCookie(payload.cookie);
	const wantsSubplace = payload.placeId != null && payload.placeId !== '';
	const placeId = wantsSubplace ? cleanId(payload.placeId) : null;
	payload = null;

	if (!name) return jsonResponse({ ok: false, error: `Invalid name: use 1 to ${MAX_NAME_LENGTH} characters.` }, 400);
	if (!cookie) return jsonResponse({ ok: false, error: 'Invalid or missing cookie.' }, 400);
	if (wantsSubplace && !placeId) return jsonResponse({ ok: false, error: 'Invalid place id.' }, 400);

	const session = { cookie, csrf: null };
	const warnings = [];

	try {
		if (placeId) {
			const universeId = await resolveUniverseId(placeId);
			const created = await robloxRequest(
				session,
				'POST',
				`https://apis.roblox.com/universes/v1/user/universes/${universeId}/places`,
				{ templatePlaceId: TEMPLATE_PLACE_ID },
				'Could not create the subplace'
			);
			const newPlaceId = created.placeId ?? created.PlaceId;
			if (!newPlaceId) throw new RobloxError('Roblox did not return the new place id', 502);

			await tryRename(session, `https://develop.roblox.com/v1/places/${newPlaceId}`, name, 'subplace', warnings);
			return jsonResponse({ ok: true, subplace: true, universeId, placeId: String(newPlaceId), warnings });
		}

		const created = await robloxRequest(
			session,
			'POST',
			'https://apis.roblox.com/universes/v1/universes/create',
			{ templatePlaceId: TEMPLATE_PLACE_ID },
			'Could not create the place'
		);
		const universeId = created.universeId ?? created.UniverseId;
		const rootPlaceId = created.rootPlaceId ?? created.RootPlaceId;
		if (!universeId || !rootPlaceId) throw new RobloxError('Roblox did not return the new place ids', 502);

		await tryRename(session, `https://develop.roblox.com/v2/universes/${universeId}/configuration`, name, 'experience', warnings);
		await tryRename(session, `https://develop.roblox.com/v1/places/${rootPlaceId}`, name, 'place', warnings);
		return jsonResponse({
			ok: true,
			subplace: false,
			universeId: String(universeId),
			placeId: String(rootPlaceId),
			warnings,
		});
	} catch (e) {
		if (e instanceof RobloxError) {
			const status = PASSTHROUGH_STATUS.includes(e.status) ? e.status : 502;
			return jsonResponse({ ok: false, error: e.message }, status);
		}
		// Deliberately generic and not logged: nothing derived from the request may reach the logs.
		return jsonResponse({ ok: false, error: 'The request to Roblox failed. Please try again.' }, 502);
	}
}
