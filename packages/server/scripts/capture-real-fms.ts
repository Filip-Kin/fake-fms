// Ground-truth capture tool: connects to a REAL FMS and records every SignalR event and REST
// response verbatim, so the emulator can be diffed against reality field-by-field.
//
// It speaks the SignalR wire protocol directly (no @microsoft/signalr) so it logs EVERY event,
// including ones we don't know about. REST endpoints are snapshotted periodically (raw bytes, so
// quoting/formatting is preserved).
//
//   bun run scripts/capture-real-fms.ts [host] [outDir]
//   host defaults to 10.0.100.5, outDir defaults to ./fms-capture
//
// Drive the real FMS through a full cycle while this runs (create event, add teams, generate WPA
// keys, prestart, set audience, match ready, run auto+teleop, score live, commit, post results,
// and toggle robot DS/radio/rio/code/bypass/estop). Ctrl+C to stop. Then hand the fms-capture
// folder back (it lives under the project, which is on the NAS).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOST = process.argv[2] ?? "10.0.100.5";
const OUT = process.argv[3] ?? "./fms-capture";
const HUBS = ["/fieldMonitorHub", "/infrastructureHub", "/gameSpecificHub", "/ftaAppHub"];
const RS = "\x1e";

mkdirSync(join(OUT, "rest"), { recursive: true });
const signalrFile = join(OUT, "signalr.jsonl");
writeFileSync(signalrFile, "");
console.log(`Capturing real FMS at ${HOST} -> ${OUT}`);

// #region SignalR raw capture

async function captureHub(hubPath: string): Promise<void> {
	let connectionToken: string;
	try {
		const neg = await fetch(`http://${HOST}${hubPath}/negotiate?negotiateVersion=1`, { method: "POST" });
		const body = (await neg.json()) as { connectionToken?: string; connectionId?: string };
		connectionToken = body.connectionToken ?? body.connectionId ?? "";
	} catch (e) {
		console.warn(`[${hubPath}] negotiate failed:`, e);
		return;
	}

	const ws = new WebSocket(`ws://${HOST}${hubPath}?id=${encodeURIComponent(connectionToken)}`);
	ws.addEventListener("open", () => {
		ws.send(`{"protocol":"json","version":1}${RS}`);
		console.log(`[${hubPath}] connected`);
	});
	ws.addEventListener("message", (ev) => {
		const raw = typeof ev.data === "string" ? ev.data : "";
		for (const piece of raw.split(RS)) {
			if (!piece) continue;
			let msg: { type?: number; target?: string; arguments?: unknown[] };
			try {
				msg = JSON.parse(piece);
			} catch {
				continue;
			}
			if (msg.type === 6) {
				ws.send(`{"type":6}${RS}`); // pong
				continue;
			}
			if (msg.type === 1) {
				// Server -> client event. Record verbatim.
				appendFileSync(
					signalrFile,
					JSON.stringify({ t: new Date().toISOString(), hub: hubPath, target: msg.target, arguments: msg.arguments }) + "\n",
				);
				console.log(`[${hubPath}] ${msg.target}`);
			}
		}
	});
	ws.addEventListener("close", () => console.log(`[${hubPath}] closed`));
	ws.addEventListener("error", (e) => console.warn(`[${hubPath}] error`, e));
	setInterval(() => {
		if (ws.readyState === WebSocket.OPEN) ws.send(`{"type":6}${RS}`);
	}, 10000);
}

// #endregion

// #region REST snapshot

function safeName(path: string): string {
	return path.replace(/^\//, "").replace(/[/?=&:]/g, "_");
}

async function get(path: string): Promise<{ status: number; body: string }> {
	try {
		const res = await fetch(`http://${HOST}${path}`);
		return { status: res.status, body: await res.text() };
	} catch (e) {
		return { status: 0, body: String(e) };
	}
}

/** Endpoints both consumers use, plus useful extras. {matchId}/{level}/{n} get filled from live state. */
function endpoints(ctx: { matchId: string; level: string; matchNumber: number }): string[] {
	return [
		"/FieldMonitor",
		"/FieldMonitor/MatchNumberAndPlay",
		"/api/v1.0/systembase/get/get_CurrentlyActiveEventCode",
		"/api/v1.0/systembase/get/get_CurrentlyActiveEventName",
		"/api/v1.0/systembase/get/get_CurrentlyActiveTournamentLevel",
		"/api/v1.0/settings/get/get_VideoswitchOption",
		"/api/v1.0/audience/get/GetFMSVersion",
		"/api/v1.0/audience/get/GetEventInfo",
		"/api/v1.0/audience/get/GetCurrentMatchAndPlayNumber",
		"/api/v1.0/audience/get/GetAlliances",
		"/api/v1.0/audience/get/GetQualRankings",
		"/api/v1.0/audience/get/GetQualificationRankData",
		"/api/v1.0/audience_gs/get/GetGameConfig",
		"/api/v1.0/audience_gs/get/GetBracketData",
		"/api/v1.0/match/get/GetAllTeamNumbers",
		"/api/v1.0/match/get/GetCurrentSchedule",
		"/api/v1.0/match/get/GetCurrentResults",
		`/api/v1.0/fieldmonitor/get/GetResults/${ctx.level}`,
		`/api/v1.0/audience/get/Get${ctx.level === "Qualification" ? "Qual" : "Test"}MatchPreviewData/${ctx.matchNumber}`,
		`/api/v1.0/audience_gs/get/GetMatchResults${ctx.level === "Qualification" ? "Qual" : "Test"}Data/${ctx.matchNumber}`,
		`/api/v1.0/fieldmonitor/get/GetLog/${ctx.matchId}/Red/Station1`,
	];
}

async function snapshot(n: number): Promise<void> {
	const dir = join(OUT, "rest", `snap-${String(n).padStart(3, "0")}`);
	mkdirSync(dir, { recursive: true });
	// Discover live context first.
	let matchId = "00000000-0000-0000-0000-000000000000";
	let level = "Qualification";
	let matchNumber = 1;
	const cur = await get("/api/v1.0/audience/get/GetCurrentMatchAndPlayNumber");
	try {
		const j = JSON.parse(cur.body);
		level = j.item1 ?? level;
		matchNumber = j.item2 ?? matchNumber;
	} catch {
		/* ignore */
	}
	const sched = await get("/api/v1.0/match/get/GetCurrentSchedule");
	try {
		const arr = JSON.parse(sched.body);
		const m = arr.find((x: { matchNumber: number }) => x.matchNumber === matchNumber) ?? arr[0];
		if (m) matchId = m.fmsMatchId ?? m.scheduleDetailId ?? matchId;
	} catch {
		/* ignore */
	}
	for (const ep of endpoints({ matchId, level, matchNumber })) {
		const { status, body } = await get(ep);
		writeFileSync(join(dir, `${safeName(ep)}.json`), `// ${ep}  [HTTP ${status}]\n${body}`);
	}
	console.log(`REST snapshot ${n} written (match ${level} ${matchNumber})`);
}

// #endregion

for (const hub of HUBS) void captureHub(hub);
let snapN = 0;
await snapshot(snapN++);
setInterval(() => void snapshot(snapN++), 20000);

console.log("Capturing. Drive the FMS through a full match, then press Ctrl+C.");
process.on("SIGINT", () => {
	console.log("\nFinal REST snapshot...");
	void snapshot(snapN++).then(() => {
		console.log(`Done. Capture saved to ${OUT}`);
		process.exit(0);
	});
});
