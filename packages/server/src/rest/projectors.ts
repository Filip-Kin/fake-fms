import {
	type Bracket,
	type FMSAllianceData,
	type FMSCurrentResult,
	type FMSFinalsMatchPreview,
	type FMSFinalsMatchResult,
	type FMSFinalsResultsAlliance,
	type FMSMatch,
	type FMSMatchPreview,
	type FMSMatchPreviewAlliance,
	type FMSMatchPreviewTeam,
	type FMSMatchResultsTeam,
	type FMSMatchSchedule,
	type FMSMatchScore,
	type FMSPlayoffAdvancement,
	type FMSPlayoffMatchPreview,
	type FMSPlayoffMatchResult,
	type FMSPlayoffPreviewAlliance,
	type FMSPlayoffResultsAlliance,
	type FMSPlayoffTeam,
	type FMSTeamRanking,
	type PlayoffLevel,
	type PlayoffTiebreakType,
	type ScheduleEntry,
	type StationKey,
	type StoredMatchResult,
	type TournamentLevel,
} from "shared";
import type { FmsStore } from "../state/store";
import { stableMatchId } from "../state/seed";
import { bracketSlot, routeTargets, usesTiebreakers } from "../match/playoff";
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

/**
 * Format an ISO instant the way GetCurrentResults reports actualStartTime: converted to UTC and
 * truncated to seconds with NO offset suffix (capture: "2026-06-08T04:43:00" for a match scheduled
 * "2026-06-08T00:43:00-04:00"). Distinct from the local-offset form the schedule/results use.
 */
function utcNaiveIso(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toISOString().slice(0, 19);
}

function teamRank(store: FmsStore, number: number): number {
	return store.getState().rankings.find((r) => r.teamNumber === number)?.rank ?? 0;
}

/** Fields shared by preview + results team objects (name/rank/avatar; null name+avatar for empty slots). */
function baseTeam(store: FmsStore, number: number): { teamNumber: number; teamName: string | null; teamRank: number; avatar: string | null } {
	const team = store.getState().teams.find((t) => t.number === number);
	const present = number !== 0 && team !== undefined;
	return {
		teamNumber: number,
		teamName: present ? team.name : null,
		teamRank: teamRank(store, number),
		// Real base64 avatar when we have one; "" (present, no avatar) vs null (empty slot) mirrors FMS.
		avatar: present ? (team.avatar ?? "") : null,
	};
}

function previewTeam(store: FmsStore, number: number, level: TournamentLevel): FMSMatchPreviewTeam {
	const base = baseTeam(store, number);
	return withType(FMS_TYPE.MatchPreviewTeam, {
		teamNumber: base.teamNumber,
		teamName: base.teamName,
		// Test-level previews have no qual-rank context: real FMS sends teamRank null there.
		teamRank: level === "None" ? null : base.teamRank,
		avatar: base.avatar,
		// Preview/play only signal presence of a card (boolean); Yellow vs Red shows up in results.
		carryingCard: base.teamNumber !== 0 && store.getState().cards[number] !== undefined,
	});
}

function resultsTeam(store: FmsStore, number: number, level: TournamentLevel): FMSMatchResultsTeam {
	// Real FMS reports the qualification rank delta on qual results (Up/Down/NoChange) and null
	// elsewhere (playoffs/preview have no qual-rank context).
	const rec = store.getState().rankings.find((r) => r.teamNumber === number);
	const teamRankChange = level === "Qualification" && rec ? rec.rankChange : null;
	const card = store.getState().cards[number] ?? "None";
	const base = baseTeam(store, number);
	// Field order mirrors real FMS (MatchResultsQualTeamData). No carryingCard here, unlike preview.
	return withType(FMS_TYPE.MatchResultsTeam, {
		teamNumber: base.teamNumber,
		teamName: base.teamName,
		teamRank: base.teamRank,
		teamRankChange,
		avatar: base.avatar,
		// cardCarryStatus = the card carried into the match; cardEffectiveStatus = the card in effect for
		// this result. The emulator treats them the same (no carry-vs-earned distinction).
		cardCarryStatus: card,
		cardEffectiveStatus: card,
	});
}

/**
 * The 4th (backup/alternate) team for a playoff alliance, or null. Only FourTeam alliances carry one;
 * it lives in alliance-selection state keyed by alliance number, not in the 3-team schedule entry.
 */
