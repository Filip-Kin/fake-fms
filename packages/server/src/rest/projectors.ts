import {
	type FMSAllianceData,
	type FMSCurrentResult,
	type FMSTeamRanking,
	type FMSMatch,
	type FMSMatchPreview,
	type FMSMatchPreviewAlliance,
	type FMSMatchPreviewTeam,
	type FMSMatchResultsTeam,
	type FMSMatchSchedule,
	type FMSMatchScore,
	type ScheduleEntry,
	type StationKey,
	type TournamentLevel,
} from "shared";
import type { FmsStore } from "../state/store";
import { stableMatchId } from "../state/seed";
import { FMS_TYPE, withType } from "./fms-types";

/**
 * Format a UTC ISO instant the way real FMS does in schedule/results: local wall-clock with a
 * timezone offset and no fractional seconds, e.g. `2026-06-08T00:43:00-04:00` (not a `...Z` form).
 * The offset follows the server's local timezone, so set TZ in the container for a realistic venue.
 */
function localOffsetIso(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const pad = (n: number): string => String(n).padStart(2, "0");
	const tzMin = -d.getTimezoneOffset();
	const sign = tzMin >= 0 ? "+" : "-";
	const abs = Math.abs(tzMin);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function teamRank(store: FmsStore, number: number): number {
	return store.getState().rankings.find((r) => r.teamNumber === number)?.rank ?? 0;
}

function previewTeam(store: FmsStore, number: number): FMSMatchPreviewTeam {
	const team = store.getState().teams.find((t) => t.number === number);
	const present = number !== 0 && team !== undefined;
	return {
		teamNumber: number,
		// Empty alliance slots (teamNumber 0) report null name + avatar, like real FMS.
		teamName: present ? team.name : null,
		teamRank: teamRank(store, number),
		avatar: present ? "" : null,
		carryingCard: false,
	};
}

function resultsTeam(store: FmsStore, number: number): FMSMatchResultsTeam {
	return {
		...previewTeam(store, number),
		teamRankChange: null,
		cardCarryStatus: "None",
		cardEffectiveStatus: "None",
	};
}

function previewAlliance(store: FmsStore, teams: [number, number, number]): FMSMatchPreviewAlliance {
	return {
		team1: previewTeam(store, teams[0]),
		team2: previewTeam(store, teams[1]),
		team3: previewTeam(store, teams[2]),
	};
}

function scheduleToFMSMatch(entry: ScheduleEntry, fmsEventId: string): FMSMatch {
	return {
		actualStartTime: localOffsetIso(entry.actualStartTime ?? ""),
		dayNumber: 1,
		description: entry.description,
		fmsEventId,
		fmsMatchId: entry.fmsMatchId,
		matchNumber: entry.matchNumber,
		playNumber: entry.playNumber,
		startTime: localOffsetIso(entry.scheduledStartTime),
		teamNumberBlue1: entry.blue[0],
		teamNumberBlue2: entry.blue[1],
		teamNumberBlue3: entry.blue[2],
		teamNumberRed1: entry.red[0],
		teamNumberRed2: entry.red[1],
		teamNumberRed3: entry.red[2],
		tournamentLevel: entry.level,
	};
}

function scheduleToFMSSchedule(entry: ScheduleEntry, fmsEventId: string): FMSMatchSchedule {
	return {
		scheduleDetailId: entry.fmsMatchId,
		tournamentLevel: entry.level,
		fmsEventId,
		startTime: localOffsetIso(entry.scheduledStartTime),
		description: entry.description,
		dayNumber: null,
		fieldType: "Primary",
		matchNumber: entry.matchNumber,
		teamNumberBlue1: entry.blue[0],
		teamNumberBlue2: entry.blue[1],
		teamNumberBlue3: entry.blue[2],
		teamNumberRed1: entry.red[0],
		teamNumberRed2: entry.red[1],
		teamNumberRed3: entry.red[2],
		finalScoreBlue: entry.finalScoreBlue,
		finalScoreRed: entry.finalScoreRed,
		matchStatus: entry.status,
		redAllianceNumber: entry.redAllianceNumber,
		blueAllianceNumber: entry.blueAllianceNumber,
	};
}

// #region public projectors

export function getResults(store: FmsStore, level: TournamentLevel): FMSMatch[] {
	const { schedule, event } = store.getState();
	return schedule.filter((e) => e.level === level).map((e) => scheduleToFMSMatch(e, event.fmsEventId));
}

export function getCurrentSchedule(store: FmsStore): FMSMatchSchedule[] {
	const { schedule, event } = store.getState();
	return schedule.map((e) => scheduleToFMSSchedule(e, event.fmsEventId));
}

function findEntry(store: FmsStore, level: TournamentLevel, matchNumber: number): ScheduleEntry | undefined {
	return store.getState().schedule.find((e) => e.level === level && e.matchNumber === matchNumber);
}

export function getMatchPreview(store: FmsStore, level: TournamentLevel, matchNumber: number): FMSMatchPreview {
	const state = store.getState();
	const entry = findEntry(store, level, matchNumber) ?? state.schedule[0];
	const red = entry?.red ?? [0, 0, 0];
	const blue = entry?.blue ?? [0, 0, 0];
	return {
		matchNumber,
		matchDescription: entry?.description ?? `Match ${matchNumber}`,
		numberOfQualMatches: state.schedule.filter((e) => e.level === "Qualification").length,
		eventName: state.event.name,
		tournamentType: state.event.tournamentType,
		redAlliance: previewAlliance(store, red),
		blueAlliance: previewAlliance(store, blue),
	};
}

/** Deterministic [0,1) value from a string, so randomSortValue is stable across calls. */
function stableUnit(seed: string): number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return ((h >>> 0) % 1_000_000) / 1_000_000;
}

