// SMFX Proxy -- MCP relay (Cloudflare Worker + Durable Object).
//
// Claude (custom connector) --POST /mcp/<token>--> Worker --> Durable Object (one per token) <--POST /mcp/<token>/poll-- Roblox server
//
// - The token is generated INSIDE Roblox (no proxy request needed). The Worker never stores tokens: a Durable Object
//   is only touched by "tools/call" and "poll", so initialize / tools/list / ping cost no storage access.
// - Roblox long-polls /mcp/<token>/poll. Body: { results = { { id, ok, result, error } } }.
//   Response: { commands = { { id, tool, args } } } (empty list after ~25 s without work).
// - This proxy only relays structured tool calls. It never executes code and has no "run Luau" tool.

const TOKEN_RE = /^[A-Za-z0-9_-]{32,80}$/;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_ARGS_CHARS = 200 * 1024;
const POLL_WAIT_MS = 25000;
const CALL_WAIT_MS = 25000;
const CONNECTED_TTL_MS = 60000;
const MAX_PENDING = 20;
const MAX_BATCH = 10;
const MAX_RESULT_CHARS = 200 * 1024;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// Pre-prompt sent to Claude in the MCP "initialize" response (derived from the in-game AI assistant prompt in ai.js).
const INSTRUCTIONS = `
Você está conectado ao Studio Mobi, um editor de níveis Roblox que roda dentro de um jogo mobile. Ajude o jogador com Luau/scripting e com dúvidas sobre o editor. Aja no jogo apenas pelas ferramentas disponíveis; não invente ferramentas.

Caminhos (paths) sempre no formato "game/Workspace/NomeDoObjeto/NomeDoFilho", separados por "/", começando em "game". Toda propriedade que referencia outra instância (ex: Parent, PrimaryPart) também usa esse formato de caminho, como string.

Formato dos valores de propriedade:
- bool, número, string: direto (true, 5, "texto")
- Posição/tamanho/rotação (Position, Size, Orientation): {"x":0,"y":5,"z":0}. Use Position e Orientation para mover/girar, NUNCA CFrame diretamente.
- Color3: {"r":1,"g":0,"b":0} (0 a 1)
- BrickColor: o nome da cor como string, ex: "Bright red"
- Enum (Material, PartType, etc): só o nome do item, ex: "SmoothPlastic", "Neon"
- Instância (ex: Parent): caminho completo como string, ex: "game/Workspace/Baseplate"

Dicas: use get_tree antes de editar para confirmar os caminhos; edit_instance só altera as propriedades citadas; ao reescrever um script com write_script, envie o código completo e válido em Luau. Se o jogo não estiver conectado, peça ao jogador para ativar "Connect Claude" no Studio Mobi.
`.trim();

const PATH_HELP = 'Path like "game/Workspace/Part"';

const TOOLS = [
	{
		name: 'get_tree',
		description: 'Lists the children of an instance in the Explorer. Use path "game" for the root.',
		inputSchema: obj({ path: str(PATH_HELP), depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Levels to list (default 1)' } }, ['path']),
	},
	{
		name: 'get_properties',
		description: 'Reads properties of an instance. Omit "names" to read the common ones.',
		inputSchema: obj({ path: str(PATH_HELP), names: { type: 'array', items: { type: 'string' }, maxItems: 50 } }, ['path']),
	},
	{
		name: 'edit_instance',
		description: 'Changes properties of an existing instance. Properties not listed stay unchanged. See the server instructions for value formats.',
		inputSchema: obj({ path: str(PATH_HELP), properties: { type: 'object', description: 'Property name -> new value' } }, ['path', 'properties']),
	},
	{
		name: 'create_instance',
		description: 'Creates a new instance under a parent. See the server instructions for value formats.',
		inputSchema: obj({ className: str('Roblox class name'), parent: str('Parent path'), properties: { type: 'object', description: 'Initial properties (Name, Position, ...)' } }, ['className', 'parent']),
	},
	{
		name: 'delete_instance',
		description: 'Deletes an instance.',
		inputSchema: obj({ path: str(PATH_HELP) }, ['path']),
	},
	{
		name: 'copy_instance',
		description: 'Duplicates an instance under the same parent, or under "destPath" when given.',
		inputSchema: obj({ path: str(PATH_HELP), destPath: str('New parent path (optional)') }, ['path']),
	},
	{
		name: 'read_script',
		description: 'Returns the source of a Script, LocalScript or ModuleScript.',
		inputSchema: obj({ path: str('Script path') }, ['path']),
	},
	{
		name: 'write_script',
		description: 'Replaces the source of a Script, LocalScript or ModuleScript with complete, valid Luau.',
		inputSchema: obj({ path: str('Script path'), source: str('New source code') }, ['path', 'source']),
	},
	{
		name: 'get_console',
		description: 'Returns the most recent Console output and script errors.',
		inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Number of lines (default 50)' } }),
	},
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const json = (data, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// ---------------------------------------------------------------------------
// Worker side: MCP protocol (JSON-RPC over HTTP, "Streamable HTTP" without streaming)
// ---------------------------------------------------------------------------

async function handleRpc(message, token, env) {
	if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
		return rpcError(message && message.id, -32600, 'Invalid request.');
	}
	const { id, method, params } = message;
	const isNotification = id === undefined || id === null;
	if (isNotification) return null;

	if (method === 'initialize') {
		const asked = params && params.protocolVersion;
		return rpcResult(id, {
			protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: 'studio-mobi', version: '1.0.0' },
			instructions: INSTRUCTIONS,
		});
	}
	if (method === 'ping') return rpcResult(id, {});
	if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });

	if (method === 'tools/call') {
		const name = params && params.name;
		const args = (params && params.arguments) || {};
		if (!TOOL_NAMES.has(name)) return rpcError(id, -32602, `Unknown tool: ${String(name).slice(0, 40)}.`);
		if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'Tool arguments must be an object.');
		if (JSON.stringify(args).length > MAX_ARGS_CHARS) return rpcError(id, -32602, 'Tool arguments are too large.');

		const stub = env.MCP_RELAY.get(env.MCP_RELAY.idFromName(token));
		let outcome;
		try {
			const res = await stub.fetch('https://relay/call', { method: 'POST', body: JSON.stringify({ tool: name, args }) });
			outcome = await res.json();
		} catch (e) {
			outcome = { ok: false, error: 'The relay is temporarily unavailable. Please try again.' };
		}
		const text = outcome.ok ? JSON.stringify(outcome.result ?? null) : String(outcome.error || 'Unknown error.');
		return rpcResult(id, { content: [{ type: 'text', text: text.slice(0, MAX_RESULT_CHARS) }], isError: !outcome.ok });
	}

	return rpcError(id, -32601, `Method not found: ${method.slice(0, 40)}.`);
}

