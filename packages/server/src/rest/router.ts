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
import type { FmsStore } from "../state/store";
import { getCurrentSchedule, getMatchPreview, getMatchResults, getResults } from "./projectors";

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

function levelNumeric(level: TournamentLevel): number {
	return Level[level as keyof typeof Level] ?? 0;
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
	if (p === "/FieldMonitor/MatchNumberAndPlay") {
		return json([state.current.matchNumber, state.current.playNumber, levelNumeric(state.current.level)]);
	}
	// #endregion

	// #region systembase / settings / audience scalars
	if (p === "/api/v1.0/systembase/get/get_CurrentlyActiveEventCode") return quoted(state.event.code);
	if (p === "/api/v1.0/systembase/get/get_CurrentlyActiveEventName") return quoted(state.event.name);
	if (p === "/api/v1.0/systembase/get/get_CurrentlyActiveTournamentLevel") return quoted(state.event.level);
	if (p === "/api/v1.0/settings/get/get_VideoswitchOption") return quoted(state.event.videoSwitchOption);
	if (p === "/api/v1.0/audience/get/GetFMSVersion") return quoted(state.event.fmsVersion);
	// #endregion

	// #region match / schedule / teams
	if (p === "/api/v1.0/match/get/GetAllTeamNumbers") return json(state.teams.map((t) => t.number));
	if (p === "/api/v1.0/match/get/GetCurrentSchedule") return json(getCurrentSchedule(store));
	if (p === "/api/v1.0/audience/get/GetCurrentMatchAndPlayNumber") {
		return json({ item1: state.current.level, item2: state.current.matchNumber, item3: state.current.playNumber });
	}
	// #endregion

	// #region fieldmonitor results / logs
	const resultsMatch = p.match(/^\/api\/v1\.0\/fieldmonitor\/get\/GetResults\/(\w+)$/);
	if (resultsMatch) {
		const level = LEVEL_NAMES[resultsMatch[1] as string] ?? "Qualification";
		return json(getResults(store, level));
	}
	const logMatch = p.match(/^\/api\/v1\.0\/fieldmonitor\/get\/GetLog\/([^/]+)\/(Red|Blue)\/(Station[123])$/);
	if (logMatch) {
		const [, matchId, alliance, stationName] = logMatch as unknown as [string, string, "Red" | "Blue", string];
		const stationIdx = Number(stationName.replace("Station", "")) - 1;
		const entry = state.schedule.find((e) => e.fmsMatchId === matchId);
		if (!entry) return json([]);
		const robot = `${alliance.toLowerCase()}${stationIdx + 1}`;
		const faults = store.getLogFaults(matchId, robot);
		const seed = hashSeed(`${matchId}:${alliance}:${stationName}`);
		const startMs = Date.parse(entry.actualStartTime ?? entry.scheduledStartTime);
		return json(generateStationLog({ seed, faults, startTimeMs: Number.isNaN(startMs) ? undefined : startMs }));
	}
	if (/^\/api\/v1\.0\/fieldmonitor\/get\/GetLog\//.test(p)) {
		return json([]);
	}
	// #endregion

	// #region audience: alliances / rankings / preview / config / bracket
	if (p === "/api/v1.0/audience/get/GetAlliances") return json(state.alliances);
	if (p === "/api/v1.0/audience/get/GetQualRankings") return json(state.rankings);
	if (p === "/api/v1.0/audience_gs/get/GetGameConfig") return json(state.gameConfig);
	if (p === "/api/v1.0/audience_gs/get/GetBracketData") return json(state.bracket);

	const previewMatch = p.match(/^\/api\/v1\.0\/audience\/get\/Get(\w+?)MatchPreviewData\/(\d+)$/);
	if (previewMatch) {
		const level = pathLevelToken(previewMatch[1] as string);
		return json(getMatchPreview(store, level, Number(previewMatch[2])));
	}

	const resultsDataMatch = p.match(/^\/api\/v1\.0\/audience_gs\/get\/GetMatchResults(\w+?)Data\/(\d+)$/);
	if (resultsDataMatch) {
		const level = pathLevelToken(resultsDataMatch[1] as string);
		return json(getMatchResults(store, level, Number(resultsDataMatch[2])));
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
