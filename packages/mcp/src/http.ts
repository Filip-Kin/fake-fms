// #region Fake FMS MCP server over the network (Streamable HTTP)
//
// Exposes the same tools as the stdio server, but over the MCP Streamable HTTP transport so a
// remote Claude Code can use it with no local copy of the repo:
//
//   claude mcp add --transport http fake-fms http://10.0.100.5:3010/mcp
//
// The emulator's control server mounts `createMcpHandler()` at /mcp (see packages/server/index.ts),
// so it rides on the already-exposed control port. This file can also run standalone:
//
//   FAKE_FMS_CONTROL_URL=http://10.0.100.5:3010 MCP_PORT=3011 bun run packages/mcp/src/http.ts
//
// Sessions are stateful (one transport + server per Mcp-Session-Id), which is what real MCP clients
// expect: they initialize once, then reuse the session id for every tool call.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./server.js";

function jsonRpcError(status: number, message: string): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Returns a fetch-style handler for the MCP Streamable HTTP endpoint. Mount it on any route that
 * receives GET/POST/DELETE for the endpoint URL.
 */
export function createMcpHandler(baseUrl: string): (req: Request) => Promise<Response> {
	const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

	return async (req: Request): Promise<Response> => {
		const sessionId = req.headers.get("mcp-session-id") ?? undefined;

		if (sessionId) {
			const existing = transports.get(sessionId);
			// Unknown session (e.g. the server restarted): 404 tells the client to re-initialize.
			if (!existing) return jsonRpcError(404, "Session not found");
			return existing.handleRequest(req);
		}

		// No session id: this must be the initialize request. Spin up a fresh transport + server.
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (sid) => {
				transports.set(sid, transport);
			},
			onsessionclosed: (sid) => {
				transports.delete(sid);
			},
		});
		transport.onclose = () => {
			if (transport.sessionId) transports.delete(transport.sessionId);
		};
		const server = buildServer(baseUrl);
		await server.connect(transport);
		return transport.handleRequest(req);
	};
}

// #endregion

// #region standalone runner

// Run as its own process (a separate port) when executed directly, rather than mounted into the
// emulator's control server. import.meta.main is true only for the entry module under Bun.
if (import.meta.main) {
	const baseUrl = process.env.FAKE_FMS_CONTROL_URL ?? "http://10.0.100.5:3010";
	const port = Number(process.env.MCP_PORT ?? 3011);
	const handler = createMcpHandler(baseUrl);
	Bun.serve({
		port,
		hostname: "0.0.0.0",
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/mcp") return handler(req);
			return new Response("Fake FMS MCP. POST /mcp", { status: 404 });
		},
	});
	console.log(`Fake FMS MCP (Streamable HTTP) on http://0.0.0.0:${port}/mcp -> control ${baseUrl}`);
}

// #endregion
