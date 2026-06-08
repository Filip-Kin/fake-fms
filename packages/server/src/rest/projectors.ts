import {
	type FMSAllianceData,
	type FMSMatch,
	type FMSMatchPreview,
	type FMSMatchPreviewAlliance,
	type FMSMatchPreviewTeam,
	type FMSMatchResultsTeam,
	type FMSMatchSchedule,
	type FMSMatchScore,
	type ScheduleEntry,
	type TournamentLevel,
} from "shared";
import type { FmsStore } from "../state/store";

function teamName(store: FmsStore, number: number): string {
	return store.getState().teams.find((t) => t.number === number)?.name ?? `Team ${number}`;
}

function teamRank(store: FmsStore, number: number): number {
	return store.getState().rankings.find((r) => r.teamNumber === number)?.rank ?? 0;
}

function previewTeam(store: FmsStore, number: number): FMSMatchPreviewTeam {
	return {
		teamNumber: number,
		teamName: teamName(store, number),
		teamRank: teamRank(store, number),
		avatar: "",
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
		actualStartTime: entry.actualStartTime ?? "",
		dayNumber: 1,
		description: entry.description,
		fmsEventId,
		fmsMatchId: entry.fmsMatchId,
		matchNumber: entry.matchNumber,
		playNumber: entry.playNumber,
		startTime: entry.scheduledStartTime,
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
		startTime: entry.scheduledStartTime,
		description: entry.description,
		dayNumber: 1,
		fieldType: "RegularField",
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