function allianceAlternate(store: FmsStore, allianceNumber: number | null): number | null {
	if (allianceNumber == null || store.getState().allianceSelectionType !== "FourTeam") return null;
	const a = store.getState().alliances.find((x) => x.allianceNumber === allianceNumber);
	return a?.alternateTeamNumber ?? null;
}

/** The seeded alliance's display name (e.g. "Alliance 1") for a playoff match, or undefined for quals. */
function allianceName(store: FmsStore, allianceNumber: number | null): string | undefined {
	if (allianceNumber == null) return undefined;
	return store.getState().alliances.find((x) => x.allianceNumber === allianceNumber)?.allianceName;
}

function previewAlliance(store: FmsStore, teams: [number, number, number], level: TournamentLevel): FMSMatchPreviewAlliance {
	return withType(FMS_TYPE.MatchPreviewAlliance, {
		team1: previewTeam(store, teams[0], level),
		team2: previewTeam(store, teams[1], level),
		team3: previewTeam(store, teams[2], level),
	});
}

// Key order matches the capture (fmsMatchId first, teams last); dayNumber is 0 on real FMS.
function scheduleToFMSMatch(entry: ScheduleEntry, fmsEventId: string): FMSMatch {
	return {
		fmsMatchId: entry.fmsMatchId,
		tournamentLevel: entry.level,
		fmsEventId,
		startTime: localOffsetIso(entry.scheduledStartTime),
		actualStartTime: localOffsetIso(entry.actualStartTime ?? entry.scheduledStartTime),
		description: entry.description,
		dayNumber: 0,
		matchNumber: entry.matchNumber,
		playNumber: entry.playNumber,
		teamNumberBlue1: entry.blue[0],
		teamNumberBlue2: entry.blue[1],
		teamNumberBlue3: entry.blue[2],
		teamNumberRed1: entry.red[0],
		teamNumberRed2: entry.red[1],
		teamNumberRed3: entry.red[2],
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
		// Internal "Pending" never goes on the wire: real FMS reports NotStarted / Played here.
		matchStatus: entry.status === "Pending" ? "NotStarted" : entry.status,
		redAllianceNumber: entry.redAllianceNumber,
		blueAllianceNumber: entry.blueAllianceNumber,
	};
}

/**
 * The schedule rows real FMS would serve for the active tournament level. Overtime slots (17-19)
 * exist internally so they can be staged, but real FMS only schedules them once needed, so they
 * are hidden until an alliance is routed into them (capture: 16 Playoff rows, never 19).
 */
function wireSchedule(store: FmsStore): ScheduleEntry[] {
	const { schedule, event, playoffMatches } = store.getState();
	return schedule
		.filter((e) => e.level === event.level)
		.filter((e) => {
			if (e.level !== "Playoff" || e.matchNumber < 17) return true;
			const m = playoffMatches[e.matchNumber];
			return m != null && (m.red != null || m.blue != null);
		});
}

// #region public projectors

/** fieldmonitor/get/GetResults/{level}: real FMS lists only PLAYED matches (capture-verified). */
export function getResults(store: FmsStore, level: TournamentLevel): FMSMatch[] {
	const { schedule, event } = store.getState();
	return schedule
		.filter((e) => e.level === level && e.status === "Played")
		.map((e) => scheduleToFMSMatch(e, event.fmsEventId));
}

/** match/get/GetCurrentSchedule: only the ACTIVE tournament level's rows (capture-verified). */
export function getCurrentSchedule(store: FmsStore): FMSMatchSchedule[] {
	const { event } = store.getState();
	return wireSchedule(store).map((e) => scheduleToFMSSchedule(e, event.fmsEventId));
}

/** The active level's total match count, e.g. GetEventBreakData.totalMatches (capture: 16 in playoffs). */
export function activeLevelMatchCount(store: FmsStore): number {
	return wireSchedule(store).length;
}

function findEntry(store: FmsStore, level: TournamentLevel, matchNumber: number): ScheduleEntry | undefined {
	return store.getState().schedule.find((e) => e.level === level && e.matchNumber === matchNumber);
}

/** The six on-field team numbers, red then blue (the Test level has no schedule; real FMS previews
 *  the teams loaded on the field). */
