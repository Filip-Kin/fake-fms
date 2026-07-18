// Shared HTTP helpers. FMS allows cross-origin reads (the extension fetches from a
// different origin), so every response carries permissive CORS headers.

export const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-SignalR-User-Agent",
};

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

/** Respond with an already-serialized JSON string (used where key order must be hand-built). */
export function jsonRaw(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

/** HTTP 204 No Content, as real FMS answers endpoints that have nothing to report yet. */
export function noContent(): Response {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Many FMS GET endpoints return a bare JSON string (the value wrapped in quotes).
 * Consumers strip the surrounding quotes, so we must include them.
 */
export function quoted(value: string): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

export function text(body: string, status = 200, contentType = "text/html"): Response {
	return new Response(body, { status, headers: { "Content-Type": contentType, ...CORS_HEADERS } });
}

export function preflight(): Response {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function notFound(): Response {
	return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
}
