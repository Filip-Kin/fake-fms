// #region Fake FMS MCP server (tool definitions)
//
// Builds the MCP server and registers every tool. Each tool is a thin bridge to the emulator's
// control API (the same endpoints the React control panel uses), so an agent can prestart/run/
// score/commit/post matches, cycle the field monitor, and read live state. The transport is chosen
// by the entry point: `index.ts` connects this over stdio (local repo use), `http.ts` serves it
// over the network (point a remote Claude Code at it, no local copy of the repo needed).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const STATIONS = ["red1", "red2", "red3", "blue1", "blue2", "blue3"] as const;

interface ControlResult {
	ok: boolean;
	status: number;
	body: unknown;
}

function text(value: unknown): { content: { type: "text"; text: string }[] } {
	return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

// A compact view of the emulator state; the raw state includes the full schedule + teams which is
// too large and noisy to hand back on every call.
interface RawState {
	event?: { code?: string; name?: string; videoSwitchOption?: string; level?: string };
	current?: { matchNumber?: number; playNumber?: number; level?: string; matchState?: string };
	timer?: { phase?: string; secondsRemaining?: number; running?: boolean };
	score?: { red?: Record<string, unknown>; blue?: Record<string, unknown> };
	stations?: Record<
		string,
		{ alliance?: string; teamNumber?: number; ds?: string; radio?: string; rio?: string; code?: string; bypassed?: boolean; estop?: boolean; astop?: boolean }
	>;
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

/**
 * Build a fully-wired Fake FMS MCP server. `baseUrl` is the emulator's control API origin (the
 * control port). The caller connects the returned server to a transport.
 */
export function buildServer(baseUrl: string): McpServer {
	const BASE = baseUrl.replace(/\/$/, "");

	async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<ControlResult> {
		const res = await fetch(`${BASE}${path}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		let parsed: unknown = null;
		const responseText = await res.text();
		try {
			parsed = responseText ? JSON.parse(responseText) : null;
		} catch {
			parsed = responseText;
		}
		return { ok: res.ok, status: res.status, body: parsed };
	}

	async function action(path: string, body?: unknown): Promise<{ content: { type: "text"; text: string }[] }> {
		const r = await call("POST", path, body);
		return text(r.ok ? `ok (${path})` : `error ${r.status} on ${path}: ${JSON.stringify(r.body)}`);
	}

	const server = new McpServer({ name: "fake-fms", version: "1.1.0" });

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

	server.tool("prestart", "Prestart the loaded match (loads the alliances onto the stations). Does NOT show the audience the preview - that's a separate step.", {}, () =>
		action("/control/match/prestart"),
	);
	server.tool("show_match_preview", "Show the upcoming-match preview on the audience display (the step after prestart, before set_audience).", {}, () =>
		action("/control/match/show-preview"),
	);
	server.tool("set_audience", "Set the audience display to live video+score; the field becomes match-not-ready (the step after show_match_preview).", {}, () =>
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

	server.tool(
		"set_autoplay",
		"Toggle the match autoplay conveniences. replayLogs: at match start, generate the per-robot logs and play them live through the field monitor (connection states + faults animate over the match). autoFaults: at match start, roll 2-3 random faults onto 1-2 robots so you don't set faults by hand. Both also feed the GetLog endpoint.",
		{ replayLogs: z.boolean().optional(), autoFaults: z.boolean().optional() },
		async ({ replayLogs, autoFaults }) => {
			const patch: Record<string, boolean> = {};
			if (replayLogs !== undefined) patch.replayLogs = replayLogs;
			if (autoFaults !== undefined) patch.autoFaults = autoFaults;
			return action("/control/autoplay", patch);
		},
	);

	// #endregion

	// #region event

	server.tool(
		"set_level",
		"Switch the active tournament level (None / Practice / Qualification / Playoff).",
		{ level: z.enum(["None", "Practice", "Qualification", "Playoff"]) },
		async ({ level }) => action("/control/level", { level }),
	);

	server.tool(
		"set_video_switch",
		"Manually switch what the audience display shows (the FMS video switch). Options: VideoOnly / VideoAndScore (live match) / MatchPreview / MatchResults / Bracket (playoff bracket) / Rankings / Schedule / AllianceHybrid + AllianceFullscreen (alliance selection screen) / Timeout / TimerBug (timer overlay) / Background / Message. Note the match lifecycle already drives this automatically (preview/results); use this for everything else.",
		{
			option: z.enum([
				"VideoOnly",
				"VideoAndScore",
				"MatchPreview",
				"MatchResults",
				"Bracket",
				"Rankings",
				"Schedule",
				"AllianceHybrid",
				"AllianceFullscreen",
				"Timeout",
				"TimerBug",
				"Background",
				"Message",
			]),
		},
		async ({ option }) => action("/control/video", { option }),
	);

	// #endregion

	// #region alliance selection

	interface AllianceState {
		alliances?: { allianceNumber: number; captainTeamNumber: number | null; firstRoundTeamNumber: number | null; secondRoundTeamNumber: number | null; alternateTeamNumber: number | null }[];
		rankings?: { rank: number; teamNumber: number; isDeclined: boolean; pickStatus: string; inPotentialCaptainPosition: boolean }[];
		allianceSelection?: { active: boolean; pickIndex: number } | null;
		allianceSelectionType?: string;
	}

	server.tool(
		"get_alliance_selection",
		"Read alliance-selection state: each alliance's captain + picks, the available teams (by rank), who has declined, and which alliance/round is currently on the clock. Call before alliance_pick.",
		{},
		async () => {
			const r = await call("GET", "/control/state");
			if (!r.ok) return text(`error ${r.status} reading state`);
			const s = r.body as AllianceState;
			const alliances = s.alliances ?? [];
			const n = alliances.length || 8;
			// Serpentine order: round 1 alliances 1..n, round 2 n..1, round 3 1..n (per alliance size).
			const rounds = s.allianceSelectionType === "TwoTeam" ? 1 : s.allianceSelectionType === "FourTeam" ? 3 : 2;
			const order: { alliance: number; round: number }[] = [];
			for (let round = 1; round <= rounds; round++) {
				const forward = round % 2 === 1;
				for (let i = 0; i < n; i++) order.push({ alliance: forward ? i + 1 : n - i, round });
			}
			const sel = s.allianceSelection;
			const slot = sel?.active ? (order[sel.pickIndex] ?? null) : null;
			const roundName = (r: number): string => (r === 1 ? "first" : r === 2 ? "second" : "backup");
			return text({
				type: s.allianceSelectionType ?? "ThreeTeam",
				active: sel?.active ?? false,
				onTheClock: slot ? `Alliance ${slot.alliance}, ${roundName(slot.round)} pick` : null,
				alliances: alliances.map((a) => ({
					alliance: a.allianceNumber,
					captain: a.captainTeamNumber,
					pick1: a.firstRoundTeamNumber,
					pick2: a.secondRoundTeamNumber,
					backup: a.alternateTeamNumber,
				})),
				available: (s.rankings ?? [])
					.filter((t) => t.pickStatus === "None" && !t.isDeclined)
					.map((t) => ({ rank: t.rank, team: t.teamNumber })),
				declined: (s.rankings ?? []).filter((t) => t.isDeclined).map((t) => t.teamNumber),
			});
		},
	);

	server.tool(
		"set_alliance_type",
		"Set the alliance size before starting selection: TwoTeam (captain+1 pick), ThreeTeam (captain+2, the FRC default), or FourTeam (captain+3; the 3rd pick is the Backup). Adds/removes a serpentine pick round accordingly.",
		{ type: z.enum(["TwoTeam", "ThreeTeam", "FourTeam"]) },
		async ({ type }) => action("/control/alliance/type", { type }),
	);
	server.tool(
		"alliance_start",
		"Begin the alliance-selection ceremony. Locks the top-ranked teams as the alliance captains and starts the serpentine draft at alliance 1's first pick. Set the alliance size first with set_alliance_type (default ThreeTeam).",
		{},
		() => action("/control/alliance/start"),
	);
	server.tool(
		"alliance_pick",
		"Accept a team into the alliance slot currently on the clock (see get_alliance_selection). The team must be available (not a captain, not already picked, not declined).",
		{ teamNumber: z.number().int().positive() },
		async ({ teamNumber }) => action("/control/alliance/pick", { teamNumber }),
	);
	server.tool(
		"alliance_decline",
		"Mark a team as declining a pick (on=true) or undo that decline (on=false). Declined teams are struck through and cannot be picked.",
		{ teamNumber: z.number().int().positive(), on: z.boolean().optional() },
		async ({ teamNumber, on }) => action("/control/alliance/decline", { teamNumber, on: on ?? true }),
	);
	server.tool("alliance_skip", "Skip the slot currently on the clock (alliance failed to pick), leaving it empty.", {}, () =>
		action("/control/alliance/skip"),
	);
	server.tool("alliance_undo", "Undo the most recent alliance pick or skip, freeing the team and backing up the clock.", {}, () =>
		action("/control/alliance/undo"),
	);
	server.tool(
		"alliance_save",
		"Finalize alliance selection: build the playoff bracket from the alliances, seed round 1, generate the playoff schedule, and switch the event to Playoff.",
		{},
		() => action("/control/alliance/save"),
	);

	// #endregion

	// #region bracket

	interface BracketStateView {
		playoffMatches?: Record<string, { matchNumber: number; red: number | null; blue: number | null; redScore: number; blueScore: number; winner: string; complete: boolean }>;
		bracket?: { currentLevel?: string } | null;
	}

	server.tool(
		"get_bracket",
		"Read the playoff double-elimination bracket: each match's alliances, scores, winner, and completion, plus the current playoff level. The bracket auto-advances as playoff matches are committed.",
		{},
		async () => {
			const r = await call("GET", "/control/state");
			if (!r.ok) return text(`error ${r.status} reading state`);
			const s = r.body as BracketStateView;
			const matches = Object.values(s.playoffMatches ?? {})
				.sort((a, b) => a.matchNumber - b.matchNumber)
				.map((m) => ({
					match: m.matchNumber,
					red: m.red,
					blue: m.blue,
					score: m.complete ? `${m.redScore}-${m.blueScore}` : null,
					winner: m.winner === "None" ? null : m.winner,
				}));
			return text({ currentLevel: s.bracket?.currentLevel ?? "None", matches });
		},
	);

	// #endregion

	return server;
}

// #endregion
