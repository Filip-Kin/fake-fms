import type { Bracket, PlayoffLevel, PlayoffMatchState } from "shared";

/**
 * Standard FRC 8-alliance double-elimination bracket: topology, round-1 seeding, and the
 * winner/loser routing map. One source of truth shared by the seed (initial bracket), the
 * audience-display projectors (GetBracketData / GetPlayoffMatches / GetPlayoffMatchGroups), and the
 * store's advance-on-commit logic. Matches 1-13 are the bracket, 14-16 are best-of-3 finals,
 * 17-19 are overtime.
 */

// #region topology

export interface BracketSlot {
	matchNumber: number;
	shortName: string;
	/** Round label used in PlayoffMatches longName, e.g. "R1". */
	round: string;
	/** MatchGroupView playoff level (counts down: Level6 is round 1, Final is last). */
	level: PlayoffLevel;
	bracket: Bracket;
	/** MatchGroupView id (the bracket cell), e.g. "M1". */
	group: string;
	winnersNextRoundIsByeRound: boolean;
	/** Round-1 seeded alliance numbers; null for later rounds (decided by results). */
	red: number | null;
	blue: number | null;
}

export const TEMPLATE: BracketSlot[] = [
	{ matchNumber: 1, shortName: "M1", round: "R1", level: "Level6", bracket: "DoubleUpper", group: "M1", winnersNextRoundIsByeRound: false, red: 1, blue: 8 },
	{ matchNumber: 2, shortName: "M2", round: "R1", level: "Level6", bracket: "DoubleUpper", group: "M2", winnersNextRoundIsByeRound: false, red: 4, blue: 5 },
	{ matchNumber: 3, shortName: "M3", round: "R1", level: "Level6", bracket: "DoubleUpper", group: "M3", winnersNextRoundIsByeRound: false, red: 2, blue: 7 },
	{ matchNumber: 4, shortName: "M4", round: "R1", level: "Level6", bracket: "DoubleUpper", group: "M4", winnersNextRoundIsByeRound: false, red: 3, blue: 6 },
	{ matchNumber: 5, shortName: "M5", round: "R2", level: "Level5", bracket: "DoubleLower", group: "M5", winnersNextRoundIsByeRound: false, red: null, blue: null },
	{ matchNumber: 6, shortName: "M6", round: "R2", level: "Level5", bracket: "DoubleLower", group: "M6", winnersNextRoundIsByeRound: false, red: null, blue: null },
	{ matchNumber: 7, shortName: "M7", round: "R2", level: "Level5", bracket: "DoubleUpper", group: "M7", winnersNextRoundIsByeRound: true, red: null, blue: null },
	{ matchNumber: 8, shortName: "M8", round: "R2", level: "Level5", bracket: "DoubleUpper", group: "M8", winnersNextRoundIsByeRound: true, red: null, blue: null },
	{ matchNumber: 9, shortName: "M9", round: "R3", level: "Level4", bracket: "DoubleLower", group: "M9", winnersNextRoundIsByeRound: false, red: null, blue: null },
	{ matchNumber: 10, shortName: "M10", round: "R3", level: "Level4", bracket: "DoubleLower", group: "M10", winnersNextRoundIsByeRound: false, red: null, blue: null },
	{ matchNumber: 11, shortName: "M11", round: "R4", level: "Level3", bracket: "DoubleUpper", group: "M11", winnersNextRoundIsByeRound: true, red: null, blue: null },
	{ matchNumber: 12, shortName: "M12", round: "R4", level: "Level3", bracket: "DoubleLower", group: "M12", winnersNextRoundIsByeRound: false, red: null, blue: null },
	{ matchNumber: 13, shortName: "M13", round: "R5", level: "Level2", bracket: "DoubleLower", group: "M13", winnersNextRoundIsByeRound: false, red: null, blue: null },
];

export const FINALS: { matchNumber: number; shortName: string; longName: string; useTiebreakers: boolean; state: string }[] = [
	{ matchNumber: 14, shortName: "F1", longName: "Final 1", useTiebreakers: false, state: "InitialScheduled" },
	{ matchNumber: 15, shortName: "F2", longName: "Final 2", useTiebreakers: false, state: "InitialScheduled" },
	{ matchNumber: 16, shortName: "FT", longName: "Final Tiebreaker", useTiebreakers: false, state: "InitialScheduled" },
	{ matchNumber: 17, shortName: "O1", longName: "Overtime 1", useTiebreakers: true, state: "OvertimeNotScheduled" },
	{ matchNumber: 18, shortName: "O2", longName: "Overtime 2", useTiebreakers: true, state: "OvertimeNotScheduled" },
	{ matchNumber: 19, shortName: "O3", longName: "Overtime 3", useTiebreakers: true, state: "OvertimeNotScheduled" },
];

/** The three finals matches (winner of M11 vs winner of M13). */
const FINALS_MATCHES = [14, 15, 16];
const OVERTIME_MATCHES = [17, 18, 19];

/** The bracket slot for a playoff match number 1-13, or undefined for finals/overtime. */
export function bracketSlot(matchNumber: number): BracketSlot | undefined {
	return TEMPLATE.find((s) => s.matchNumber === matchNumber);
}

/** The finals/overtime metadata for a playoff match number 14-19, or undefined. */
export function finalsSlot(matchNumber: number): (typeof FINALS)[number] | undefined {
	return FINALS.find((f) => f.matchNumber === matchNumber);
}

/**
 * Whether the season tiebreaker criteria apply to a playoff match. Bracket matches (1-13) and
 * overtime (17-19) are tiebroken; finals 14-16 are not: a finals match tied on points stands as a
 * tie and the series continues (to overtime if needed).
 */