/**
 * rankings/get/GetTeamRankings: the rich sortable ranking model. The emulator does not track
 * win/loss/qualifying detail, so those are zero (correct for a not-yet-played event) and ids are
 * deterministic; the shape matches real FMS exactly.
 */
export function getTeamRankings(store: FmsStore): FMSTeamRanking[] {
	const state = store.getState();
	const now = localOffsetIso(new Date().toISOString()).slice(0, 19);
	return state.rankings.map((r) => ({
		randomSortValue: stableUnit(`sort:${r.teamNumber}`),
		eventParticipant: null,
		fmsEventId: state.event.fmsEventId,
		fmsTeamId: stableMatchId(`fmsteam:${r.teamNumber}`),
		ranking: r.rank,
		rankChange: "NoChange",
		wins: 0,
		losses: 0,
		ties: 0,
		qualifyingScore: 0,
		pointsScoredTotal: 0,
		pointsScoredAverage: 0,
		pointsScoredAverageChange: "NoChange",
		matchesPlayed: 0,
		disqualified: 0,
		sortOrder1: 0,
		sortOrder2: 0,
		sortOrder3: 0,
		sortOrder4: 0,
		sortOrder5: 0,
		sortOrder6: 0,
		createdOn: now,
		createdBy: "RankingRepo GetEventParticipantAndTeamRanking",
		modifiedOn: now,
		modifiedBy: "RankingService UpdateQualificationRanks",
	}));
}

