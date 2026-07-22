import {
	type FTAAddNoteBody,
	type FTAMatchesModel,
	type FTANoteRecord,
	type FTATeamNotesModel,
	issueTypeFromNumeric,
	Level,
	noteTypeFromNumeric,
	resolutionFromNumeric,
	type TournamentLevel,
	wireMatchNumber,
} from "shared";
import { json, jsonRaw, noContent, notFound, quoted, text } from "../http";
import { generateStationLog, hashSeed } from "../match/log-generator";
import { bracketSlot } from "../match/playoff";
import { AUTO_SECONDS, teleopSeconds } from "../match/timing";
import type { FmsStore } from "../state/store";
import { stableMatchId } from "../state/seed";
import { arrayOfType, FMS_TYPE, withType } from "./fms-types";
import {
	activeLevelMatchCount,
	getCurrentResults,
	getCurrentSchedule,
	getFinalsMatchPreview,
	getMatchPreview,
	getMatchResults,
	getPlayoffMatchPreview,
	getResults,
	getTeamRankings,
} from "./projectors";
import {
	getAllAlliances,
	getAllianceSelectionData,
	getAudienceAlliances,
	getBracketDataJson,
	getPlayoffMatchesJson,
	getPlayoffMatchGroups,
	getQualRankData,
	getQualRankings,
} from "./playoff-projectors";

// #region helpers

const LEVEL_NAMES: Record<string, TournamentLevel> = {
	None: "None",
	Practice: "Practice",
	Qualification: "Qualification",
	Playoff: "Playoff",
};

function tournamentFromNumeric(n: number): TournamentLevel {
	return (["None", "Practice", "Qualification", "Playoff"][n] as TournamentLevel) ?? "None";
}

/**
 * Which controller prefixes really serve each method. Real FMS 404s a method under the wrong
 * prefix (documented per-path in fms-capture/rest-full/_index.json; the preview/results/playoff
 * routes come from the audience web bundle's data services). Method names are matched
 * case-insensitively, like ASP.NET Core routing.
 */
const METHOD_PREFIXES: Record<string, string[]> = {
	// systembase / settings scalars (the fieldMonitor page's service reads the systembase ones too)
	get_currentlyactiveeventcode: ["systembase", "fieldmonitor"],
	get_currentlyactiveeventname: ["systembase", "fieldmonitor"],
	get_currentlyactivetournamentlevel: ["systembase", "fieldmonitor"],
	get_videoswitchoption: ["settings"],
	getrobotsoftwareversions: ["systembase"],
	// audience
	getfmsversion: ["audience"],
	getalliances: ["audience"],
	getallianceselectiondata: ["audience"],
	geteventbreakdata: ["audience"],
	getqualrankings: ["audience"],
	getqualificationrankdata: ["audience"],
	getplayoffmatches: ["audience"],
	getregionaladvancers: ["audience"],
	getregionalpreviouslyqualifiedteams: ["audience"],
	getcurrentmatchandplaynumber: ["audience", "fieldmonitor"],
	getplayofflevelformatch: ["audience"],
	// audience_gs
	getgameconfig: ["audience_gs"],
	getbracketdata: ["audience_gs"],
	getmatchresults: ["audience_gs"],
	matchpreviewdata: ["audience"],
	// shared controller-base methods
	getallalliances: ["audience", "driverstationservice", "fieldmonitor", "match", "rankings"],
	getallteamnumbers: ["audience", "driverstationservice", "fieldmonitor", "match", "rankings"],
	getcurrentplayofflevel: ["audience", "driverstationservice", "fieldmonitor", "match", "rankings"],
	getplayoffmatchgroups: ["audience", "driverstationservice", "fieldmonitor", "match", "rankings"],
	// match
	currentlyactiveeventdbexists: ["match"],
	getcurrentresults: ["match"],
	getcurrentschedule: ["match"],
	getdefaultcycletimeminutes: ["match"],
	// rankings
	getfmsteamidswithrankingrecord: ["rankings"],
	getteamrankings: ["rankings"],
	// fieldmonitor
	getresults: ["fieldmonitor"],
	getlog: ["fieldmonitor"],
};

// #endregion