function stationLineup(store: FmsStore): { red: [number, number, number]; blue: [number, number, number] } {
	const s = store.getState().stations;
	return {
		red: [s.red1.teamNumber, s.red2.teamNumber, s.red3.teamNumber],
		blue: [s.blue1.teamNumber, s.blue2.teamNumber, s.blue3.teamNumber],
	};
}

/**
 * Qual/Practice/Test match preview (the playoff levels use getPlayoffMatchPreview /
 * getFinalsMatchPreview). Returns null when the match does not exist, so the router can 404
 * instead of leaking another match's data.
 */
export function getMatchPreview(store: FmsStore, level: TournamentLevel, matchNumber: number): FMSMatchPreview | null {
	const state = store.getState();
	if (level === "None") {
		// Test level: no schedule. Real FMS previews the on-field test teams with rank null,
		// numberOfQualMatches 0 and the fixed "Match Test" description (capture-verified).
		const lineup = stationLineup(store);
		return withType(FMS_TYPE.MatchPreviewData, {
			matchNumber,
			numberOfQualMatches: 0,
			matchDescription: "Match Test",
			eventName: state.event.name,
			eventCode: state.event.code,
			tournamentType: state.event.tournamentType,
			redAlliance: previewAlliance(store, lineup.red, level),
			blueAlliance: previewAlliance(store, lineup.blue, level),
		});
	}
	const entry = findEntry(store, level, matchNumber);
	if (!entry) return null;
	return withType(FMS_TYPE.MatchPreviewData, {
		matchNumber,
		numberOfQualMatches: state.schedule.filter((e) => e.level === "Qualification").length,
		matchDescription: entry.description,
		eventName: state.event.name,
		eventCode: state.event.code,
		tournamentType: state.event.tournamentType,
		redAlliance: previewAlliance(store, entry.red, level),
		blueAlliance: previewAlliance(store, entry.blue, level),
	});
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
		rankChange: r.rankChange,
		wins: r.wins,
		losses: r.losses,
		ties: r.ties,
		qualifyingScore: r.rankingScore,
		pointsScoredTotal: 0,
		pointsScoredAverage: 0,
		pointsScoredAverageChange: "NoChange",
		matchesPlayed: r.matchesPlayed,
		disqualified: 0,
		sortOrder1: r.rankingScore,
		sortOrder2: r.sort2,
		sortOrder3: r.sort3,
		sortOrder4: r.sort4,
		sortOrder5: r.sort5,
		sortOrder6: r.sort6,
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
	// UTC-naive (converted to UTC, offset dropped), matching the real GetCurrentResults capture.
	const naive = utcNaiveIso(entry.actualStartTime ?? entry.scheduledStartTime);
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

// #region playoff / finals DTO helpers

/** Bracket + level metadata of a playoff match: TEMPLATE slot for 1-13, Final/Single for 14-19. */
function playoffMeta(matchNumber: number): { level: PlayoffLevel; bracket: Bracket } {
	const slot = bracketSlot(matchNumber);
	return slot ? { level: slot.level, bracket: slot.bracket } : { level: "Final", bracket: "Single" };
}

function playoffTeam(store: FmsStore, number: number, typeName: string): FMSPlayoffTeam {
	const base = baseTeam(store, number);
	return withType(typeName, {
		teamNumber: base.teamNumber,
		teamName: base.teamName,
		avatar: base.avatar,
	});
}

/** All team numbers of an alliance (3 picks + alternate when present). */
function allianceTeamNumbers(store: FmsStore, allianceNumber: number | null): number[] {
	if (allianceNumber == null) return [];
	const a = store.getState().alliances.find((x) => x.allianceNumber === allianceNumber);
	if (!a) return [];
	return [a.captainTeamNumber, a.firstRoundTeamNumber, a.secondRoundTeamNumber, a.alternateTeamNumber].filter(
		(n): n is number => n != null,
	);
}

/** The worst card carried by any team of the alliance (Red beats Yellow beats None). */
function allianceCard(store: FmsStore, allianceNumber: number | null): "None" | "Yellow" | "Red" {
	const cards = store.getState().cards;
	let worst: "None" | "Yellow" | "Red" = "None";
	for (const n of allianceTeamNumbers(store, allianceNumber)) {
		const c = cards[n];
		if (c === "Red") return "Red";
		if (c === "Yellow") worst = "Yellow";
	}
	return worst;
}

/** Advancement block for a downstream match number (undefined = eliminated). */
function advancementTo(store: FmsStore, target: number | undefined): FMSPlayoffAdvancement {
	if (target === undefined) {
		// Eliminated: the bundle model's defaults (matchNumber 0, empty strings) with the flag set;
		// the audience display only reads isEliminated in this case.
		return withType(FMS_TYPE.PlayoffAdvancement, {
			matchNumber: 0,
			matchLevel: "" as const,
			matchBracket: "" as const,
			matchDescription: "",
			isEliminated: true,
		});
	}
	if (target >= 14) {
		// Advancing to the finals: real wire numbering calls the first finals match 1 ("Final 1").
		return withType(FMS_TYPE.PlayoffAdvancement, {
			matchNumber: 1,
			matchLevel: "Final" as const,
			matchBracket: "Single" as const,
			matchDescription: "Final 1",
			isEliminated: false,
		});
	}
	const slot = bracketSlot(target);
	const entry = findEntry(store, "Playoff", target);
	return withType(FMS_TYPE.PlayoffAdvancement, {
		matchNumber: target,
		matchLevel: slot?.level ?? ("" as const),
		matchBracket: slot?.bracket ?? ("" as const),
		matchDescription: entry?.description ?? `Match ${target} (${slot?.round ?? ""})`,
		isEliminated: false,
	});
}

/** Completed finals-series wins (matches 14-19) for an alliance number. */
function finalsWins(store: FmsStore, allianceNumber: number | null): number {
	if (allianceNumber == null) return 0;
	return Object.values(store.getState().playoffMatches).filter(
		(m) =>
			m.matchNumber >= 14 &&
			m.complete &&
			((m.winner === "Red" && m.red === allianceNumber) || (m.winner === "Blue" && m.blue === allianceNumber)),
	).length;
}

function playoffPreviewAlliance(store: FmsStore, entry: ScheduleEntry, side: "red" | "blue"): FMSPlayoffPreviewAlliance {
	const allianceNumber = side === "red" ? entry.redAllianceNumber : entry.blueAllianceNumber;
	const teams = side === "red" ? entry.red : entry.blue;
	const alternate = allianceAlternate(store, allianceNumber);
	return withType(FMS_TYPE.MatchPreviewPlayoffAlliance, {
		allianceName: allianceName(store, allianceNumber) ?? "",
		allianceNumber: allianceNumber ?? 0,
		// Playoff previews flag cards at the alliance level (the team objects carry no card field).
		carryingCard: allianceCard(store, allianceNumber) !== "None",
		team1: playoffTeam(store, teams[0], FMS_TYPE.PlayoffPreviewTeam),
		team2: playoffTeam(store, teams[1], FMS_TYPE.PlayoffPreviewTeam),
		team3: playoffTeam(store, teams[2], FMS_TYPE.PlayoffPreviewTeam),
		team4: alternate ? playoffTeam(store, alternate, FMS_TYPE.PlayoffPreviewTeam) : null,
	});
}

/**
 * audience/get/GetDoubleElimPlayoffMatchPreviewData/{n}: bracket-match preview with the
 * winner/loser advancement banners. `matchNumber` is the internal playoff number (1-13).
 * Returns null (404) when the match does not exist.
 */
export function getPlayoffMatchPreview(store: FmsStore, matchNumber: number): FMSPlayoffMatchPreview | null {
	const state = store.getState();
	const entry = findEntry(store, "Playoff", matchNumber);
	const slot = bracketSlot(matchNumber);
	if (!entry || !slot) return null;
	const targets = routeTargets(matchNumber);
	return withType(FMS_TYPE.MatchPreviewPlayoffData, {
		matchNumber,
		matchDescription: entry.description,
		eventName: state.event.name,
		eventCode: state.event.code,
		tournamentType: state.event.tournamentType,
		playoffBracket: slot.bracket,
		allianceCount: state.bracket?.allianceCount ?? "EightAlliance",
		playoffLevel: slot.level,
		winnerPlayoffAdvancementData: advancementTo(store, targets.winner),
		loserPlayoffAdvancementData: advancementTo(store, targets.loser),
		redAlliance: playoffPreviewAlliance(store, entry, "red"),
		blueAlliance: playoffPreviewAlliance(store, entry, "blue"),
	});
}

/**
 * audience/get/GetDoubleElimFinalMatchPreviewData/{n}: the playoff preview shape plus the live
 * best-of-3 tally (redWins/blueWins). `matchNumber` is internal (14-19). Returns null when the
 * finals match does not exist.
 */
export function getFinalsMatchPreview(store: FmsStore, matchNumber: number): FMSFinalsMatchPreview | null {
	const state = store.getState();
	const entry = findEntry(store, "Playoff", matchNumber);
	if (!entry || matchNumber < 14) return null;
	// The finals have no further bracket to advance into; the audience display never reads the
	// advancement blocks on the finals preview, so they carry the bundle model defaults.
	const noAdvance = (): FMSPlayoffAdvancement =>
		withType(FMS_TYPE.PlayoffAdvancement, {
			matchNumber: 0,
			matchLevel: "" as const,
			matchBracket: "" as const,
			matchDescription: "",
			isEliminated: false,
		});
	return withType(FMS_TYPE.MatchPreviewFinalsData, {
		matchNumber: matchNumber - 13,
		matchDescription: entry.description,
		eventName: state.event.name,
		eventCode: state.event.code,
		tournamentType: state.event.tournamentType,
		playoffBracket: "Single" as const,
		allianceCount: state.bracket?.allianceCount ?? "EightAlliance",
		playoffLevel: "Final" as const,
		winnerPlayoffAdvancementData: noAdvance(),
		loserPlayoffAdvancementData: noAdvance(),
		redWins: finalsWins(store, entry.redAllianceNumber),
		blueWins: finalsWins(store, entry.blueAllianceNumber),
		redAlliance: playoffPreviewAlliance(store, entry, "red"),
		blueAlliance: playoffPreviewAlliance(store, entry, "blue"),
	});
}

// #endregion

// #region match results (commit-time snapshots + live synthesis)

interface ResultDecision {
	winner: "Red" | "Blue" | null;
	tiebreaker: PlayoffTiebreakType;
	redTotal: number;
	blueTotal: number;
	isNewHigh: boolean;
	redScore: Record<string, unknown>;
	blueScore: Record<string, unknown>;
}

/** Score both alliances from live state and decide the winner (per-level tiebreak rules). */
function decideResult(store: FmsStore, level: TournamentLevel, matchNumber: number): ResultDecision {
	const state = store.getState();
	const module = store.getGameModule();
	const redScore = module.recompute(state.score.red);
	const blueScore = module.recompute(state.score.blue);
	const redTotal = Number(redScore.totalPoints ?? 0);
	const blueTotal = Number(blueScore.totalPoints ?? 0);
	// Qual matches can tie. Playoff bracket/overtime ties are broken by the season's tiebreaker
	// criteria; finals 14-16 do NOT use tiebreakers (a tie stands and the series continues).
	const decision =
		level === "Playoff" && usesTiebreakers(matchNumber) ? module.decidePlayoffMatch(redScore, blueScore) : null;
	const winner = decision
		? decision.winner
		: redTotal > blueTotal
			? "Red"
			: blueTotal > redTotal
				? "Blue"
				: null;
	// Real FMS copies the stored PlayoffTiebreak enum (default Unknown = -1) into the
	// playoff/finals results DTOs, so a match decided on points carries "Unknown"
	// (capture-verified at Rainbow Rumble), never null.
	const tiebreaker: PlayoffTiebreakType =
		decision && decision.sortOrder > 0
			? decision.winner === null
				? "TrueTie"
				: (`TieBreakSortOrder${decision.sortOrder}` as PlayoffTiebreakType)
			: "Unknown";

	// Event high score: real FMS flags scoreDetails.isHighScore when an alliance's total tops
	// every score posted so far. Compare against all other played matches' committed finals.
	const priorHigh = Math.max(
		0,
		...state.schedule
			.filter((e) => e.status === "Played" && !(e.level === level && e.matchNumber === matchNumber))
			.flatMap((e) => [e.finalScoreRed ?? 0, e.finalScoreBlue ?? 0]),
	);
	const bestTotal = Math.max(redTotal, blueTotal);
	const isNewHigh = bestTotal > 0 && bestTotal > priorHigh;
	return { winner, tiebreaker, redTotal, blueTotal, isNewHigh, redScore, blueScore };
}

/** Qual/Practice/Test results DTO (the capture-verified MatchResultsQualData shape). */
function buildQualResult(store: FmsStore, level: TournamentLevel, matchNumber: number, entry: ScheduleEntry | undefined, d: ResultDecision): FMSMatchScore {
	const state = store.getState();
	const module = store.getGameModule();
	const lineup = entry ? { red: entry.red, blue: entry.blue } : stationLineup(store);
	const bestTotal = Math.max(d.redTotal, d.blueTotal);

	const allianceData = (side: "Red" | "Blue"): FMSAllianceData => {
		const teams = side === "Red" ? lineup.red : lineup.blue;
		const score = side === "Red" ? d.redScore : d.blueScore;
		const total = side === "Red" ? d.redTotal : d.blueTotal;
		return withType(FMS_TYPE.MatchResultsAlliance, {
			scoreDetails: withType(
				FMS_TYPE.AllianceScoreDetails,
				module.toAllianceScoreDetails(score, {
					win: d.winner === side,
					tie: d.winner === null,
					isHighScore: d.isNewHigh && total === bestTotal,
				}),
			),
			team1: resultsTeam(store, teams[0], level),
			team2: resultsTeam(store, teams[1], level),
			team3: resultsTeam(store, teams[2], level),
		});
	};

	return withType(FMS_TYPE.MatchResultsData, {
		matchNumber,
		numberOfQualMatches: state.schedule.filter((e) => e.level === "Qualification").length,
		matchDescription: entry?.description ?? (level === "None" ? "Match Test" : `Match ${matchNumber}`),
		eventName: state.event.name,
		eventCode: state.event.code,
		season: state.event.season,
		tournamentType: state.event.tournamentType,
		redAllianceData: allianceData("Red"),
		blueAllianceData: allianceData("Blue"),
		matchWinner: d.winner,
		cooppertitionBonusAchieved: false,
	});
}

/** GetMatchResultsDoubleElimPlayoffData DTO for bracket matches 1-13 (bundle-verified shape). */
function buildPlayoffResult(store: FmsStore, matchNumber: number, entry: ScheduleEntry, d: ResultDecision): FMSPlayoffMatchResult {
	const state = store.getState();
	const module = store.getGameModule();
	const meta = playoffMeta(matchNumber);
	const targets = routeTargets(matchNumber);
	const bestTotal = Math.max(d.redTotal, d.blueTotal);

	const allianceData = (side: "Red" | "Blue"): FMSPlayoffResultsAlliance => {
		const teams = side === "Red" ? entry.red : entry.blue;
		const num = side === "Red" ? entry.redAllianceNumber : entry.blueAllianceNumber;
		const score = side === "Red" ? d.redScore : d.blueScore;
		const total = side === "Red" ? d.redTotal : d.blueTotal;
		const alternate = allianceAlternate(store, num);
		const card = allianceCard(store, num);
		// Winner advances downstream; loser takes the loser route or is eliminated. On a replayed
		// true tie both alliances stay in this match, so each points back at it.
		const advancement =
			d.winner === null
				? advancementTo(store, matchNumber)
				: d.winner === side
					? advancementTo(store, targets.winner)
					: advancementTo(store, targets.loser);
		return withType(FMS_TYPE.MatchResultsPlayoffAlliance, {
			allianceName: allianceName(store, num) ?? "",
			allianceNumber: num ?? 0,
			scoreDetails: withType(
				FMS_TYPE.AllianceScoreDetails,
				module.toAllianceScoreDetails(score, {
					win: d.winner === side,
					tie: d.winner === null,
					isHighScore: d.isNewHigh && total === bestTotal,
				}),
			),
			cardCarryStatus: card,
			cardEffectiveStatus: card,
			playoffAdvancementStatus: advancement,
			team1: playoffTeam(store, teams[0], FMS_TYPE.MatchResultsPlayoffTeam),
			team2: playoffTeam(store, teams[1], FMS_TYPE.MatchResultsPlayoffTeam),
			team3: playoffTeam(store, teams[2], FMS_TYPE.MatchResultsPlayoffTeam),
			team4: alternate ? playoffTeam(store, alternate, FMS_TYPE.MatchResultsPlayoffTeam) : null,
		});
	};

	return withType(FMS_TYPE.MatchResultsPlayoffData, {
		matchNumber,
		matchDescription: entry.description,
		eventName: state.event.name,
		eventCode: state.event.code,
		season: state.event.season,
		tournamentType: state.event.tournamentType,
		playoffBracket: meta.bracket,
		allianceCount: state.bracket?.allianceCount ?? "EightAlliance",
		playoffLevel: meta.level,
		redAllianceData: allianceData("Red"),
		blueAllianceData: allianceData("Blue"),
		matchWinner: d.winner,
		tiebreaker: d.tiebreaker,
	});
}

/** GetMatchResultsDoubleElimFinalData DTO for finals/overtime 14-19 (bundle-verified shape). */
function buildFinalsResult(store: FmsStore, matchNumber: number, entry: ScheduleEntry, d: ResultDecision): FMSFinalsMatchResult {
	const state = store.getState();
	const module = store.getGameModule();
	const bestTotal = Math.max(d.redTotal, d.blueTotal);

	const allianceData = (side: "Red" | "Blue"): FMSFinalsResultsAlliance => {
		const teams = side === "Red" ? entry.red : entry.blue;
		const num = side === "Red" ? entry.redAllianceNumber : entry.blueAllianceNumber;
		const score = side === "Red" ? d.redScore : d.blueScore;
		const total = side === "Red" ? d.redTotal : d.blueTotal;
		const alternate = allianceAlternate(store, num);
		const card = allianceCard(store, num);
		return withType(FMS_TYPE.MatchResultsFinalsAlliance, {
			allianceName: allianceName(store, num) ?? "",
			allianceNumber: num ?? 0,
			seriesWins: finalsWins(store, num),
			scoreDetails: withType(
				FMS_TYPE.AllianceScoreDetails,
				module.toAllianceScoreDetails(score, {
					win: d.winner === side,
					tie: d.winner === null,
					isHighScore: d.isNewHigh && total === bestTotal,
				}),
			),
			cardCarryStatus: card,
			cardEffectiveStatus: card,
			team1: playoffTeam(store, teams[0], FMS_TYPE.MatchResultsPlayoffTeam),
			team2: playoffTeam(store, teams[1], FMS_TYPE.MatchResultsPlayoffTeam),
			team3: playoffTeam(store, teams[2], FMS_TYPE.MatchResultsPlayoffTeam),
			team4: alternate ? playoffTeam(store, alternate, FMS_TYPE.MatchResultsPlayoffTeam) : null,
		});
	};

	return withType(FMS_TYPE.MatchResultsFinalsData, {
		matchNumber: matchNumber - 13,
		matchDescription: entry.description,
		eventName: state.event.name,
		eventCode: state.event.code,
		season: state.event.season,
		tournamentType: state.event.tournamentType,
		playoffBracket: "Single",
		allianceCount: state.bracket?.allianceCount ?? "EightAlliance",
		playoffLevel: "Final",
		redAllianceData: allianceData("Red"),
		blueAllianceData: allianceData("Blue"),
		matchWinner: d.winner,
		tiebreaker: d.tiebreaker,
	});
}

/**
 * Build the wire results DTO for a match from the LIVE score state (level-appropriate shape).
 * Called at commit time to snapshot the result, and for the currently loaded uncommitted match.
 * Returns null when the match does not exist at that level.
 */
export function buildMatchResult(store: FmsStore, level: TournamentLevel, matchNumber: number): StoredMatchResult | null {
	const entry = findEntry(store, level, matchNumber);
	if (!entry && level !== "None") return null;
	const d = decideResult(store, level, matchNumber);
	if (level === "Playoff" && entry) {
		return matchNumber >= 14 ? buildFinalsResult(store, matchNumber, entry, d) : buildPlayoffResult(store, matchNumber, entry, d);
	}
	return buildQualResult(store, level, matchNumber, entry, d);
}

/**
 * Serve a match result: the snapshot stored at commit time, or a live synthesis for the currently
 * loaded uncommitted match. Returns null (-> 204, like real FMS pre-event) when the match has no
 * committed result and is not on the field, so an old match can never wear the live score.
 */
export function getMatchResults(store: FmsStore, level: TournamentLevel, matchNumber: number): StoredMatchResult | null {
	const stored = store.getStoredResult(level, matchNumber);
	if (stored) return stored;
	const { current } = store.getState();
	if (current.level !== level || current.matchNumber !== matchNumber) return null;
	return buildMatchResult(store, level, matchNumber);
}

// #endregion