/** match/get/GetCurrentResults: the current match as a per-station result row (array of one). */
export function getCurrentResults(store: FmsStore): FMSCurrentResult[] {
	const state = store.getState();
	const { current, event } = state;
	const entry = state.schedule.find((e) => e.matchNumber === current.matchNumber && e.level === current.level);
	if (!entry) return [];
	const module = store.getGameModule();
	const red = module.recompute(state.score.red);
	const blue = module.recompute(state.score.blue);
	const naive = localOffsetIso(entry.actualStartTime ?? entry.scheduledStartTime).slice(0, 19);
	const bypassed = (key: StationKey): boolean => state.stations[key].bypassed;
	// scoreDetails is a gzipped score blob on real FMS; stub it with a gzip of "{}" (valid to gunzip).
	const scoreBlob = Buffer.from(Bun.gzipSync(Buffer.from("{}"))).toString("base64");
	return [
		{
			matchId: entry.fmsMatchId,
			scheduleDetailId: entry.fmsMatchId,
			tournamentLevel: entry.level,
			fmsEventId: event.fmsEventId,
			actualStartTime: naive,
			description: entry.description,
			dayNumber: null,
			matchNumber: entry.matchNumber,
			teamNumberBlue1: entry.blue[0],
			cardBlue1: "None",
			isDisqualifiedBlue1: false,
			isBypassedBlue1: bypassed("blue1"),
			teamNumberBlue2: entry.blue[1],
			cardBlue2: "None",
			isDisqualifiedBlue2: false,
			isBypassedBlue2: bypassed("blue2"),
			teamNumberBlue3: entry.blue[2],
			cardBlue3: "None",
			isDisqualifiedBlue3: false,
			isBypassedBlue3: bypassed("blue3"),
			teamNumberRed1: entry.red[0],
			cardRed1: "None",
			isDisqualifiedRed1: false,
			isBypassedRed1: bypassed("red1"),
			teamNumberRed2: entry.red[1],
			cardRed2: "None",
			isDisqualifiedRed2: false,
			isBypassedRed2: bypassed("red2"),
			teamNumberRed3: entry.red[2],
			cardRed3: "None",
			isDisqualifiedRed3: false,
			isBypassedRed3: bypassed("red3"),
			blueAutoScore: Number(blue.autoPoints ?? 0),
			bluePenalty: Number(blue.foulPoints ?? 0),
			blueScore: Number(blue.totalPoints ?? 0),
			redAutoScore: Number(red.autoPoints ?? 0),
			redPenalty: Number(red.foulPoints ?? 0),
			redScore: Number(red.totalPoints ?? 0),
			redAllianceNumber: entry.redAllianceNumber ?? 0,
			blueAllianceNumber: entry.blueAllianceNumber ?? 0,
			headRefReview: false,
				scoreDetails: withType(FMS_TYPE.ByteArray, { $value: scoreBlob }),
		},
	];
}

export function getMatchResults(store: FmsStore, level: TournamentLevel, matchNumber: number): FMSMatchScore {
	const state = store.getState();
	const stored = state.results[store.resultKey(level, matchNumber)];
	if (stored) return stored;

	// Synthesize a live result from the current score state.
	const module = store.getGameModule();
	const entry = findEntry(store, level, matchNumber) ?? state.schedule[0];
	const red = entry?.red ?? [0, 0, 0];
	const blue = entry?.blue ?? [0, 0, 0];
	const redScore = module.recompute(state.score.red);
	const blueScore = module.recompute(state.score.blue);
	const redTotal = Number(redScore.totalPoints ?? 0);
	const blueTotal = Number(blueScore.totalPoints ?? 0);
	const winner = redTotal > blueTotal ? "Red" : blueTotal > redTotal ? "Blue" : null;

	const redData: FMSAllianceData = {
		scoreDetails: module.toAllianceScoreDetails(redScore, {
			win: winner === "Red",
			tie: winner === null,
			isHighScore: false,
		}),
		team1: resultsTeam(store, red[0]),
		team2: resultsTeam(store, red[1]),
		team3: resultsTeam(store, red[2]),
	};
	const blueData: FMSAllianceData = {
		scoreDetails: module.toAllianceScoreDetails(blueScore, {
			win: winner === "Blue",
			tie: winner === null,
			isHighScore: false,
		}),
		team1: resultsTeam(store, blue[0]),
		team2: resultsTeam(store, blue[1]),
		team3: resultsTeam(store, blue[2]),
	};

	return {
		matchNumber,
		numberOfQualMatches: state.schedule.filter((e) => e.level === "Qualification").length,
		matchDescription: entry?.description ?? `Match ${matchNumber}`,
		eventName: state.event.name,
		eventCode: state.event.code,
		season: state.event.season,
		tournamentType: state.event.tournamentType,
		redAllianceData: redData,
		blueAllianceData: blueData,
		matchWinner: winner,
		cooppertitionBonusAchieved: false,
	};
}

// #endregion
