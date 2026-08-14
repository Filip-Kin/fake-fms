/**
 * Cheesy Arena web-page surface: a real HTML document for EVERY CA GET page route (operator,
 * display, setup, and panel pages), plus the small HTML partials the CA frontend fetches
 * (announcer/queueing match_load + score_posted, referee foul_list, match_play match_load).
 *
 * These are NOT byte-for-byte reproductions of CA's templates - CA ships its own frontend that opens
 * a websocket and renders live. What this module guarantees is that every route EXISTS and returns a
 * coherent page that identifies itself, reflects the current fake-fms store state (the same single
 * source of truth the SignalR/REST and CA notifier feeds read), and, where the real page is driven by
 * a websocket, documents/links the matching CA websocket so an operator can see what feeds it.
 *
 * Self-contained by design: imports only shared types and the FmsStore type. No side effects.
 */
import type { FMSAllianceSelection, FmsState, ScheduleEntry, StationKey, StationState, TournamentLevel } from "shared";
import { STATION_KEYS } from "shared";
import type { FmsStore } from "../state/store";

// #region html helpers

/** HTML-escape a value for safe interpolation into text/attribute content. */
function esc(v: unknown): string {
	return String(v ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const STYLE = `
:root{color-scheme:dark}
body{margin:0;padding:1.25rem;background:#111;color:#eee;font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
a{color:#5aa0ff}
h1{font-size:1.4rem;margin:0 0 .25rem}
h2{font-size:1.05rem;margin:1.5rem 0 .5rem;color:#ccc}
.sub{color:#9aa;margin:0 0 1rem;font-size:.85rem}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:.4rem;background:#233;color:#bcd;font-size:.8rem;margin-right:.4rem}
table{border-collapse:collapse;width:100%;max-width:960px;margin:.25rem 0 1rem}
th,td{border:1px solid #333;padding:.3rem .55rem;text-align:left}
th{background:#1b1b1b;color:#bbb;font-weight:600}
tr:nth-child(even) td{background:#161616}
.red{color:#ff6b6b}.blue{color:#6b9bff}
.muted{color:#888}
.ok{color:#3ecf6b}.no{color:#ff6b6b}
code{background:#1b1b1b;padding:.1rem .35rem;border-radius:.3rem;color:#cdd}
ul.nav{columns:2;max-width:720px;padding-left:1.1rem}
ul.nav li{margin:.1rem 0;break-inside:avoid}
.ws{margin:1rem 0;padding:.6rem .8rem;background:#161d24;border:1px solid #24323d;border-radius:.4rem;color:#9db4c6;font-size:.85rem}
`;

/** Wrap page content in the CA (fake-fms) document shell, with a header identifying the event + page. */
function shell(state: FmsState, pageTitle: string, body: string, ws?: string): Response {
	const ev = state.event;
	const cur = state.current;
	const wsBlock = ws
		? `<div class="ws">This page is driven by a websocket in real CA. Emulated feed: <code>${esc(ws)}</code></div>`
		: "";
	const html =
		`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>${esc(pageTitle)} - Cheesy Arena (fake-fms)</title><style>${STYLE}</style></head><body>` +
		`<h1>${esc(pageTitle)}</h1>` +
		`<p class="sub">Cheesy Arena emulation (fake-fms) &middot; ` +
		`${esc(ev.name)} <span class="muted">(${esc(ev.code)})</span> &middot; season ${esc(ev.season)} &middot; ` +
		`${esc(ev.tournamentType)}</p>` +
		`<p><span class="badge">Current: ${esc(matchLabel(cur.level, cur.matchNumber))}</span>` +
		`<span class="badge">State: ${esc(cur.matchState)}</span>` +
		`<span class="badge">Level: ${esc(cur.level)}</span></p>` +
		wsBlock +
		body +
		`</body></html>`;
	return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
}

/** Plain-text 500, matching CA's handleWebErr for invalid path parameters. */
function caErr(detail: string): Response {
	return new Response(`Internal server error: ${detail}`, { status: 500, headers: { "Content-Type": "text/plain" } });
}

// #endregion

// #region small state helpers

/** Short label for a match, e.g. Q12 / P3 / M5 / F1 (local copy of CA's naming; no cross-imports). */
function matchLabel(level: TournamentLevel, matchNumber: number): string {
	switch (level) {
		case "Practice":
			return `P${matchNumber}`;
		case "Qualification":
			return `Q${matchNumber}`;
		case "Playoff":
			return matchNumber >= 14 ? `F${matchNumber - 13}` : `M${matchNumber}`;
		default:
			return "Test";
	}
}

function currentEntry(state: FmsState): ScheduleEntry | undefined {
	return state.schedule.find((e) => e.level === state.current.level && e.matchNumber === state.current.matchNumber);
}

/** Best-effort total for a raw game-specific score record (fake-fms 2026 uses `totalPoints`). */
function scoreTotal(rec: Record<string, unknown>): string {
	const t = rec?.["totalPoints"];
	return typeof t === "number" ? String(t) : "-";
}

/** CA-style station labels (R1..B3), parallel to the shared STATION_KEYS order. */
const CA_STATION_LABELS = ["R1", "R2", "R3", "B1", "B2", "B3"] as const;

/** Resolve the ?displayId query param, generating one if absent (like CA), without redirecting. */
function resolveDisplayId(url: URL): { id: string; generated: boolean } {
	const q = url.searchParams.get("displayId");
	if (q) return { id: q, generated: false };
	// CA hands out sequential ids from its arena; we cannot mutate store here, so synthesise a stable-ish
	// one from the display path so repeat loads of the same screen read the same value.
	let h = 0;
	for (const ch of url.pathname) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
	return { id: String(100 + (h % 900)), generated: true };
}

function displayIdBlock(url: URL): string {
	const { id, generated } = resolveDisplayId(url);
	const note = generated ? ' <span class="muted">(generated; none supplied)</span>' : "";
	return `<p><span class="badge">displayId: ${esc(id)}</span>${note}</p>`;
}

function nickname(url: URL): string {
	return url.searchParams.get("nickname") ?? "";
}

// #endregion

// #region reusable table renderers

function currentMatchTeams(state: FmsState): string {
	const entry = currentEntry(state);
	const red = entry ? entry.red : ([0, 0, 0] as const);
	const blue = entry ? entry.blue : ([0, 0, 0] as const);
	const cell = (n: number) => (n > 0 ? esc(n) : '<span class="muted">-</span>');
	return (
		`<table><tr><th>Alliance</th><th>Driver 1</th><th>Driver 2</th><th>Driver 3</th></tr>` +
		`<tr><td class="red">Red</td><td>${cell(red[0])}</td><td>${cell(red[1])}</td><td>${cell(red[2])}</td></tr>` +
		`<tr><td class="blue">Blue</td><td>${cell(blue[0])}</td><td>${cell(blue[1])}</td><td>${cell(blue[2])}</td></tr>` +
		`</table>`
	);
}

function scoreLine(state: FmsState): string {
	return (
		`<p><span class="badge red">Red ${esc(scoreTotal(state.score.red))}</span>` +
		`<span class="badge blue">Blue ${esc(scoreTotal(state.score.blue))}</span>` +
		`<span class="badge">Timer: ${esc(state.timer.secondsRemaining)}s ${state.timer.running ? "running" : "stopped"}</span></p>`
	);
}

function scheduleTable(state: FmsState, level?: TournamentLevel): string {
	const rows = state.schedule
		.filter((e) => (level ? e.level === level : true))
		.sort((a, b) => a.matchNumber - b.matchNumber);
	if (rows.length === 0) return `<p class="muted">No matches scheduled.</p>`;
	const body = rows
		.map((e) => {
			const score =
				e.status === "Played"
					? `${e.finalScoreRed ?? "-"} - ${e.finalScoreBlue ?? "-"}`
					: '<span class="muted">-</span>';
			return (
				`<tr><td>${esc(matchLabel(e.level, e.matchNumber))}</td>` +
				`<td>${esc(e.level)}</td>` +
				`<td class="muted">${esc(e.scheduledStartTime)}</td>` +
				`<td class="red">${e.red.map((n) => esc(n)).join(" ")}</td>` +
				`<td class="blue">${e.blue.map((n) => esc(n)).join(" ")}</td>` +
				`<td>${esc(e.status)}</td><td>${score}</td></tr>`
			);
		})
		.join("");
	return (
		`<table><tr><th>Match</th><th>Level</th><th>Scheduled</th><th>Red</th><th>Blue</th><th>Status</th><th>Score</th></tr>` +
		body +
		`</table>`
	);
}

function rankingsTable(state: FmsState): string {
	const rows = [...state.rankings].sort((a, b) => a.rank - b.rank);
	if (rows.length === 0) return `<p class="muted">No rankings yet.</p>`;
	const names = new Map(state.teams.map((t) => [t.number, t.name] as const));
	const body = rows
		.map(
			(r) =>
				`<tr><td>${esc(r.rank)}</td><td>${esc(r.teamNumber)}</td>` +
				`<td>${esc(names.get(r.teamNumber) ?? "")}</td>` +
				`<td>${esc(r.rankingScore.toFixed(2))}</td>` +
				`<td>${esc(r.wins)}-${esc(r.losses)}-${esc(r.ties)}</td>` +
				`<td>${esc(r.matchesPlayed)}</td></tr>`,
		)
		.join("");
	return (
		`<table><tr><th>Rank</th><th>Team</th><th>Name</th><th>RP (avg)</th><th>W-L-T</th><th>Played</th></tr>` +
		body +
		`</table>`
	);
}

function alliancesTable(state: FmsState): string {
	const picked = state.alliances.filter((a: FMSAllianceSelection) => (a.captainTeamNumber ?? 0) > 0);
	if (picked.length === 0) return `<p class="muted">No alliances selected yet.</p>`;
	const cell = (n: number | null) => (n && n > 0 ? esc(n) : '<span class="muted">-</span>');
	const body = picked
		.map(
			(a) =>
				`<tr><td>${esc(a.allianceNumber)}</td><td>${cell(a.captainTeamNumber)}</td>` +
				`<td>${cell(a.firstRoundTeamNumber)}</td><td>${cell(a.secondRoundTeamNumber)}</td>` +
				`<td>${cell(a.alternateTeamNumber)}</td></tr>`,
		)
		.join("");
	return (
		`<table><tr><th>Alliance</th><th>Captain</th><th>1st pick</th><th>2nd pick</th><th>Backup</th></tr>` +
		body +
		`</table>`
	);
}

function teamsTable(state: FmsState): string {
	if (state.teams.length === 0) return `<p class="muted">No teams loaded.</p>`;
	const body = [...state.teams]
		.sort((a, b) => a.number - b.number)
		.map(
			(t) =>
				`<tr><td>${esc(t.number)}</td><td>${esc(t.name)}</td>` +
				`<td>${t.avatar ? '<span class="ok">yes</span>' : '<span class="muted">no</span>'}</td>` +
				`<td class="muted">${esc(t.wpaKey ? "set" : "-")}</td>` +
				`<td><a href="/setup/teams/${esc(t.number)}/edit">edit</a></td></tr>`,
		)
		.join("");
	return `<table><tr><th>Team</th><th>Name</th><th>Avatar</th><th>WPA key</th><th></th></tr>` + body + `</table>`;
}

function stationsTable(state: FmsState): string {
	const dot = (v: string, good: string[]) =>
		good.includes(v) ? `<span class="ok">${esc(v)}</span>` : `<span class="no">${esc(v)}</span>`;
	const body = STATION_KEYS.map((key: StationKey, i) => {
		const s: StationState = state.stations[key];
		const flags = [s.bypassed ? "BYPASS" : "", s.estop ? "ESTOP" : "", s.astop ? "ASTOP" : ""]
			.filter(Boolean)
			.join(" ");
		return (
			`<tr><td class="${s.alliance === "Red" ? "red" : "blue"}">${esc(CA_STATION_LABELS[i])}</td>` +
			`<td>${s.teamNumber > 0 ? esc(s.teamNumber) : '<span class="muted">-</span>'}</td>` +
			`<td>${dot(s.ds, ["green"])}</td><td>${dot(s.radio, ["green"])}</td>` +
			`<td>${dot(s.rio, ["green"])}</td><td>${dot(s.code, ["green"])}</td>` +
			`<td>${esc(s.battery.toFixed(1))}v</td><td>${esc(s.ping)}ms</td>` +
			`<td class="muted">${esc(flags || "-")}</td></tr>`
		);
	}).join("");
	return (
		`<table><tr><th>Station</th><th>Team</th><th>DS</th><th>Radio</th><th>RIO</th><th>Code</th>` +
		`<th>Battery</th><th>Ping</th><th>Flags</th></tr>` +
		body +
		`</table>`
	);
}

// #endregion

// #region page bodies

function indexBody(state: FmsState): string {
	const links: [string, string][] = [
		["/match_play", "Match Play (operator)"],
		["/match_review", "Match Review"],
		["/match_logs", "Match Logs"],
		["/alliance_selection", "Alliance Selection"],
		["/panels/referee", "Referee Panel"],
		["/panels/scoring/red", "Scoring Panel (Red)"],
		["/panels/scoring/blue", "Scoring Panel (Blue)"],
		["/displays/audience", "Audience Display"],
		["/displays/announcer", "Announcer Display"],
		["/displays/field_monitor", "Field Monitor Display"],
		["/displays/alliance_station", "Alliance Station Display"],
		["/displays/queueing", "Queueing Display"],
		["/displays/rankings", "Rankings Display"],
		["/displays/bracket", "Bracket Display"],
		["/displays/logo", "Logo Display"],
		["/displays/twitch", "Twitch Display"],
		["/displays/wall", "Wall Display"],
		["/displays/webpage", "Webpage Display"],
		["/display", "Placeholder Display"],
		["/setup/settings", "Setup: Settings"],
		["/setup/teams", "Setup: Teams"],
		["/setup/schedule", "Setup: Schedule"],
		["/setup/breaks", "Setup: Breaks"],
		["/setup/awards", "Setup: Awards"],
		["/setup/judging", "Setup: Judging"],
		["/setup/displays", "Setup: Displays"],
		["/setup/lower_thirds", "Setup: Lower Thirds"],
		["/setup/sponsor_slides", "Setup: Sponsor Slides"],
		["/setup/field_testing", "Setup: Field Testing"],
	];
	const nav = links.map(([href, label]) => `<li><a href="${esc(href)}">${esc(label)}</a></li>`).join("");
	return (
		`<h2>Event</h2>` +
		`<table>` +
		`<tr><th>Name</th><td>${esc(state.event.name)}</td></tr>` +
		`<tr><th>Code</th><td>${esc(state.event.code)}</td></tr>` +
		`<tr><th>Location</th><td>${esc(state.event.location)}</td></tr>` +
		`<tr><th>Season</th><td>${esc(state.event.season)}</td></tr>` +
		`<tr><th>Type</th><td>${esc(state.event.tournamentType)}</td></tr>` +
		`<tr><th>Teams</th><td>${esc(state.teams.length)}</td></tr>` +
		`<tr><th>Matches</th><td>${esc(state.schedule.length)}</td></tr>` +
		`</table>` +
		`<h2>Pages</h2><ul class="nav">${nav}</ul>`
	);
}

function displayPage(state: FmsState, url: URL, title: string, ws: string, extra: string): Response {
	const nick = nickname(url);
	const nickLine = nick ? `<p><span class="badge">nickname: ${esc(nick)}</span></p>` : "";
	return shell(state, title, displayIdBlock(url) + nickLine + extra, ws);
}

// #endregion

/**
 * Handle a Cheesy Arena web-page GET route. Returns an HTML Response for any CA page (or its HTML
 * partial), a 500 for an invalid path parameter (matching CA), or null if the path is not a CA page
 * route (so the caller can fall through to the JSON/websocket handlers or a 404).
 */
export function handleCaPage(store: FmsStore, url: URL): Response | null {
	const state = store.getState();
	const p = url.pathname;

	// --- root ---
	if (p === "/") return shell(state, "Cheesy Arena", indexBody(state));

	// --- alliance selection ---
	if (p === "/alliance_selection") {
		const sel = state.allianceSelection;
		const status = sel?.active
			? `<p><span class="badge">Selection in progress</span><span class="badge">pick ${esc(sel.pickIndex + 1)} of ${esc(sel.order.length)}</span></p>`
			: `<p class="muted">No selection ceremony running.</p>`;
		return shell(state, "Alliance Selection", status + alliancesTable(state), "/alliance_selection/websocket");
	}

	// --- displays (websocket-driven, honour ?displayId) ---
	if (p === "/displays/audience") {
		return displayPage(
			state,
			url,
			"Audience Display",
			"/displays/audience/websocket",
			`<h2>Current match</h2>${currentMatchTeams(state)}${scoreLine(state)}`,
		);
	}
	if (p === "/displays/announcer") {
		return displayPage(
			state,
			url,
			"Announcer Display",
			"/displays/announcer/websocket",
			`<h2>Current match</h2>${currentMatchTeams(state)}${scoreLine(state)}` +
				`<p class="muted">Partials: <a href="/displays/announcer/match_load">match_load</a>, ` +
				`<a href="/displays/announcer/score_posted">score_posted</a>.</p>`,
		);
	}
	if (p === "/displays/announcer/match_load") {
		return shell(state, "Announcer - Match Load", `<h2>Loaded match</h2>${currentMatchTeams(state)}`);
	}
	if (p === "/displays/announcer/score_posted") {
		return shell(
			state,
			"Announcer - Score Posted",
			`<h2>Posted score</h2>${currentMatchTeams(state)}${scoreLine(state)}`,
		);
	}
	if (p === "/displays/field_monitor") {
		return displayPage(
			state,
			url,
			"Field Monitor Display",
			"/displays/field_monitor/websocket",
			`<h2>Stations</h2>${stationsTable(state)}`,
		);
	}
	if (p === "/displays/alliance_station") {
		return displayPage(
			state,
			url,
			"Alliance Station Display",
			"/displays/alliance_station/websocket",
			`<h2>Stations</h2>${stationsTable(state)}`,
		);
	}
	if (p === "/displays/queueing") {
		const pending = state.schedule
			.filter((e) => e.status === "Pending")
			.sort((a, b) => a.matchNumber - b.matchNumber)
			.slice(0, 6);
		const upcoming = pending.length
			? `<table><tr><th>Match</th><th>Red</th><th>Blue</th></tr>` +
				pending
					.map(
						(e) =>
							`<tr><td>${esc(matchLabel(e.level, e.matchNumber))}</td>` +
							`<td class="red">${e.red.map((n) => esc(n)).join(" ")}</td>` +
							`<td class="blue">${e.blue.map((n) => esc(n)).join(" ")}</td></tr>`,
					)
					.join("") +
				`</table>`
			: `<p class="muted">No upcoming matches.</p>`;
		return displayPage(
			state,
			url,
			"Queueing Display",
			"/displays/queueing/websocket",
			`<h2>On deck</h2>${upcoming}<p class="muted">Partial: <a href="/displays/queueing/match_load">match_load</a>.</p>`,
		);
	}
	if (p === "/displays/queueing/match_load") {
		return shell(state, "Queueing - Match Load", `<h2>Loaded match</h2>${currentMatchTeams(state)}`);
	}
	if (p === "/displays/rankings") {
		return displayPage(
			state,
			url,
			"Rankings Display",
			"/displays/rankings/websocket",
			`<h2>Rankings</h2>${rankingsTable(state)}`,
		);
	}
	if (p === "/displays/bracket") {
		const playoffs = scheduleTable(state, "Playoff");
		return displayPage(
			state,
			url,
			"Bracket Display",
			"/displays/bracket/websocket",
			`<h2>Playoff bracket</h2>${playoffs}`,
		);
	}
	if (p === "/displays/logo") {
		return displayPage(
			state,
			url,
			"Logo Display",
			"/displays/logo/websocket",
			`<p class="muted">Static logo screen.</p>`,
		);
	}
	if (p === "/displays/twitch") {
		return displayPage(
			state,
			url,
			"Twitch Display",
			"/displays/twitch/websocket",
			`<p class="muted">Twitch stream embed screen.</p>`,
		);
	}
	if (p === "/displays/wall") {
		return displayPage(
			state,
			url,
			"Wall Display",
			"/displays/wall/websocket",
			`<h2>Current match</h2>${currentMatchTeams(state)}${scoreLine(state)}`,
		);
	}
	if (p === "/displays/webpage") {
		return displayPage(
			state,
			url,
			"Webpage Display",
			"/displays/webpage/websocket",
			`<p class="muted">Configurable webpage screen (no URL configured).</p>`,
		);
	}
	if (p === "/display") {
		return displayPage(
			state,
			url,
			"Placeholder Display",
			"/display/websocket",
			`<p class="muted">Unassigned display awaiting configuration.</p>`,
		);
	}

	// --- match play (operator) ---
	if (p === "/match_play") {
		return shell(
			state,
			"Match Play",
			`<h2>Loaded match</h2>${currentMatchTeams(state)}${scoreLine(state)}` +
				`<h2>Field</h2>${stationsTable(state)}` +
				`<p class="muted">Partial: <a href="/match_play/match_load">match_load</a>.</p>`,
			"/match_play/websocket",
		);
	}
	if (p === "/match_play/match_load") {
		return shell(state, "Match Play - Match Load", `<h2>Loaded match</h2>${currentMatchTeams(state)}`);
	}

	// --- match logs ---
	if (p === "/match_logs") {
		const rows = [...state.schedule].sort((a, b) => a.matchNumber - b.matchNumber);
		const body = rows.length
			? `<table><tr><th>Match</th><th>Level</th><th>Stations</th></tr>` +
				rows
					.map((e) => {
						const stationLinks = [...e.red, ...e.blue]
							.map(
								(team, i) =>
									`<a href="/match_logs/${esc(e.matchNumber)}/${esc(CA_STATION_LABELS[i])}/log">${esc(CA_STATION_LABELS[i])}${team > 0 ? `:${esc(team)}` : ""}</a>`,
							)
							.join(" ");
						return `<tr><td>${esc(matchLabel(e.level, e.matchNumber))}</td><td>${esc(e.level)}</td><td>${stationLinks}</td></tr>`;
					})
					.join("") +
				`</table>`
			: `<p class="muted">No matches scheduled.</p>`;
		return shell(state, "Match Logs", `<h2>Matches</h2>${body}`);
	}
	const logMatch = p.match(/^\/match_logs\/([^/]+)\/([^/]+)\/log$/);
	if (logMatch) {
		const matchId = logMatch[1] as string;
		const stationId = logMatch[2] as string;
		return shell(
			state,
			`Match Log ${matchId} / ${stationId}`,
			`<p><span class="badge">Match ${esc(matchId)}</span><span class="badge">Station ${esc(stationId)}</span></p>` +
				`<p class="muted">Per-robot driver-station log. In fake-fms the log packets stream live over the ` +
				`field-monitor feed as the match runs; this page identifies the requested match/station.</p>` +
				stationsTable(state),
		);
	}

	// --- match review ---
	if (p === "/match_review") {
		const played = state.schedule.filter((e) => e.status === "Played");
		const body = played.length
			? `<table><tr><th>Match</th><th>Level</th><th>Score</th><th></th></tr>` +
				played
					.sort((a, b) => a.matchNumber - b.matchNumber)
					.map(
						(e) =>
							`<tr><td>${esc(matchLabel(e.level, e.matchNumber))}</td><td>${esc(e.level)}</td>` +
							`<td>${esc(e.finalScoreRed ?? "-")} - ${esc(e.finalScoreBlue ?? "-")}</td>` +
							`<td><a href="/match_review/${esc(e.matchNumber)}/edit">edit</a></td></tr>`,
					)
					.join("") +
				`</table>`
			: `<p class="muted">No completed matches to review.</p>`;
		return shell(state, "Match Review", `<h2>Completed matches</h2>${body}`);
	}
	const reviewEdit = p.match(/^\/match_review\/([^/]+)\/edit$/);
	if (reviewEdit) {
		const matchId = reviewEdit[1] as string;
		return shell(
			state,
			`Edit Match Result ${matchId}`,
			`<p><span class="badge">Match ${esc(matchId)}</span></p>` +
				`<h2>Teams</h2>${currentMatchTeams(state)}${scoreLine(state)}` +
				`<p class="muted">Score editing is driven through the fake-fms control API; this page identifies the ` +
				`match under review.</p>`,
		);
	}

	// --- panels ---
	const scoring = p.match(/^\/panels\/scoring\/([^/]+)$/);
	if (scoring) {
		const position = (scoring[1] as string).toLowerCase();
		if (position !== "red" && position !== "blue") return caErr(`Invalid position '${scoring[1]}'.`);
		const title = position === "red" ? "Scoring Panel (Red)" : "Scoring Panel (Blue)";
		const total = position === "red" ? scoreTotal(state.score.red) : scoreTotal(state.score.blue);
		return shell(
			state,
			title,
			`<p><span class="badge ${position}">${esc(position)} alliance</span>` +
				`<span class="badge">Score: ${esc(total)}</span></p>` +
				`<h2>Current match</h2>${currentMatchTeams(state)}`,
			`/panels/scoring/${position}/websocket`,
		);
	}
	if (p === "/panels/referee") {
		return shell(
			state,
			"Referee Panel",
			`<h2>Current match</h2>${currentMatchTeams(state)}${scoreLine(state)}` +
				`<p class="muted">Partial: <a href="/panels/referee/foul_list">foul_list</a>.</p>`,
			"/panels/referee/websocket",
		);
	}
	if (p === "/panels/referee/foul_list") {
		return shell(
			state,
			"Referee - Foul List",
			`<p class="muted">No fouls recorded for the current match (fake-fms tracks foul points as a scalar, ` +
				`not per-foul records).</p>`,
		);
	}

	// --- setup ---
	if (p === "/setup/settings") {
		const ev = state.event;
		const rows = [
			["Name", ev.name],
			["Code", ev.code],
			["Location", ev.location],
			["Season", ev.season],
			["Tournament type", ev.tournamentType],
			["Level", ev.level],
			["Video switch", ev.videoSwitchOption],
			["FMS event id", ev.fmsEventId],
			["FMS version", ev.fmsVersion],
			["Alliance selection", state.allianceSelectionType],
		]
			.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
			.join("");
		return shell(
			state,
			"Setup: Settings",
			`<h2>Event settings</h2><table>${rows}</table>`,
			"/setup/settings/websocket",
		);
	}
	if (p === "/setup/teams") {
		return shell(state, "Setup: Teams", `<h2>Teams (${esc(state.teams.length)})</h2>${teamsTable(state)}`);
	}
	const teamEdit = p.match(/^\/setup\/teams\/([^/]+)\/edit$/);
	if (teamEdit) {
		const id = teamEdit[1] as string;
		const team = state.teams.find((t) => String(t.number) === id);
		const detail = team
			? `<table><tr><th>Number</th><td>${esc(team.number)}</td></tr>` +
				`<tr><th>Name</th><td>${esc(team.name)}</td></tr>` +
				`<tr><th>WPA key</th><td class="muted">${esc(team.wpaKey || "-")}</td></tr>` +
				`<tr><th>Avatar</th><td>${team.avatar ? "yes" : "no"}</td></tr></table>`
			: `<p class="no">No team ${esc(id)} loaded.</p>`;
		return shell(state, `Edit Team ${id}`, `<h2>Team ${esc(id)}</h2>${detail}`);
	}
	if (p === "/setup/schedule") {
		return shell(state, "Setup: Schedule", `<h2>Schedule (${esc(state.schedule.length)})</h2>${scheduleTable(state)}`);
	}
	if (p === "/setup/breaks") {
		return shell(
			state,
			"Setup: Breaks",
			`<p class="muted">Scheduled breaks are managed through the fake-fms control API.</p>`,
		);
	}
	if (p === "/setup/awards") {
		return shell(state, "Setup: Awards", `<p class="muted">Awards are managed through the fake-fms control API.</p>`);
	}
	if (p === "/setup/judging") {
		return shell(state, "Setup: Judging", `<p class="muted">Judging schedule is not modelled by fake-fms.</p>`);
	}
	if (p === "/setup/sponsor_slides") {
		return shell(
			state,
			"Setup: Sponsor Slides",
			`<p class="muted">No sponsor slides configured (fake-fms serves an empty set).</p>`,
		);
	}
	if (p === "/setup/displays") {
		const c = state.clients;
		return shell(
			state,
			"Setup: Displays",
			`<h2>Connected clients</h2><table>` +
				`<tr><th>fieldMonitorHub</th><td>${esc(c.fieldMonitorHub)}</td></tr>` +
				`<tr><th>infrastructureHub</th><td>${esc(c.infrastructureHub)}</td></tr>` +
				`<tr><th>gameSpecificHub</th><td>${esc(c.gameSpecificHub)}</td></tr>` +
				`<tr><th>ftaAppHub</th><td>${esc(c.ftaAppHub)}</td></tr></table>`,
			"/setup/displays/websocket",
		);
	}
	if (p === "/setup/lower_thirds") {
		return shell(
			state,
			"Setup: Lower Thirds",
			`<p class="muted">Lower-third graphics are managed live over the websocket.</p>`,
			"/setup/lower_thirds/websocket",
		);
	}
	if (p === "/setup/field_testing") {
		return shell(
			state,
			"Setup: Field Testing",
			`<h2>Stations</h2>${stationsTable(state)}`,
			"/setup/field_testing/websocket",
		);
	}

	return null;
}
