import { fileURLToPath } from "node:url";
import { DEFAULT_GAME_ID } from "shared";
import { wireFanout } from "./fanout";
import { notFound, preflight, text } from "./http";
import { handleControl } from "./control/api";
import { MatchController } from "./match/controller";
import { handleReports } from "./reports";
import { handleRest } from "./rest/router";
import { type ConnData, type ServerSocket } from "./signalr/hub";
import { registerHubHandlers } from "./signalr/handlers";
import { clientCounts, connectionIdForToken, hubForPath, hubs, negotiateResponse, pingAllHubs } from "./signalr/registry";
import { makeSeedState } from "./state/seed";
import { FmsStore } from "./state/store";
import { fetchEventData } from "./tba";
import { dotnetTicks } from "./util/dotnet-time";

const FMS_PORT = Number(process.env.FMS_PORT ?? 80);
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 3010);
const GAME_ID = process.env.GAME_ID ?? DEFAULT_GAME_ID;
const TBA_API_KEY = process.env.TBA_API_KEY;

const store = new FmsStore(makeSeedState(GAME_ID));
const controller = new MatchController(store);
wireFanout(store);
registerHubHandlers(store);

/** Replace generated seed data with the real teams + schedule from TBA, if a key is set. */
export async function loadFromTba(): Promise<void> {
	if (!TBA_API_KEY) {
		console.log("[tba] no TBA_API_KEY set; using generated seed data");
		return;
	}
	const s = store.getState();
	const eventKey = `${s.event.season}${s.event.code}`;
	const data = await fetchEventData(eventKey, TBA_API_KEY);
	if (!data) {
		console.warn(`[tba] no data for ${eventKey}; keeping generated seed`);
		return;
	}
	store.setTeams(data.teams);
	store.setSchedule(data.schedule);
	store.setRankings(
		data.teams.map((t, i) => ({
			rank: i + 1,
			teamNumber: t.number,
			isDeclined: false,
			pickStatus: "None",
			inPotentialCaptainPosition: i < 8,
		})),
	);
	const entry =
		data.schedule.find((e) => e.matchNumber === s.current.matchNumber && e.level === s.current.level) ??
		data.schedule[0];
	if (entry) store.loadStationsFromMatch(entry.red, entry.blue);
	console.log(`[tba] loaded ${data.teams.length} teams, ${data.schedule.length} matches for ${eventKey}`);
}

// #region FMS server (SignalR hubs + REST) on port 80

const fmsServer = Bun.serve<ConnData>({
	port: FMS_PORT,
	hostname: "0.0.0.0",
	idleTimeout: 60,
	async fetch(req, server) {
		const url = new URL(req.url);
		if (req.method === "OPTIONS") return preflight();

		const hub = hubForPath(url.pathname);
		const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
		if (hub && isUpgrade) {
			const connectionToken = url.searchParams.get("id") ?? "";
			const ok = server.upgrade(req, {
				data: {
					hubPath: hub.path,
					connectionToken,
					// Reuse the connectionId the client negotiated, like real ASP.NET Core SignalR.
					connectionId: connectionIdForToken(connectionToken),
					handshaken: false,
				},
			});
			return ok ? undefined : new Response("Upgrade failed", { status: 400 });
		}

		if (url.pathname.endsWith("/negotiate") && hub) return negotiateResponse();

		const reports = await handleReports(req, url.pathname);
		if (reports) return reports;

		const rest = await handleRest(store, req, url);
		return rest ?? notFound();
	},
	websocket: {
		open(ws: ServerSocket) {
			hubForPath(ws.data.hubPath)?.add(ws);
		},
		async message(ws: ServerSocket, message: string | Buffer) {
			const raw = typeof message === "string" ? message : message.toString("utf8");
			await hubForPath(ws.data.hubPath)?.handleMessage(ws, raw);
		},
		close(ws: ServerSocket) {
			hubForPath(ws.data.hubPath)?.remove(ws);
		},
	},
});

// #endregion

// #region control server (control API + UI + state websocket) on port 3010

const UI_DIST = new URL("../../ui/dist/", import.meta.url);

async function serveUi(url: URL): Promise<Response> {
	const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
	const file = Bun.file(fileURLToPath(new URL(rel, UI_DIST)));
	if (await file.exists()) return new Response(file);
	const index = Bun.file(fileURLToPath(new URL("index.html", UI_DIST)));
	if (await index.exists()) return new Response(index);
	return text(
		"Fake FMS control UI is not built. Run `bun run build`, or use the Vite dev server (bun run ui) on http://localhost:5173",
	);
}

interface ControlConn {
	kind: "control";
}

const controlServer = Bun.serve<ControlConn>({
	port: CONTROL_PORT,
	hostname: "0.0.0.0",
	async fetch(req, server) {
		const url = new URL(req.url);
		if (req.method === "OPTIONS") return preflight();
		if (url.pathname === "/ws") {
			const ok = server.upgrade(req, { data: { kind: "control" } });
			return ok ? undefined : new Response("Upgrade failed", { status: 400 });
		}
		const ctrl = await handleControl(store, controller, req, url);
		if (ctrl) return ctrl;
		return serveUi(url);
	},
	websocket: {
		open(ws) {
			ws.subscribe("state");
			ws.send(JSON.stringify({ type: "state", data: store.getState() }));
		},
		message() {
			// control UI does not send messages; mutations go over the REST control API
		},
		close() {},
	},
});

// Push a fresh snapshot to all control UIs after any mutation.
store.on("stateChanged", (state) => {
	state.clients = clientCounts();
	controlServer.publish("state", JSON.stringify({ type: "state", data: state }));
});

// Refresh hub client counts periodically even when idle so the UI stays accurate.
setInterval(() => {
	store.getState().clients = clientCounts();
	controlServer.publish("state", JSON.stringify({ type: "state", data: store.getState() }));
}, 2000);

// #endregion

// Real FMS streams GlobalTimerChanged (current .NET ticks, on the infrastructure hub) and the
// current field-monitor frames continuously at ~1 Hz, even when idle - not just on change. This
// heartbeat reproduces that so consumers see the same steady traffic a real field produces.
setInterval(() => {
	hubs.infrastructureHub.broadcast("GlobalTimerChanged", dotnetTicks());
	hubs.fieldMonitorHub.broadcast("FieldMonitorDataChanged", store.monitorFrames());
}, 1000);

// SignalR keepalive ping across all hubs.
setInterval(pingAllHubs, 15000);

console.log(`Fake FMS listening: FMS http://0.0.0.0:${fmsServer.port}  control http://0.0.0.0:${controlServer.port}`);

// Populate real event data from TBA in the background once the servers are up.
void loadFromTba();
