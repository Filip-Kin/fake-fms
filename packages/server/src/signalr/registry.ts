import type { HubClientCounts } from "shared";
import { json } from "../http";
import { Hub } from "./hub";

export const hubs = {
	fieldMonitorHub: new Hub("fieldMonitorHub", "/fieldMonitorHub"),
	infrastructureHub: new Hub("infrastructureHub", "/infrastructureHub"),
	gameSpecificHub: new Hub("gameSpecificHub", "/gameSpecificHub"),
	ftaAppHub: new Hub("ftaAppHub", "/ftaAppHub"),
} as const;

const byPath = new Map<string, Hub>();
for (const h of Object.values(hubs)) byPath.set(h.path.toLowerCase(), h);

/** Resolve the hub for a websocket path or a `/{hub}/negotiate` path. */
export function hubForPath(pathname: string): Hub | undefined {
	let p = pathname.toLowerCase();
	if (p.endsWith("/negotiate")) p = p.slice(0, -"/negotiate".length);
	return byPath.get(p);
}

/** Send a keepalive ping across every hub. */
export function pingAllHubs(): void {
	for (const h of Object.values(hubs)) h.pingAll();
}

export function clientCounts(): HubClientCounts {
	return {
		fieldMonitorHub: hubs.fieldMonitorHub.clientCount,
		infrastructureHub: hubs.infrastructureHub.clientCount,
		gameSpecificHub: hubs.gameSpecificHub.clientCount,
		ftaAppHub: hubs.ftaAppHub.clientCount,
	};
}

// Real ASP.NET Core SignalR generates connectionId/connectionToken as base64url of 16 random bytes
// (~22 chars, no padding), NOT UUIDs. Reproduce that, and remember token -> id so the WebSocket
// upgrade can reuse the same connectionId the client negotiated.
function base64UrlId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

const tokenToConnectionId = new Map<string, string>();

/** The connectionId negotiated for a given connectionToken, or a fresh one if unknown. */
export function connectionIdForToken(token: string): string {
	return tokenToConnectionId.get(token) ?? base64UrlId();
}

/** Standard SignalR negotiate response (negotiateVersion 1, WebSockets only). */
export function negotiateResponse(): Response {
	const connectionId = base64UrlId();
	const connectionToken = base64UrlId();
	tokenToConnectionId.set(connectionToken, connectionId);
	// Key order matches ASP.NET Core's NegotiateProtocol output.
	return json({
		negotiateVersion: 1,
		connectionId,
		connectionToken,
		availableTransports: [{ transport: "WebSockets", transferFormats: ["Text", "Binary"] }],
	});
}