/** Handle an FMS REST request. Returns null if the path is not an FMS REST endpoint. */
export async function handleRest(store: FmsStore, req: Request, url: URL): Promise<Response | null> {
	const p = url.pathname;
	const state = store.getState();

	// #region health
	if (p === "/FieldMonitor" || p === "/") {
		return text("<html><body>Fake FMS FieldMonitor</body></html>");
	}
	// FieldMonitor-page route the FTA-Buddy DOM-scraper (injected.ts, non-SignalR mode) reads:
	// [matchNumber, playNumber, levelEnum] with the level as the numeric Level enum (0-3). Our
	// external capture 404'd it (it needs the FieldMonitor page's own session/origin), but it does
	// exist on real FMS - the injected scraper used it at 2026 events. The /api GetCurrentMatchAndPlayNumber
	// below is the modern equivalent (level as a string, level-first).
	if (p === "/FieldMonitor/MatchNumberAndPlay") {
		return json([
			wireMatchNumber(state.current.level, state.current.matchNumber),
			state.current.playNumber,
			Level[state.current.level],
		]);
	}
	// #endregion

	// #region notes
	if (p.startsWith("/Notes/")) {
		return handleNotes(store, req, url, p);
	}
	// #endregion

	const apiMatch = p.match(/^\/api\/v1\.0\/([A-Za-z_]+)\/get\/(.+)$/);
	if (!apiMatch) return null;
	const prefix = (apiMatch[1] as string).toLowerCase();
	const m = apiMatch[2] as string;
	const lower = m.toLowerCase();

	// Real FMS 404s methods requested under a controller that does not expose them; check the
	// method's real prefix set before dispatching (parameterized routes key on their first segment).
	const methodKey = /^getmatchresults\w*data\//.test(lower)
		? "getmatchresults"
		: /matchpreviewdata\//.test(lower)
			? "matchpreviewdata"
			: (lower.split("/")[0] as string);
	const allowed = METHOD_PREFIXES[methodKey];
	if (!allowed || !allowed.includes(prefix)) return null;

	// #region systembase / settings scalars
	if (lower === "get_currentlyactiveeventcode") return quoted(state.event.code);
	if (lower === "get_currentlyactiveeventname") return quoted(state.event.name);
	if (lower === "get_currentlyactivetournamentlevel") return quoted(state.event.level);
	if (lower === "get_videoswitchoption") return quoted(state.event.videoSwitchOption);
	if (lower === "getfmsversion") return quoted(state.event.fmsVersion);
	// Capture: real FMS answers this with 204 No Content.
	if (lower === "getrobotsoftwareversions") return noContent();
	if (lower === "currentlyactiveeventdbexists") return json(true);
	// #endregion

	// #region match / schedule / teams
	if (lower === "getallteamnumbers") return json(state.teams.map((t) => t.number));
	if (lower === "getcurrentresults") return json(arrayOfType(FMS_TYPE.CurrentResult, getCurrentResults(store)));
	if (lower === "getdefaultcycletimeminutes") return json(9);
	if (lower === "getcurrentplayofflevel") return quoted(currentPlayoffLevelWire(store));
	if (lower === "getfmsteamidswithrankingrecord")
		return json(state.rankings.map((r) => stableMatchId(`fmsteam:${r.teamNumber}`)));
	if (lower === "getregionaladvancers") return json(withType(FMS_TYPE.RegionalAdvancers, { advancers: [] }));
	if (lower === "getregionalpreviouslyqualifiedteams") return json(withType(FMS_TYPE.RegionalPool, { teams: [] }));
	if (lower === "geteventbreakdata") {
		const entry = state.schedule.find(
			(e) => e.matchNumber === state.current.matchNumber && e.level === state.current.level,
		);
		const redNum = entry?.redAllianceNumber ?? 0;
		const blueNum = entry?.blueAllianceNumber ?? 0;
		const allianceName = (n: number): string =>
			state.bracket?.alliances.find((a) => a.allianceNumber === n)?.allianceName ?? (n ? `Alliance ${n}` : "");
		return json(
			withType(FMS_TYPE.EventBreakData, {
				eventName: state.event.name,
				eventLocation: state.event.location,
				eventCode: state.event.code,
				tournamentType: state.event.tournamentType,
				tournamentLevel: state.event.level,
				playoffLevel: state.bracket?.currentLevel ?? "None",
				playoffBracket: "DoubleUpper",
				allianceCount: state.bracket?.allianceCount ?? "EightAlliance",
				nextMatchNumber: state.current.matchNumber,
				nextMatchDescription: entry?.description ?? `Match ${state.current.matchNumber}`,
				totalMatches: activeLevelMatchCount(store),
				redAllianceName: allianceName(redNum),
				redAllianceNumber: redNum,
				blueAllianceName: allianceName(blueNum),
				blueAllianceNumber: blueNum,
			}),
		);
	}
	if (lower === "getcurrentschedule") {
		const rows = getCurrentSchedule(store);
		// Pre-event (nothing scheduled at the active level) real FMS answers 204 No Content.
		if (rows.length === 0) return noContent();
		return json(arrayOfType(FMS_TYPE.ScheduleViewItem, rows));
	}
	if (lower === "getcurrentmatchandplaynumber") {
		// 204 when no match is genuinely loaded (no schedule entry backs the current selection).
		const entry = state.schedule.find(
			(e) => e.matchNumber === state.current.matchNumber && e.level === state.current.level,
		);
		if (!entry) return noContent();
		return json(
			withType(FMS_TYPE.CurrentMatchTuple, {
				item1: state.current.level,
				item2: wireMatchNumber(state.current.level, state.current.matchNumber),
				item3: state.current.playNumber,
			}),
		);
	}
	// #endregion

	// #region fieldmonitor results / logs
	const resultsMatch = m.match(/^GetResults\/(\w+)$/i);
	if (resultsMatch) {
		const level = LEVEL_NAMES[resultsMatch[1] as string] ?? "Qualification";
		const rows = getResults(store, level);
		// Real FMS answers 204 when nothing has been played at that level yet (capture snap-000).
		if (rows.length === 0) return noContent();
		return json(arrayOfType(FMS_TYPE.WebMatchViewItem, rows));
	}
	const logMatch = m.match(/^GetLog\/([^/]+)\/(Red|Blue)\/(Station[123])$/);
	if (logMatch) {
		const [, matchId, alliance, stationName] = logMatch as unknown as [string, string, "Red" | "Blue", string];
		const stationIdx = Number(stationName.replace("Station", "")) - 1;
		const entry = state.schedule.find((e) => e.fmsMatchId === matchId);
		if (!entry) return json([]);
		const robot = `${alliance.toLowerCase()}${stationIdx + 1}`;
		const faults = store.getLogFaults(matchId, robot);
		const seed = hashSeed(`${matchId}:${alliance}:${stationName}`);
		const startMs = Date.parse(entry.actualStartTime ?? entry.scheduledStartTime);
		// Real 2026 timings + no transition gap, matching the live field-monitor replay exactly.
		return json(
			generateStationLog({
				seed,
				faults,
				autoSeconds: AUTO_SECONDS,
				teleopSeconds: teleopSeconds(state.gameConfig),
				transitionSeconds: 0,
				startTimeMs: Number.isNaN(startMs) ? undefined : startMs,
			}),
		);
	}
	if (/^GetLog\//i.test(m)) {
		return json([]);
	}
	// #endregion

	// #region audience: alliances / rankings / preview / config / bracket
	if (lower === "getalliances") return json(getAudienceAlliances(store));
	if (lower === "getallalliances") return json(getAllAlliances(store));
	if (lower === "getallianceselectiondata") return json(getAllianceSelectionData(store));
	if (lower === "getqualrankings") return json(getQualRankings(store));
	if (lower === "getqualificationrankdata") return json(getQualRankData(store));
	if (lower === "getteamrankings") return json(arrayOfType(FMS_TYPE.TeamRanking, getTeamRankings(store)));
	if (lower === "getplayoffmatches") return jsonRaw(getPlayoffMatchesJson(store));
	if (lower === "getplayoffmatchgroups") return json(getPlayoffMatchGroups(store));
	if (lower === "getgameconfig") return json(withType(FMS_TYPE.GameConfig, state.gameConfig));
	if (lower === "getbracketdata") {
		const bracket = getBracketDataJson(store);
		return bracket === null ? json(null) : jsonRaw(bracket);
	}

	// The playoff-level router endpoint the audience display uses to pick the finals vs playoff
	// results screen: returns the PlayoffLevel enum NAME as a quoted string (e.g. "Level6", "Final").
	const levelForMatch = m.match(/^GetPlayoffLevelForMatch\/(\d+)$/i);
	if (levelForMatch) {
		const n = Number(levelForMatch[1]);
		// During the finals the display asks with the WIRE finals number (1-3/4-6), which collides
		// with bracket numbers; real FMS resolves it against the current playoff phase.
		if (state.current.level === "Playoff" && state.current.matchNumber >= 14) return quoted("Final");
		if (n >= 14) return quoted("Final");
		const slot = bracketSlot(n);
		if (!slot) return null;
		return quoted(slot.level);
	}

	// Match previews. Only the five real route names exist (audience web bundle); anything else 404s.
	const previewMatch = m.match(/^Get(Test|Practice|Qual|DoubleElimPlayoff|DoubleElimFinal)MatchPreviewData\/(\d+)$/i);
	if (previewMatch) {
		const token = (previewMatch[1] as string).toLowerCase();
		const n = Number(previewMatch[2]);
		if (token === "doubleelimplayoff") {
			const preview = getPlayoffMatchPreview(store, n);
			return preview === null ? null : json(preview);
		}
		if (token === "doubleelimfinal") {
			// Finals endpoints use the internal playoff numbers 14-16 (overtime 17-19),
			// same as the wire (real FMS served GetMatchResultsDoubleElimFinalData/14).
			if (n < 14 || n > 19) return null;
			const preview = getFinalsMatchPreview(store, n);
			return preview === null ? null : json(preview);
		}
		const level: TournamentLevel = token === "test" ? "None" : token === "practice" ? "Practice" : "Qualification";
		const preview = getMatchPreview(store, level, n);
		return preview === null ? null : json(preview);
	}

	// Match results. The real Test route is GetMatchResultsTestMatchData (never GetMatchResultsTestData,
	// which real FMS 404s). A match with no committed result that is not on the field answers 204.
	const resultsDataMatch = m.match(/^GetMatchResults(TestMatch|Practice|Qual|DoubleElimPlayoff|DoubleElimFinal)Data\/(\d+)$/i);
	if (resultsDataMatch) {
		const token = (resultsDataMatch[1] as string).toLowerCase();
		const n = Number(resultsDataMatch[2]);
		let level: TournamentLevel;
		let matchNumber = n;
		if (token === "doubleelimplayoff") {
			level = "Playoff";
			if (bracketSlot(n) === undefined) return null; // only bracket matches 1-13 live here
		} else if (token === "doubleelimfinal") {
			level = "Playoff";
			// Finals use their internal numbers 14-16 (overtime 17-19) on this endpoint too.
			if (n < 14 || n > 19) return null;
			matchNumber = n;
		} else {
			level = token === "testmatch" ? "None" : token === "practice" ? "Practice" : "Qualification";
		}
		const result = getMatchResults(store, level, matchNumber);
		return result === null ? noContent() : json(result);
	}
	// #endregion

	return null;
}

