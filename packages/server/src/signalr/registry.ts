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

/** Standard SignalR negotiate response (negotiateVersion 1, WebSockets only). */
export function negotiateResponse(): Response {
	return json({
		connectionId: crypto.randomUUID(),
		connectionToken: crypto.randomUUID(),
		negotiateVersion: 1,
		availableTransports: [{ transport: "WebSockets", transferFormats: ["Text", "Binary"] }],
	});
}