export function usesTiebreakers(matchNumber: number): boolean {
	const f = finalsSlot(matchNumber);
	return f ? f.useTiebreakers : true;
}

interface RouteTarget {
	match: number;
	slot: "red" | "blue";
}

/**
 * Where the winner and loser of each bracket match advance. Matches with no `loser` entry eliminate
 * the loser. Match 11 winner and match 13 winner both feed the finals (match 14, expanded to all
 * three finals slots by `setSlot`).
 */
const ROUTING: Record<number, { winner?: RouteTarget; loser?: RouteTarget }> = {
	1: { winner: { match: 7, slot: "red" }, loser: { match: 5, slot: "red" } },
	2: { winner: { match: 7, slot: "blue" }, loser: { match: 5, slot: "blue" } },
	3: { winner: { match: 8, slot: "red" }, loser: { match: 6, slot: "red" } },
	4: { winner: { match: 8, slot: "blue" }, loser: { match: 6, slot: "blue" } },
	5: { winner: { match: 10, slot: "blue" } },
	6: { winner: { match: 9, slot: "blue" } },
	7: { winner: { match: 11, slot: "red" }, loser: { match: 9, slot: "red" } },
	8: { winner: { match: 11, slot: "blue" }, loser: { match: 10, slot: "red" } },
	9: { winner: { match: 12, slot: "red" } },
	10: { winner: { match: 12, slot: "blue" } },
	11: { winner: { match: 14, slot: "red" }, loser: { match: 13, slot: "red" } },
	12: { winner: { match: 13, slot: "blue" } },
	13: { winner: { match: 14, slot: "blue" } },
};

// #endregion

// #region state construction + advancement

function emptyMatch(matchNumber: number, red: number | null, blue: number | null): PlayoffMatchState {
	return { matchNumber, red, blue, redScore: 0, blueScore: 0, winner: "None", complete: false };
}

/** Build a fresh playoff bracket: round 1 seeded by the standard 1v8/4v5/2v7/3v6, the rest empty. */
export function initialPlayoffMatches(): Record<number, PlayoffMatchState> {
	const out: Record<number, PlayoffMatchState> = {};
	for (const slot of TEMPLATE) out[slot.matchNumber] = emptyMatch(slot.matchNumber, slot.red, slot.blue);
	// Overtime slots exist unrouted (no alliances) until the series needs them,
	// which keeps them off the wire schedule exactly like real FMS.
	for (const m of [...FINALS_MATCHES, ...OVERTIME_MATCHES]) out[m] = emptyMatch(m, null, null);
	return out;
}

/**
 * Schedule the next overtime when the finals group cannot produce a champion:
 * every scheduled finals-group match is complete and neither alliance has two
 * wins. Fills the first empty overtime slot with the finalist alliances (real
 * FMS reveals OT rows on the wire only once this happens).
 */
export function maybeScheduleOvertime(matches: Record<number, PlayoffMatchState>): void {
	const finalists = matches[14];
	if (!finalists?.red || !finalists?.blue) return;
	const group = [...FINALS_MATCHES, ...OVERTIME_MATCHES]
		.map((n) => matches[n])
		.filter((m): m is PlayoffMatchState => m != null && m.red != null && m.blue != null);
	if (!group.every((m) => m.complete)) return;
	const wins = (alliance: number | null): number =>
		group.filter((m) => (m.winner === "Red" && m.red === alliance) || (m.winner === "Blue" && m.blue === alliance)).length;
	if (wins(finalists.red) >= 2 || wins(finalists.blue) >= 2) return;
	const next = OVERTIME_MATCHES.map((n) => matches[n]).find((m) => m != null && m.red == null);
	if (next) {
		next.red = finalists.red;
		next.blue = finalists.blue;
	}
}

/** Set an alliance into a match slot; for the finals target (14) fill all three finals matches. */
function setSlot(matches: Record<number, PlayoffMatchState>, target: RouteTarget, alliance: number | null): void {
	const targets = target.match === 14 ? FINALS_MATCHES : [target.match];
	for (const m of targets) {
		const match = matches[m];
		if (match) match[target.slot] = alliance;
	}
}

/**
 * The downstream match numbers a bracket match's winner and loser feed (winner 14 = the finals;
 * loser undefined = eliminated). Used by the playoff preview/result advancement projections.
 */
export function routeTargets(matchNumber: number): { winner?: number; loser?: number } {
	const route = ROUTING[matchNumber];
	const out: { winner?: number; loser?: number } = {};
	if (route?.winner) out.winner = route.winner.match;
	if (route?.loser) out.loser = route.loser.match;
	return out;
}

/**
 * Record the result of a completed bracket match and route its winner/loser into the downstream
 * matches. Call after setting `matches[n].winner` + scores + complete. No-op for finals matches
 * (their advancement is the championship, handled by the caller via `currentPlayoffLevel`).
 */
export function applyAdvance(matches: Record<number, PlayoffMatchState>, matchNumber: number): void {
	const match = matches[matchNumber];
	const route = ROUTING[matchNumber];
	if (!match || !route || match.winner === "None") return;
	const winnerAlliance = match.winner === "Red" ? match.red : match.blue;
	const loserAlliance = match.winner === "Red" ? match.blue : match.red;
	if (route.winner) setSlot(matches, route.winner, winnerAlliance);
	if (route.loser) setSlot(matches, route.loser, loserAlliance);
}

/** The level of the next unplayed match, i.e. the bracket's current level for GetCurrentPlayoffLevel. */
export function currentPlayoffLevel(matches: Record<number, PlayoffMatchState>): PlayoffLevel {
	for (const slot of TEMPLATE) {
		if (!matches[slot.matchNumber]?.complete) return slot.level;
	}
	return "Final";
}

// #endregion
