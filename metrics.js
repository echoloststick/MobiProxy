// Per-route outbound byte counter, used to find which routes consume Render bandwidth.
// GET /stats returns totals since the last restart (in-memory only).

const stats = {};

function track(req, res, next) {
	const originalWrite = res.write;
	const originalEnd = res.end;
	let bytes = 0;

	res.write = function (chunk, ...rest) {
		if (chunk && typeof chunk !== 'function') bytes += Buffer.byteLength(chunk);
		return originalWrite.call(this, chunk, ...rest);
	};
	res.end = function (chunk, ...rest) {
		if (chunk && typeof chunk !== 'function') bytes += Buffer.byteLength(chunk);
		return originalEnd.call(this, chunk, ...rest);
	};

	res.on('finish', () => {
		const key = `${req.method} ${req.path}`;
		const entry = stats[key] || (stats[key] = { requests: 0, bytes: 0 });
		entry.requests += 1;
		entry.bytes += bytes;
	});

	next();
}

function register(app) {
	app.use(track);

	app.get('/stats', (req, res) => {
		const routes = Object.entries(stats)
			.map(([route, s]) => ({
				route,
				requests: s.requests,
				megabytes: Number((s.bytes / 1048576).toFixed(2)),
				avgKilobytes: Number((s.bytes / s.requests / 1024).toFixed(1)),
			}))
			.sort((a, b) => b.megabytes - a.megabytes);
		const totalMegabytes = Number(routes.reduce((sum, r) => sum + r.megabytes, 0).toFixed(2));
		res.json({ totalMegabytes, routes });
	});
}

module.exports = { register };