export async function handleMcp(request, env, url) {
	if (!env.MCP_RELAY) return json({ error: 'MCP relay is not configured (missing MCP_RELAY binding).' }, 503);

	const parts = url.pathname.split('/').filter(Boolean); // ['mcp', token, 'poll'?]
	const token = parts[1];
	if (!token || !TOKEN_RE.test(token)) return json({ error: 'Invalid token.' }, 404);

	if (request.method !== 'POST') {
		// Claude may probe with GET (SSE stream) or DELETE (end session); neither is supported.
		return new Response(null, { status: 405, headers: { Allow: 'POST' } });
	}

	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) return json({ error: 'Request body is too large.' }, 413);

	if (parts[2] === 'poll') {
		const stub = env.MCP_RELAY.get(env.MCP_RELAY.idFromName(token));
		return stub.fetch('https://relay/poll', { method: 'POST', body: text });
	}
	if (parts.length > 2) return json({ error: 'not found' }, 404);

	let body;
	try {
		body = JSON.parse(text);
	} catch (e) {
		return json(rpcError(null, -32700, 'Parse error.'), 400);
	}

	if (Array.isArray(body)) {
		if (body.length === 0 || body.length > MAX_BATCH) return json(rpcError(null, -32600, 'Invalid batch size.'), 400);
		const out = (await Promise.all(body.map((m) => handleRpc(m, token, env)))).filter(Boolean);
		return out.length ? json(out) : new Response(null, { status: 202 });
	}

	const reply = await handleRpc(body, token, env);
	return reply ? json(reply) : new Response(null, { status: 202 });
}

// ---------------------------------------------------------------------------
// Durable Object: one instance per token (command queue between Claude and Roblox)
// ---------------------------------------------------------------------------

export class McpRelay {
	constructor() {
		this.queue = []; // commands not yet delivered to Roblox
		this.pending = new Map(); // id -> { resolve, timer }
		this.waiter = null; // active long-poll { resolve, timer }
		this.lastPoll = 0;
	}

	async fetch(request) {
		const path = new URL(request.url).pathname;
		let body = {};
		try {
			body = JSON.parse((await request.text()) || '{}');
		} catch (e) {
			return json({ error: 'Invalid JSON body.' }, 400);
		}
		if (path === '/call') return json(await this.call(body));
		if (path === '/poll') return json(await this.poll(body));
		return json({ error: 'not found' }, 404);
	}

	call({ tool, args }) {
		if (Date.now() - this.lastPoll > CONNECTED_TTL_MS) {
			return { ok: false, error: 'Studio Mobi is not connected. Open the experience and enable "Connect Claude".' };
		}
		if (this.pending.size >= MAX_PENDING) return { ok: false, error: 'Too many pending commands. Please wait and retry.' };

		const id = crypto.randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.queue = this.queue.filter((c) => c.id !== id);
				resolve({ ok: false, error: 'Timed out waiting for Studio Mobi to respond.' });
			}, CALL_WAIT_MS);
			this.pending.set(id, { resolve, timer });
			this.queue.push({ id, tool, args });
			this.flush();
		});
	}

	poll({ results }) {
		this.lastPoll = Date.now();
		if (Array.isArray(results)) {
			for (const r of results.slice(0, MAX_PENDING)) {
				const entry = r && this.pending.get(r.id);
				if (!entry) continue;
				clearTimeout(entry.timer);
				this.pending.delete(r.id);
				entry.resolve(r.ok ? { ok: true, result: r.result } : { ok: false, error: String(r.error || 'The command failed.').slice(0, 2000) });
			}
		}
		if (this.waiter) this.release([]); // a newer poll replaces the previous one
		if (this.queue.length > 0) return { commands: this.queue.splice(0, 10) };

		return new Promise((resolve) => {
			const timer = setTimeout(() => this.release([]), POLL_WAIT_MS);
			this.waiter = { resolve: (commands) => resolve({ commands }), timer };
		});
	}

	flush() {
		if (this.waiter && this.queue.length > 0) this.release(this.queue.splice(0, 10));
	}

	release(commands) {
		const w = this.waiter;
		this.waiter = null;
		clearTimeout(w.timer);
		this.lastPoll = Date.now();
		w.resolve(commands);
	}
}
