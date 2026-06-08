// End-to-end smoke test: connects with the real @microsoft/signalr client (the same client
// FTA-Buddy and audience-display use), drives the emulator through its control API, and
// asserts the correct SignalR events arrive. Run the server first (on the ports below).
//
//   FMS_PORT=8080 CONTROL_PORT=3010 bun run src/index.ts &
//   SMOKE_FMS_PORT=8080 SMOKE_CONTROL_PORT=3010 bun run scripts/smoke.ts

import { HubConnectionBuilder, type HubConnection } from "@microsoft/signalr";

const HOST = process.env.SMOKE_HOST ?? "localhost";
const FMS = `http://${HOST}:${process.env.SMOKE_FMS_PORT ?? 8080}`;
const CONTROL = `http://${HOST}:${process.env.SMOKE_CONTROL_PORT ?? 3010}`;

let failures = 0;
function check(name: string, ok: boolean): void {
	console.log(`${ok ? "  ok " : "FAIL "} ${name}`);
	if (!ok) failures++;
}

function waitFor(predicate: () => boolean, ms = 4000): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const t = setInterval(() => {
			if (predicate()) {
				clearInterval(t);
				resolve(true);
			} else if (Date.now() - start > ms) {
				clearInterval(t);
				resolve(false);
			}
		}, 50);
	});
}

async function post(path: string, body?: unknown): Promise<void> {
	await fetch(`${CONTROL}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : "{}",
	});
}

function build(path: string): HubConnection {
	return new HubConnectionBuilder().withUrl(`${FMS}${path}`).build();
}

async function main(): Promise<void> {
	const field = build("/fieldMonitorHub");
	const infra = build("/infrastructureHub");
	const game = build("/gameSpecificHub");

	const received = {
		matchStatus: false,
		fieldData: false,
		blueScore: false,
		timer: false,
	};

	infra.on("matchstatusinfochanged", () => (received.matchStatus = true));
	infra.on("matchtimerchanged", () => (received.timer = true));
	field.on("fieldmonitordatachanged", () => (received.fieldData = true));
	game.on("BlueScoreChanged", () => (received.blueScore = true));

	await Promise.all([field.start(), infra.start(), game.start()]);
	check("connected to all hubs", true);

	// REST surface
	const eventCode = await (await fetch(`${FMS}/api/v1.0/systembase/get/get_CurrentlyActiveEventCode`)).text();
	check("event code is quoted JSON string", eventCode.startsWith('"') && eventCode.endsWith('"'));

	const schedule = (await (await fetch(`${FMS}/api/v1.0/match/get/GetCurrentSchedule`)).json()) as unknown[];
	check("schedule returns matches", Array.isArray(schedule) && schedule.length > 0);

	const teams = (await (await fetch(`${FMS}/api/v1.0/match/get/GetAllTeamNumbers`)).json()) as number[];
	check("team numbers returned", Array.isArray(teams) && teams.length > 0);

	const cfg = await (await fetch(`${FMS}/api/v1.0/audience_gs/get/GetGameConfig`)).json();
	check("game config returned", typeof cfg === "object" && cfg !== null);

	const fm = await (await fetch(`${FMS}/FieldMonitor`)).text();
	check("FieldMonitor health returns html", fm.includes("FieldMonitor"));

	// Control-driven SignalR
	await post("/control/match/prestart");
	check("MatchStatusInfoChanged received after prestart", await waitFor(() => received.matchStatus));
	check("FieldMonitorDataChanged received after prestart", await waitFor(() => received.fieldData));

	await post("/control/station/red1/cycle");
	check("FieldMonitorDataChanged on station cycle", await waitFor(() => received.fieldData));

	await post("/control/score", { alliance: "Blue", key: "autoFuelPoints", value: 12 });
	check("BlueScoreChanged received after score edit", await waitFor(() => received.blueScore));

	await post("/control/match/start");
	check("MatchTimerChanged received after match start", await waitFor(() => received.timer));

	await Promise.all([field.stop(), infra.stop(), game.stop()]);

	console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