/** GetCurrentPlayoffLevel: "Final" once the current match is in the finals, else the bracket level. */
function currentPlayoffLevelWire(store: FmsStore): string {
	const state = store.getState();
	if (state.current.level === "Playoff" && state.current.matchNumber >= 14) return "Final";
	return state.bracket?.currentLevel ?? "None";
}

// #region notes endpoints

async function handleNotes(store: FmsStore, req: Request, url: URL, p: string): Promise<Response> {
	const token = url.searchParams.get("token");
	if (token !== store.getState().event.fmsEventPassword) {
		return new Response("Unauthorized", { status: 401 });
	}

	if (p === "/Notes/Authorize") return text("Authorized", 200, "text/plain");

	if (p === "/Notes/GetMatches") {
		const model: FTAMatchesModel = {
			eventNotes: store.getState().notes.filter((n) => n.noteType === "FTAEvent" && !n.isDeleted),
			testMatches: [],
			practiceMatches: [],
			qualificationMatches: [],
			playoffMatches: [],
		};
		return json(model);
	}

	if (p === "/Notes/GetNotesPerTeam") {
		const byTeam = new Map<number, FTANoteRecord[]>();
		for (const n of store.getState().notes) {
			if (n.isDeleted || n.teamNumber == null) continue;
			const list = byTeam.get(n.teamNumber) ?? [];
			list.push(n);
			byTeam.set(n.teamNumber, list);
		}
		const out: FTATeamNotesModel[] = [...byTeam.entries()].map(([teamNumber, teamNotes]) => ({
			fmsTeamId: crypto.randomUUID(),
			teamNumber,
			teamNotes,
		}));
		return json(out);
	}

	if (p === "/Notes/AddNote" && req.method === "POST") {
		let body: FTAAddNoteBody;
		try {
			body = (await req.json()) as FTAAddNoteBody;
		} catch (err) {
			console.error("[notes] AddNote body is not valid JSON:", err);
			return new Response("Bad Request", { status: 400 });
		}
		const record: FTANoteRecord = {
			fmsEventNoteId: crypto.randomUUID(),
			noteType: noteTypeFromNumeric(body.noteType),
			tournamentLevel: tournamentFromNumeric(body.tournamentLevel),
			alliance: null,
			station: null,
			fmsMatchId: null,
			fmsTeamId: null,
			teamNumber: body.teamNumber,
			matchDescription: null,
			matchNumber: body.matchNumber || null,
			playNumber: body.playNumber || null,
			note: body.note,
			issueType: issueTypeFromNumeric(body.issueType),
			resolutionStatus: resolutionFromNumeric(body.resolutionStatus),
			isPrivate: false,
			isDeleted: false,
		};
		store.addNoteRecord(record);
		return json(record);
	}

	if (p === "/Notes/UpdateNote" && req.method === "POST") {
		const id = url.searchParams.get("fmsEventNoteId") ?? "";
		const resolutionType = Number(url.searchParams.get("resolutionType") ?? "1");
		const notes = url.searchParams.get("notes") ?? "";
		const updated = store.updateNoteRecord(id, {
			resolutionStatus: resolutionFromNumeric(resolutionType),
			note: notes,
		});
		return updated ? json(updated) : notFound();
	}

	if (p === "/Notes/DeleteNote" && req.method === "POST") {
		const id = url.searchParams.get("fmsEventNoteId") ?? "";
		const deleted = store.deleteNoteRecord(id);
		return deleted ? json(deleted) : notFound();
	}

	return notFound();
}

// #endregion
