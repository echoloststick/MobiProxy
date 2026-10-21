'use strict';

const MAX_TEXTS = 100;
const MAX_TEXT_LENGTH = 1000;
const MAX_TOTAL_LENGTH = 12000;
const CACHE_LIMIT = 30000;
const CONCURRENCY = 6;
const DEFAULT_SOURCE = 'en';

const ENGINE = (process.env.TRANSLATE_ENGINE || 'google').toLowerCase();
const ENGINE_KEY = process.env.TRANSLATE_KEY || undefined;
const ENGINE_URL = process.env.TRANSLATE_URL || undefined;

const PROTECTED_PATTERN = /(<[^>]*>|&[a-zA-Z]+;|&#\d+;)/;
const HAS_LETTER = /\p{L}/u;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/;
const LANGUAGE_ALIASES = {
	zh: 'zh-CN',
	'zh-cn': 'zh-CN',
	'zh-hans': 'zh-CN',
	'zh-tw': 'zh-TW',
	'zh-hant': 'zh-TW',
	fil: 'tl',
};

const cache = new Map();
let translatorPromise = null;

function loadTranslator() {
	if (!translatorPromise) {
		translatorPromise = import('translate').then((module) => module.default || module);
		translatorPromise.catch(() => {
			translatorPromise = null;
		});
	}
	return translatorPromise;
}

function normalizeLanguage(code) {
	if (typeof code !== 'string') {
		return null;
	}
	const lower = code.trim().toLowerCase().replace(/_/g, '-');
	if (!LANGUAGE_PATTERN.test(lower)) {
		return null;
	}
	if (Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, lower)) {
		return LANGUAGE_ALIASES[lower];
	}
	return lower.split('-')[0];
}

function cacheKey(source, target, text) {
	return `${source}\u0000${target}\u0000${text}`;
}

function cacheSet(key, value) {
	if (cache.size >= CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		cache.delete(oldest);
	}
	cache.set(key, value);
}

async function runPool(items, worker, limit) {
	const results = new Array(items.length).fill(null);
	let nextIndex = 0;

	async function lane() {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await worker(items[index]);
		}
	}

	const lanes = [];
	const laneCount = Math.min(limit, items.length);
	for (let i = 0; i < laneCount; i += 1) {
		lanes.push(lane());
	}
	await Promise.all(lanes);
	return results;
}

async function translateOne(translator, text, source, target) {
	const options = { from: source, to: target, engine: ENGINE };
	if (ENGINE_KEY) {
		options.key = ENGINE_KEY;
	}
	if (ENGINE_URL) {
		options.url = ENGINE_URL;
	}

	try {
		const result = await translator(text, options);
		return typeof result === 'string' && result !== '' ? result : null;
	} catch (e) {
		console.warn(`[SMFX Proxy] Translation request failed (${ENGINE}): ${e.message}`);
		return null;
	}
}

async function translateCores(cores, source, target) {
	let translator;
	try {
		translator = await loadTranslator();
	} catch (e) {
		console.warn(`[SMFX Proxy] The "translate" package could not be loaded: ${e.message}`);
		return cores.map(() => null);
	}
	return runPool(cores, (core) => translateOne(translator, core, source, target), CONCURRENCY);
}

async function resolveCores(cores, source, target) {
	const results = new Map();
	const missing = [];

	for (const core of cores) {
		const cached = cache.get(cacheKey(source, target, core));
		if (cached !== undefined) {
			results.set(core, cached);
		} else {
			missing.push(core);
		}
	}

	if (missing.length > 0) {
		const translated = await translateCores(missing, source, target);
		missing.forEach((core, index) => {
			const value = translated[index];
			if (typeof value === 'string' && value !== '') {
				cacheSet(cacheKey(source, target, core), value);
				results.set(core, value);
			} else {
				results.set(core, null);
			}
		});
	}

	return results;
}

function splitText(text) {
	return text.split(PROTECTED_PATTERN).map((piece, index) => {
		if (index % 2 === 1) {
			return { raw: piece };
		}
		const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(piece);
		return { lead: match[1], core: match[2], trail: match[3] };
	});
}

function needsTranslation(part) {
	return part.raw === undefined && part.core !== '' && HAS_LETTER.test(part.core);
}

async function translateTexts(texts, source, target) {
	if (source === target) {
		return texts.slice();
	}

	const parsed = texts.map(splitText);
	const needed = new Set();
	for (const parts of parsed) {
		for (const part of parts) {
			if (needsTranslation(part)) {
				needed.add(part.core);
			}
		}
	}

	const results = await resolveCores([...needed], source, target);

	return parsed.map((parts) => {
		let output = '';
		for (const part of parts) {
			if (part.raw !== undefined) {
				output += part.raw;
			} else if (!needsTranslation(part)) {
				output += part.lead + part.core + part.trail;
			} else {
				const translated = results.get(part.core);
				if (translated === null || translated === undefined) {
					return null;
				}
				output += part.lead + translated + part.trail;
			}
		}
		return output;
	});
}

function validateTexts(body) {
	if (!body || !Array.isArray(body.texts)) {
		return 'The "texts" field must be an array of strings.';
	}
	if (body.texts.length === 0 || body.texts.length > MAX_TEXTS) {
		return `The "texts" field must contain between 1 and ${MAX_TEXTS} items.`;
	}
	let total = 0;
	for (const text of body.texts) {
		if (typeof text !== 'string') {
			return 'Every item in "texts" must be a string.';
		}
		if (text.length > MAX_TEXT_LENGTH) {
			return `Each text must not exceed ${MAX_TEXT_LENGTH} characters.`;
		}
		total += text.length;
	}
	if (total > MAX_TOTAL_LENGTH) {
		return `The combined length of the texts must not exceed ${MAX_TOTAL_LENGTH} characters.`;
	}
	return null;
}

function register(app) {
	app.post('/translate', async (req, res) => {
		const body = req.body || {};

		const problem = validateTexts(body);
		if (problem) {
			return res.status(400).json({ ok: false, error: problem });
		}

		const target = normalizeLanguage(body.target);
		if (!target) {
			return res.status(400).json({ ok: false, error: 'The "target" field must be a valid language code.' });
		}

		const source = body.source === undefined ? DEFAULT_SOURCE : normalizeLanguage(body.source);
		if (!source) {
			return res.status(400).json({ ok: false, error: 'The "source" field must be a valid language code.' });
		}

		try {
			const translated = await translateTexts(body.texts, source, target);
			res.json({
				ok: true,
				source,
				target,
				translations: translated.map((value) => (typeof value === 'string' ? value : '')),
			});
		} catch (e) {
			console.warn('[SMFX Proxy] /translate failed:', e.message);
			res.status(500).json({ ok: false, error: `Translation failed: ${e.message}` });
		}
	});
}

module.exports = { register, translateTexts, normalizeLanguage };
