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
} from "shared";
import { json, notFound, quoted, text } from "../http";
import { generateStationLog, hashSeed } from "../match/log-generator";
import { AUTO_SECONDS, teleopSeconds } from "../match/timing";
import type { FmsStore } from "../state/store";
import { stableMatchId } from "../state/seed";
import { arrayOfType, FMS_TYPE, withType } from "./fms-types";
import { getCurrentResults, getCurrentSchedule, getTeamRankings, getMatchPreview, getMatchResults, getResults } from "./projectors";
import {
	getAllAlliances,
	getAllianceSelectionData,
	getAudienceAlliances,
	getBracketData,
	getPlayoffMatches,
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

/** Map the level token embedded in preview/results endpoint names to a TournamentLevel. */
function pathLevelToken(token: string): TournamentLevel {
	switch (token) {
		case "Practice":
			return "Practice";
		case "Test":
			return "None";
		case "DoubleElimPlayoff":
		case "DoubleElimFinal":
		case "Playoff":
			return "Playoff";
		default:
			return "Qualification"; // "Qual"
	}
}

/** DoubleElimFinal endpoints number the finals 1-3 (overtime 4-6); internally they're 14-19. */
function pathMatchNumber(token: string, n: string): number {
	return token === "DoubleElimFinal" ? Number(n) + 13 : Number(n);
}

function tournamentFromNumeric(n: number): TournamentLevel {
	return (["None", "Practice", "Qualification", "Playoff"][n] as TournamentLevel) ?? "None";
}

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
		return json([state.current.matchNumber, state.current.playNumber, Level[state.current.level]]);
	}
	// #endregion

	// Real FMS serves the same read method under several controller prefixes (audience,
	// driverstationservice, fieldmonitor, match, rankings, audience_gs, systembase, settings).
	// Match on the method name alone so every documented controller alias resolves to one handler.
	const m = p.replace(/^\/api\/v1\.0\/[a-z_]+\/get\//i, "");

	// Controller-specific: real FMS returns CurrentlyActiveEventDbExists=true ONLY under the match
	// controller (404 on all others), so this is checked on the full path, not the aliased method.
	if (p === "/api/v1.0/match/get/CurrentlyActiveEventDbExists") return json(true);

	// #region systembase / settings / audience scalars
	if (m === "get_CurrentlyActiveEventCode") return quoted(state.event.code);
	if (m === "get_CurrentlyActiveEventName") return quoted(state.event.name);
	if (m === "get_CurrentlyActiveTournamentLevel") return quoted(state.event.level);
	if (m === "get_VideoswitchOption") return quoted(state.event.videoSwitchOption);
	if (m === "GetFMSVersion") return quoted(state.event.fmsVersion);
	// #endregion

	// #region match / schedule / teams
	if (m === "GetAllTeamNumbers") return json(state.teams.map((t) => t.number));
	if (m === "GetCurrentResults") return json(arrayOfType(FMS_TYPE.CurrentResult, getCurrentResults(store)));
	if (m === "GetDefaultCycleTimeMinutes") return json(9);
	if (m === "GetCurrentPlayoffLevel") return quoted(state.bracket?.currentLevel ?? "None");
	if (m === "GetFMSTeamIdsWithRankingRecord")
		return json(state.rankings.map((r) => stableMatchId(`fmsteam:${r.teamNumber}`)));
	if (m === "GetRegionalAdvancers") return json(withType(FMS_TYPE.RegionalAdvancers, { advancers: [] }));
	if (m === "GetRegionalPreviouslyQualifiedTeams") return json(withType(FMS_TYPE.RegionalPool, { teams: [] }));
	if (m === "GetEventBreakData") {
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
				totalMatches: state.schedule.length,
				redAllianceName: allianceName(redNum),
				redAllianceNumber: redNum,
				blueAllianceName: allianceName(blueNum),
				blueAllianceNumber: blueNum,
			}),
		);
	}
	if (m === "GetCurrentSchedule") return json(arrayOfType(FMS_TYPE.ScheduleViewItem, getCurrentSchedule(store)));
	if (m === "GetCurrentMatchAndPlayNumber") {
		return json(
			withType(FMS_TYPE.CurrentMatchTuple, {
				item1: state.current.level,
				item2: state.current.matchNumber,
				item3: state.current.playNumber,
			}),
		);
	}
	// #endregion

	// #region fieldmonitor results / logs
	const resultsMatch = m.match(/^GetResults\/(\w+)$/);
	if (resultsMatch) {
		const level = LEVEL_NAMES[resultsMatch[1] as string] ?? "Qualification";
		return json(arrayOfType(FMS_TYPE.WebMatchViewItem, getResults(store, level)));
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
	if (/^GetLog\//.test(m)) {
		return json([]);
	}
	// #endregion

	// #region audience: alliances / rankings / preview / config / bracket
	if (m === "GetAlliances") return json(getAudienceAlliances(store));
	if (m === "GetAllAlliances") return json(getAllAlliances(store));
	if (m === "GetAllianceSelectionData") return json(getAllianceSelectionData(store));
	if (m === "GetQualRankings") return json(getQualRankings(store));
	if (m === "GetQualificationRankData") return json(getQualRankData(store));
	if (m === "GetTeamRankings") return json(arrayOfType(FMS_TYPE.TeamRanking, getTeamRankings(store)));
	if (m === "GetPlayoffMatches") return json(getPlayoffMatches(store));
	if (m === "GetPlayoffMatchGroups") return json(getPlayoffMatchGroups(store));
	if (m === "GetGameConfig") return json(withType(FMS_TYPE.GameConfig, state.gameConfig));
	if (m === "GetBracketData") return json(getBracketData(store));

	const previewMatch = m.match(/^Get(\w+?)MatchPreviewData\/(\d+)$/);
	if (previewMatch) {
		const level = pathLevelToken(previewMatch[1] as string);
		return json(getMatchPreview(store, level, pathMatchNumber(previewMatch[1] as string, previewMatch[2] as string)));
	}

	const resultsDataMatch = m.match(/^GetMatchResults(\w+?)Data\/(\d+)$/);
	if (resultsDataMatch) {
		const level = pathLevelToken(resultsDataMatch[1] as string);
		return json(getMatchResults(store, level, pathMatchNumber(resultsDataMatch[1] as string, resultsDataMatch[2] as string)));
	}
	// #endregion

	// #region notes
	if (p.startsWith("/Notes/")) {
		return handleNotes(store, req, url, p);
	}
	// #endregion

	return null;
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
		const body = (await req.json()) as FTAAddNoteBody;
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
