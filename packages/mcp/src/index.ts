// #region Fake FMS MCP server
//
// A stdio MCP server that lets an AI agent drive the Fake FMS emulator while you develop against it.
// Every tool is a thin bridge to the emulator's control API (the same endpoints the React control
// panel uses), so the agent can prestart/run/score/commit/post matches, cycle the field monitor,
// and read live state. Point it at a running emulator with FAKE_FMS_CONTROL_URL (the control port,
// default the deployed field box).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.FAKE_FMS_CONTROL_URL ?? "http://10.0.100.5:3010").replace(/\/$/, "");

const STATIONS = ["red1", "red2", "red3", "blue1", "blue2", "blue3"] as const;

interface ControlResult {
	ok: boolean;
	status: number;
	body: unknown;
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<ControlResult> {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let parsed: unknown = null;
	const text = await res.text();
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	return { ok: res.ok, status: res.status, body: parsed };
}

function text(value: unknown): { content: { type: "text"; text: string }[] } {
	return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

async function action(path: string, body?: unknown): Promise<{ content: { type: "text"; text: string }[] }> {
	const r = await call("POST", path, body);
	return text(r.ok ? `ok (${path})` : `error ${r.status} on ${path}: ${JSON.stringify(r.body)}`);
}

// A compact view of the emulator state; the raw state includes the full schedule + teams which is
// too large and noisy to hand back on every call.
interface RawState {
	event?: { code?: string; name?: string; videoSwitchOption?: string; level?: string };
	current?: { matchNumber?: number; playNumber?: number; level?: string; matchState?: string };
	timer?: { phase?: string; secondsRemaining?: number; running?: boolean };
	score?: { red?: Record<string, unknown>; blue?: Record<string, unknown> };
	stations?: Record<string, { alliance?: string; teamNumber?: number; ds?: string; radio?: string; rio?: string; code?: string; bypassed?: boolean; estop?: boolean; astop?: boolean }>;
	schedule?: { matchNumber: number; playNumber: number; level: string; description: string; red: number[]; blue: number[] }[];
	clients?: unknown;
}

function summarize(s: RawState): unknown {
	const stations = Object.fromEntries(
		STATIONS.map((k) => {
			const st = s.stations?.[k];
			return [
				k,
				st
					? {
							team: st.teamNumber,
							ds: st.ds,
							radio: st.radio,
							rio: st.rio,
							code: st.code,
							...(st.bypassed ? { bypassed: true } : {}),
							...(st.estop ? { estop: true } : {}),
							...(st.astop ? { astop: true } : {}),
						}
					: null,
			];
		}),
	);
	return {
		event: { code: s.event?.code, name: s.event?.name, level: s.event?.level, videoSwitch: s.event?.videoSwitchOption },
		current: s.current,
		timer: s.timer,
		score: { red: s.score?.red?.totalPoints ?? 0, blue: s.score?.blue?.totalPoints ?? 0 },
		stations,
		connectedClients: s.clients,
	};
}

const server = new McpServer({ name: "fake-fms", version: "1.0.0" });

// #region read

server.tool(
	"get_state",
	"Get a compact snapshot of the Fake FMS: event, current match, timer/phase, per-station status, score totals, and how many SignalR clients are connected. Call this first to see what the field is doing.",
	{},
	async () => {
		const r = await call("GET", "/control/state");
		if (!r.ok) return text(`error ${r.status} reading state`);
		return text(summarize(r.body as RawState));
	},
);

server.tool(
	"list_matches",
	"List the matches in the current tournament level (number, play, teams) so you can pick one to load with select_match.",
	{},
	async () => {
		const r = await call("GET", "/control/state");
		if (!r.ok) return text(`error ${r.status} reading state`);
		const s = r.body as RawState;
		const level = s.current?.level;
		const rows = (s.schedule ?? [])
			.filter((m) => m.level === level)
			.map((m) => ({ match: m.matchNumber, play: m.playNumber, desc: m.description, red: m.red, blue: m.blue }));
		return text({ level, matches: rows });
	},
);

// #endregion

// #region match lifecycle

server.tool(
	"select_match",
	"Load a specific match onto the field (does not start it). level defaults to the current level.",
	{
		matchNumber: z.number().int().positive(),
		playNumber: z.number().int().positive().optional(),
		level: z.enum(["None", "Practice", "Qualification", "Playoff"]).optional(),
	},
	async ({ matchNumber, playNumber, level }) =>
		action("/control/match/select", { matchNumber, playNumber: playNumber ?? 1, level }),
);

server.tool("prestart", "Prestart the loaded match (loads the alliances onto the stations).", {}, () =>
	action("/control/match/prestart"),
);
server.tool("set_audience", "Set the audience display / show the match preview (prestart -> ready flow).", {}, () =>
	action("/control/match/preview"),
);
server.tool("arm_match", "Mark the field ready so the match can be started.", {}, () => action("/control/match/arm"));
server.tool(
	"start_match",
	"Start the match. It then runs automatically: auto (20s) -> teleop (140s) with the game-specific phase stream.",
	{},
	() => action("/control/match/start"),
);
server.tool("commit_scores", "Commit the refs' scores (locks the result; does not yet post to the audience).", {}, () =>
	action("/control/match/commit"),
);
server.tool(
	"post_results",
	"Post the committed results to the audience (fires AudienceShowMatchResult - this is what triggers FTA-Buddy to pull match logs).",
	{},
	() => action("/control/match/post"),
);
server.tool("next_match", "Advance to the next match.", {}, () => action("/control/match/next"));
server.tool("abort_match", "Abort/cancel the running match.", {}, () => action("/control/match/abort"));

// #endregion

// #region scoring

server.tool(
	"set_score",
	"Set a single game-specific score field for an alliance (e.g. autoFuelPoints, teleopFuelPoints, foulPoints, or a boolean penalty flag). Use get_state to see current totals.",
	{
		alliance: z.enum(["Red", "Blue"]),
		key: z.string().describe("score field name, e.g. autoFuelPoints / teleopClimbPoints / foulPoints / g206Penalty"),
		value: z.union([z.number(), z.boolean()]),
	},
	async ({ alliance, key, value }) => action("/control/score", { alliance, key, value }),
);
server.tool("reset_scores", "Reset both alliances' scores to zero.", {}, () => action("/control/score/reset"));

// #endregion

// #region field monitor

server.tool(
	"cycle_station",
	"Advance one indicator of a station's field-monitor status by one step (ds cycles red->greenX->green->waiting->move; radio/rio/code cycle red->greenX->green).",
	{
		station: z.enum(STATIONS),
		part: z.enum(["ds", "radio", "rio", "code"]),
	},
	async ({ station, part }) => action(`/control/station/${station}/cycle/${part}`),
);
server.tool(
	"set_station_flag",
	"Set a station overlay flag (bypass / e-stop / a-stop) on or off.",
	{
		station: z.enum(STATIONS),
		flag: z.enum(["bypass", "estop", "astop"]),
		on: z.boolean(),
	},
	async ({ station, flag, on }) => action(`/control/station/${station}/${flag}`, { on }),
);
server.tool("reset_stations", "Reset all six stations to disconnected and clear bypass/e-stop/a-stop.", {}, () =>
	action("/control/stations/reset"),
);

// #endregion

// #region event

server.tool(
	"set_level",
	"Switch the active tournament level (None / Practice / Qualification / Playoff).",
	{ level: z.enum(["None", "Practice", "Qualification", "Playoff"]) },
	async ({ level }) => action("/control/level", { level }),
);

// #endregion

const transport = new StdioServerTransport();
await server.connect(transport);

// #endregion
