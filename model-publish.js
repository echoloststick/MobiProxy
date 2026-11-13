// SMFX Proxy -- POST /publishmodel: uploads a model file (FBX, GLTF, GLB, RBXM, RBXMX) to the Open Cloud Assets API.
// Works on Render (Express) and Cloudflare (Worker): both runtimes provide fetch, FormData and Blob.
// Express:  require('./model-publish').register(app, express);
// Worker:   import { handleWorker as handlePublishModel } from './model-publish.js';
//           if (request.method === 'POST' && path === '/publishmodel') return handlePublishModel(request);

const ASSETS_URL = 'https://apis.roblox.com/assets/v1/assets';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_NAME_LENGTH = 50;

const FORMATS = {
	FBX: { type: 'model/fbx', ext: 'fbx' },
	GLTF: { type: 'model/gltf+json', ext: 'gltf' },
	GLB: { type: 'model/gltf-binary', ext: 'glb' },
	RBXM: { type: 'model/x-rbxm', ext: 'rbxm' },
	RBXMX: { type: 'model/x-rbxm', ext: 'rbxmx' },
};

function fail(status, message) {
	return { status, contentType: 'application/json', body: JSON.stringify({ error: message }) };
}

function readName(raw) {
	let name = 'Model';
	if (raw) {
		try {
			name = decodeURIComponent(String(raw));
		} catch (e) {
			name = String(raw);
		}
	}
	name = name.trim().slice(0, MAX_NAME_LENGTH);
	return name || 'Model';
}

async function publishModel({ apiKey, format, displayName, creatorId, bytes }) {
	if (!apiKey) return fail(400, 'missing x-api-key header');

	const spec = FORMATS[String(format || '').toUpperCase()];
	if (!spec) return fail(400, `unsupported x-format header (use ${Object.keys(FORMATS).join(', ')})`);

	if (!/^\d+$/.test(String(creatorId || ''))) return fail(400, 'missing or invalid x-creator-id header');
	if (!bytes || bytes.length === 0) return fail(400, 'empty request body');
	if (bytes.length > MAX_BYTES) return fail(413, 'file exceeds the 20 MB limit');

	const name = readName(displayName);
	const form = new FormData();
	form.append(
		'request',
		JSON.stringify({
			assetType: 'Model',
			displayName: name,
			description: 'Published with Studio Mobi',
			creationContext: { creator: { userId: String(creatorId) } },
		})
	);
	form.append('fileContent', new Blob([bytes], { type: spec.type }), `${name.replace(/[^\w\-]+/g, '_')}.${spec.ext}`);

	try {
		const upstream = await fetch(ASSETS_URL, { method: 'POST', headers: { 'x-api-key': apiKey }, body: form });
		return {
			status: upstream.status,
			contentType: upstream.headers.get('content-type') || 'application/json',
			body: await upstream.text(),
		};
	} catch (e) {
		return fail(502, `upstream request failed: ${e.message}`);
	}
}

function register(app, express) {
	app.post('/publishmodel', express.raw({ type: 'application/octet-stream', limit: MAX_BYTES }), async (req, res) => {
		const result = await publishModel({
			apiKey: req.headers['x-api-key'],
			format: req.headers['x-format'],
			displayName: req.headers['x-display-name'],
			creatorId: req.headers['x-creator-id'],
			bytes: Buffer.isBuffer(req.body) ? req.body : null,
		});
		res.status(result.status).type(result.contentType).send(result.body);
	});
}

async function handleWorker(request) {
	const result = await publishModel({
		apiKey: request.headers.get('x-api-key'),
		format: request.headers.get('x-format'),
		displayName: request.headers.get('x-display-name'),
		creatorId: request.headers.get('x-creator-id'),
		bytes: new Uint8Array(await request.arrayBuffer()),
	});
	return new Response(result.body, { status: result.status, headers: { 'Content-Type': result.contentType } });
}

module.exports = { register, handleWorker, publishModel };
