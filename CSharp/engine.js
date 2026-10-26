const fs = require('fs');
const path = require('path');
const { parse } = require('./parser');
const { generate } = require('./gen-class');

const VERSION = '1.0.0';
const MAX_SOURCE = 1000000;
const RUNTIME_FILES = ['runtime-core.lua', 'runtime-lib.lua', 'runtime-unity.lua'];

let runtimeCache = null;

function runtimeSource() {
	if (!runtimeCache) {
		runtimeCache = RUNTIME_FILES.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
	}
	return runtimeCache;
}

function hasRobloxHeader(source) {
	const skip = /^(?:\s+|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)*/;
	let rest = source.replace(/^\uFEFF/, '');
	for (;;) {
		rest = rest.replace(skip, '');
		const m = rest.match(/^using\s+([A-Za-z0-9_.]+)\s*;/);
		if (!m) {
			return false;
		}
		if (m[1] === 'Roblox') {
			return true;
		}
		rest = rest.slice(m[0].length);
	}
}

function isCSharp(source) {
	return typeof source === 'string' && hasRobloxHeader(source);
}

function compile(source, options) {
	const opt = options || {};
	if (typeof source !== 'string' || source.trim() === '') {
		return { ok: false, partial: false, source: null, diagnostics: [{ code: 'CS9001', severity: 'error', message: "The 'source' field is required and must be a non-empty string.", line: 0, column: 0 }] };
	}
	if (source.length > MAX_SOURCE) {
		return { ok: false, partial: false, source: null, diagnostics: [{ code: 'CS9002', severity: 'error', message: `The script exceeds the ${MAX_SOURCE} character limit.`, line: 0, column: 0 }] };
	}
	if (!hasRobloxHeader(source)) {
		return { ok: false, partial: false, source: null, diagnostics: [{ code: 'CS9003', severity: 'error', message: "A C# script must start with 'using Roblox;'.", line: 1, column: 1 }] };
	}
	const unit = parse(source);
	const out = generate(unit, { prelude: opt.prelude, runtimeRequire: opt.runtimeRequire, runtimeSource: (opt.prelude || 'embedded') === 'embedded' ? runtimeSource() : '' });
	const errors = out.diagnostics.filter((d) => d.severity === 'error').length;
	const totalLines = source.split('\n').length;
	return {
		ok: errors === 0,
		partial: errors > 0,
		source: out.source,
		sourceMap: opt.sourceMap === false ? undefined : { luaToCs: out.luaToCs },
		diagnostics: out.diagnostics,
		stoppedAt: out.stoppedAt,
		convertedLines: out.stoppedAt ? Math.max(out.stoppedAt.line - 1, 0) : totalLines,
		totalLines,
		stats: { classes: out.classes.length, errors, warnings: out.diagnostics.length - errors, luaLines: out.source.split('\n').length },
	};
}

function register(app, express) {
	const router = express.Router();
	router.use(express.json({ limit: '4mb' }));

	router.get('/status', (req, res) => {
		res.json({ ok: true, version: VERSION, trigger: 'using Roblox;', prelude: ['embedded', 'module', 'injected'] });
	});

	router.get('/runtime', (req, res) => {
		const body = runtimeSource();
		res.type('text/plain').send(req.query.format === 'module' ? `return (function()\n${body}\nend)()` : body);
	});

	router.post('/detect', (req, res) => {
		res.json({ csharp: isCSharp((req.body || {}).source) });
	});

	function handler(withSource) {
		return (req, res) => {
			const body = req.body || {};
			try {
				const result = compile(body.source !== undefined ? body.source : body.code, body.options);
				if (!withSource) {
					result.source = undefined;
					result.sourceMap = undefined;
				}
				res.json(result);
			} catch (e) {
				console.error(`[SMFX Proxy] CSharp conversion failed: ${e.message}`);
				res.status(500).json({ ok: false, error: `conversion failed: ${e.message}` });
			}
		};
	}

	router.post('/compile', handler(true));
	router.post('/validate', handler(false));

	router.use((err, req, res, next) => {
		if (err && err.type === 'entity.too.large') {
			return res.status(413).json({ ok: false, error: 'request body too large' });
		}
		return res.status(400).json({ ok: false, error: 'invalid JSON body' });
	});

	app.use('/csharp', router);
}

module.exports = { register, compile, isCSharp };
