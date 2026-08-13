/**
 * The Cheesy Arena emulation server: a third Bun.serve (default :8080) that projects the same FmsStore
 * as a Team254 Cheesy Arena field. Everything is gated by store.caEnabled (the UI toggle): when off,
 * HTTP answers 503 and websocket upgrades are refused, and any open CA sockets are closed. The FMS
 * SignalR/REST servers keep running regardless.
 */
import { preflight } from "../http";
import type { MatchController } from "../match/controller";
import type { FmsStore } from "../state/store";
import { wireCaFanout } from "./fanout";
import { caCheckOrigin, caWsRoute, handleCaHttp } from "./http";
import { CaNotifierHub, type CaSocketData } from "./notifiers";
import { caMatchTimeSec } from "./projectors";

const CA_PORT = Number(process.env.CA_PORT ?? 8080);
const HEARTBEAT_MS = 500; // CA emits arenaStatus roughly twice a second.
const PING_MS = 10_000; // CA pings every 10s.

export function startCaServer(store: FmsStore, controller: MatchController) {
	const hub = new CaNotifierHub(store, controller);
	wireCaFanout(store, hub);

	const server = Bun.serve<CaSocketData>({
		port: CA_PORT,
		hostname: "0.0.0.0",
		idleTimeout: 60,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (req.method === "OPTIONS") return preflight();

			const enabled = store.getState().caEnabled;

			// Websocket upgrade for a CA display/panel/api socket.
			const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
			const route = caWsRoute(url.pathname);
			if (route && isUpgrade) {
				if (!enabled) return new Response("Cheesy Arena mode is off", { status: 503 });
				if (!caCheckOrigin(req)) return new Response("Origin not allowed", { status: 403 });
				const ok = srv.upgrade(req, {
					data: {
						kind: "ca",
						socketType: route.socketType,
						path: url.pathname + (url.search || ""),
						position: route.position,
					},
				});
				return ok ? undefined : new Response("Upgrade failed", { status: 400 });
			}

			if (!enabled) return new Response("Cheesy Arena mode is off", { status: 503 });
			const res = handleCaHttp(store, req, url);
			return res ?? new Response("Not Found", { status: 404 });
		},
		websocket: {
			open(ws) {
				hub.open(ws);
			},
			message(ws, message) {
				hub.message(ws, typeof message === "string" ? message : message.toString("utf8"));
			},
			close(ws) {
				hub.close(ws);
			},
		},
	});

	// Heartbeat: CA streams arenaStatus continuously; matchTime advances once per second while running.
	let lastSec = -1;
	setInterval(() => {
		if (!store.getState().caEnabled || hub.connectionCount === 0) return;
		hub.emit("arenaStatus");
		const sec = caMatchTimeSec(store);
		if (sec !== lastSec) {
			lastSec = sec;
			hub.emit("matchTime");
		}
	}, HEARTBEAT_MS);

	// 10s keepalive ping, like CA.
	setInterval(() => {
		if (hub.connectionCount > 0) hub.ping();
	}, PING_MS);

	// Turning the toggle off drops every open CA socket.
	store.on("caModeChanged", (on) => {
		if (!on) hub.closeAll();
	});

	console.log(`Cheesy Arena emulation listening: http://0.0.0.0:${server.port} (gated by CA toggle)`);
	return server;
}
