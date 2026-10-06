const zlib = require('zlib');
const { promisify } = require('util');

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const QUALITY = 9;

async function compressChunk(buffer) {
	const packed = await brotliCompress(buffer, {
		params: {
			[zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
			[zlib.constants.BROTLI_PARAM_QUALITY]: QUALITY,
			[zlib.constants.BROTLI_PARAM_LGWIN]: 22,
			[zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
		},
	});

	const check = await brotliDecompress(packed, { maxOutputLength: MAX_OUTPUT_BYTES });
	if (!check.equals(buffer)) {
		throw new Error('round-trip verification failed');
	}

	return packed.toString('base64url');
}

async function decompressChunk(text) {
	const packed = Buffer.from(String(text).trim(), 'base64url');
	if (packed.length === 0) {
		throw new Error('empty payload');
	}
	return brotliDecompress(packed, { maxOutputLength: MAX_OUTPUT_BYTES });
}

function register(app, express) {
	const rawBody = express.raw({ type: () => true, limit: MAX_REQUEST_BYTES });

	app.post('/compress', rawBody, async (req, res) => {
		if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
			return res.status(400).json({ error: 'empty request body' });
		}

		try {
			res.type('text/plain').send(await compressChunk(req.body));
		} catch (e) {
			console.warn('[SMFX Proxy] /compress failed:', e.message);
			res.status(500).json({ error: `compress failed: ${e.message}` });
		}
	});

	app.post('/decompress', rawBody, async (req, res) => {
		if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
			return res.status(400).json({ error: 'empty request body' });
		}

		try {
			res.type('application/octet-stream').send(await decompressChunk(req.body.toString('latin1')));
		} catch (e) {
			console.warn('[SMFX Proxy] /decompress failed:', e.message);
			res.status(400).json({ error: `decompress failed: ${e.message}` });
		}
	});
}

module.exports = { register, compressChunk, decompressChunk, MAX_REQUEST_BYTES };
