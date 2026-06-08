import type { AudienceBracketAlliance, Bracket, PlayoffLevel } from "shared";
import type { FmsStore } from "../state/store";
import { FMS_TYPE, withType } from "./fms-types";

/**
 * Playoff + alliance-selection projectors. These mirror the heavy structured endpoints the real
 * FMS serves for the audience display (`GetAllAlliances`, `GetAllianceSelectionData`,
 * `GetQualificationRankData`, `GetPlayoffMatches`, `GetPlayoffMatchGroups`, `GetBracketData`).
 *
 * Everything is derived from the store's alliances + rankings against a fixed 8-alliance
 * double-elimination template, so the responses stay consistent with the emulator's actual event.
 * Field names, `$type` discriminators, and the bracket topology are taken verbatim from the
 * `fms-capture/` ground-truth capture (event mibat2).
 */

// #region double-elim template

interface BracketSlot {
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
	/** Seeded alliance numbers for round 1; null for later rounds (decided by results). */
	red: number | null;
	blue: number | null;
}

/**
 * Standard FRC 8-alliance double-elimination bracket (matches 1-13 + finals 14-16 + overtime
 * 17-19). Round-1 seeding is the canonical 1v8 / 4v5 / 2v7 / 3v6; later rounds start empty.
 */
const TEMPLATE: BracketSlot[] = [
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

/** Finals + overtime entries for PlayoffMatches (no MatchGroupView of their own beyond group "F"). */
const FINALS: { matchNumber: number; shortName: string; longName: string; useTiebreakers: boolean; state: string }[] = [
	{ matchNumber: 14, shortName: "F1", longName: "Final 1", useTiebreakers: false, state: "InitialScheduled" },
	{ matchNumber: 15, shortName: "F2", longName: "Final 2", useTiebreakers: false, state: "InitialScheduled" },
	{ matchNumber: 16, shortName: "FT", longName: "Final Tiebreaker", useTiebreakers: false, state: "InitialScheduled" },
	{ matchNumber: 17, shortName: "O1", longName: "Overtime 1", useTiebreakers: true, state: "OvertimeNotScheduled" },
	{ matchNumber: 18, shortName: "O2", longName: "Overtime 2", useTiebreakers: true, state: "OvertimeNotScheduled" },
	{ matchNumber: 19, shortName: "O3", longName: "Overtime 3", useTiebreakers: true, state: "OvertimeNotScheduled" },
];

// #endregion

// #region helpers

function allianceByNumber(store: FmsStore, n: number | null): AudienceBracketAlliance | undefined {
	if (n == null) return undefined;
	return store.getState().bracket?.alliances.find((a) => a.allianceNumber === n);
}

/**
 * The full AudienceAlliance object (with `$type`) used inside bracket matches and alliance
 * selection. An absent alliance becomes the real "empty" shape: allianceNumber 0, all team fields
 * null, but `einsteinAlliance:"None"` / `cardEffectiveStatus:"None"`.
 */
function audienceAlliance(a: AudienceBracketAlliance | undefined): object {
	if (!a) {
		return withType(FMS_TYPE.AudienceAlliance, {
			allianceNumber: 0,
			allianceName: null,
			einsteinAlliance: "None",
			isEinstein: false,
			captainTeamNumber: null,
			captainTeamNameShort: null,
			captainAvatar: null,
			firstRoundTeamNumber: null,
			firstRoundTeamNameShort: null,
			firstRoundAvatar: null,
			secondRoundTeamNumber: null,
			secondRoundTeamNameShort: null,
			secondRoundAvatar: null,
			alternateTeamNumber: null,
			alternateTeamNameShort: null,
			alternateAvatar: null,
			cardEffectiveStatus: "None",
		});
	}
	return withType(FMS_TYPE.AudienceAlliance, {
		allianceNumber: a.allianceNumber,
		allianceName: a.allianceName,
		einsteinAlliance: "None",
		isEinstein: false,
		captainTeamNumber: a.captainTeamNumber,
		captainTeamNameShort: a.captainTeamNameShort,
		captainAvatar: a.captainAvatar,
		firstRoundTeamNumber: a.firstRoundTeamNumber,
		firstRoundTeamNameShort: a.firstRoundTeamNameShort,
		firstRoundAvatar: a.firstRoundAvatar,
		secondRoundTeamNumber: a.secondRoundTeamNumber,
		secondRoundTeamNameShort: a.secondRoundTeamNameShort,
		secondRoundAvatar: a.secondRoundAvatar,
		alternateTeamNumber: a.alternateTeamNumber || null,
		alternateTeamNameShort: a.alternateTeamNameShort,
		alternateAvatar: a.alternateAvatar,
		cardEffectiveStatus: a.cardEffectiveStatus,
	});
}

/** Teams that belong to an alliance, so they can be excluded from the available-team pool. */
function pickedTeams(store: FmsStore): Set<number> {
	const picked = new Set<number>();
	for (const a of store.getState().alliances) {
		for (const n of [a.captainTeamNumber, a.firstRoundTeamNumber, a.secondRoundTeamNumber, a.alternateTeamNumber]) {
			if (n != null) picked.add(n);
		}
	}
	return picked;
}

// #endregion

// #region public projectors

/** audience/get/GetAlliances: the full AudienceAlliance objects (with avatars + einstein fields). */
export function getAudienceAlliances(store: FmsStore): object[] {
	return store.getState().bracket?.alliances.map((a) => audienceAlliance(a)) ?? [];
}

/** audience/get/GetAllAlliances: the alliance-selection wizard rows (one per alliance). */
export function getAllAlliances(store: FmsStore): object[] {
	const state = store.getState();
	return state.alliances.map((a) => {
		const raw = (n: number | null): string => (n == null ? "" : String(n));
		return withType(FMS_TYPE.AllianceSelectionWizard, {
			fmsEventId: state.event.fmsEventId,
			number: a.allianceNumber,
			name: a.allianceName,
			substituteButtonEnabled: true,
			captainTeamNumberRaw: raw(a.captainTeamNumber),
			captainTeamNumber: a.captainTeamNumber,
			captainTeamNumberHold: a.captainTeamNumber,
			captainSubstituteChecked: false,
			captainFlag: false,
			captainTabIndex: a.allianceNumber,
			round1TeamNumberRaw: raw(a.firstRoundTeamNumber),
			round1TeamNumber: a.firstRoundTeamNumber,
			round1TeamNumberHold: a.firstRoundTeamNumber,
			round1SubstituteChecked: false,
			round1Flag: false,
			round1TabIndex: 8 + a.allianceNumber,
			round2TeamNumberRaw: raw(a.secondRoundTeamNumber),
			round2TeamNumber: a.secondRoundTeamNumber,
			round2TeamNumberHold: a.secondRoundTeamNumber,
			round2SubstituteChecked: false,
			round2Flag: false,
			round2TabIndex: 8 - a.allianceNumber,
			round3TeamNumberRaw: "",
			round3TeamNumberHold: null,
			round3SubstituteChecked: false,
			round3TeamNumber: null,
			round3Enabled: false,
			round3Flag: false,
			showUndoSubstitution: false,
		});
	});
}

/** audience/get/GetAllianceSelectionData: alliances + remaining available teams for the wizard. */
export function getAllianceSelectionData(store: FmsStore): object {
	const state = store.getState();
	const alliances = state.alliances.map((a) => audienceAlliance(allianceByNumber(store, a.allianceNumber)));
	const picked = pickedTeams(store);
	const availableTeams = state.rankings
		.filter((r) => !picked.has(r.teamNumber))
		.map((r) =>
			withType(FMS_TYPE.QualRankingTeam, {
				rank: r.rank,
				teamNumber: r.teamNumber,
				isDeclined: r.isDeclined,
				pickStatus: r.pickStatus,
				inPotentialCaptainPosition: r.inPotentialCaptainPosition,
			}),
		);
	return withType(FMS_TYPE.AllianceSelectionData, {
		alliances,
		availableTeams,
		eventName: state.event.name,
		eventLocation: state.event.location,
		eventCode: state.event.code,
		tournamentType: state.event.tournamentType,
		allianceCount: state.bracket?.allianceCount ?? "EightAlliance",
		allianceSelectionType: "ThreeTeam",
	});
}

/** audience/get/GetQualificationRankData: the audience qualification-ranking board. */
export function getQualRankData(store: FmsStore): object {
	const state = store.getState();
	const teamRanks = state.rankings.map((r) => {
		const team = state.teams.find((t) => t.number === r.teamNumber);
		return withType(FMS_TYPE.QualRankTeamData, {
			rank: r.rank,
			teamAvatar: "",
			teamNumber: r.teamNumber,
			teamName: team?.name ?? `Team ${r.teamNumber}`,
			sort1: 0,
			sort2: 0,
			sort3: 0,
			sort4: 0,
			sort5: 0,
			sort6: 0,
			wins: 0,
			losses: 0,
			ties: 0,
		});
	});
	return withType(FMS_TYPE.QualRankData, {
		eventDescription: state.event.name,
		eventLocation: state.event.location,
		eventCode: state.event.code,
		seasonYear: state.event.season,
		tournamentType: state.event.tournamentType,
		teamRanks,
	});
}

/**
 * audience/get/GetPlayoffMatches: an ImmutableSortedDictionary keyed by match number (1-19) of
 * PlayoffMatchSpec. The `$type` of the dictionary itself is the first key.
 */
export function getPlayoffMatches(store: FmsStore): object {
	const out: Record<string, unknown> = { $type: FMS_TYPE.PlayoffMatchesDict };
	for (const slot of TEMPLATE) {
		out[String(slot.matchNumber)] = withType(FMS_TYPE.PlayoffMatchSpec, {
			matchNumber: slot.matchNumber,
			longName: `Match ${slot.matchNumber} (${slot.round})`,
			shortName: slot.shortName,
			useTiebreakers: true,
			redAlliance: slot.red,
			blueAlliance: slot.blue,
			state: "InitialScheduled",
		});
	}
	for (const f of FINALS) {
		out[String(f.matchNumber)] = withType(FMS_TYPE.PlayoffMatchSpec, {
			matchNumber: f.matchNumber,
			longName: f.longName,
			shortName: f.shortName,
			useTiebreakers: f.useTiebreakers,
			redAlliance: null,
			blueAlliance: null,
			state: f.state,
		});
	}
	return out;
}

/**
 * audience/get/GetPlayoffMatchGroups: an ImmutableDictionary keyed by group id (M1-M13, F) of
 * MatchGroupView. Round-1 groups carry their seeded alliances; later groups are empty.
 */
export function getPlayoffMatchGroups(store: FmsStore): object {
	const out: Record<string, unknown> = { $type: FMS_TYPE.PlayoffMatchGroupsDict };
	for (const slot of TEMPLATE) {
		out[slot.group] = withType(FMS_TYPE.MatchGroupView, {
			id: slot.group,
			type: "HeadToHeadMatchup",
			playoffLevel: slot.level,
			matchNumbers: [slot.matchNumber],
			isComplete: false,
			winnersNextRoundIsByeRound: slot.winnersNextRoundIsByeRound,
			redAlliance: slot.red,
			blueAlliance: slot.blue,
			matchesPlayed: 0,
			redWins: 0,
			blueWins: 0,
			bracket: slot.bracket,
			currentRankings: null,
		});
	}
	out.F = withType(FMS_TYPE.MatchGroupView, {
		id: "F",
		type: "HeadToHeadMatchup",
		playoffLevel: "Final",
		matchNumbers: [14, 15, 16, 17, 18, 19],
		isComplete: false,
		winnersNextRoundIsByeRound: false,
		redAlliance: null,
		blueAlliance: null,
		matchesPlayed: 0,
		redWins: 0,
		blueWins: 0,
		bracket: "Single",
		currentRankings: null,
	});
	return out;
}

function doubleElimMatch(store: FmsStore, slot: BracketSlot, isNext: boolean): object {
	return withType(FMS_TYPE.DoubleElimMatch, {
		matchNumber: slot.matchNumber,
		shortName: slot.shortName,
		longName: `Match ${slot.matchNumber} (${slot.round})`,
		isComplete: false,
		winningAllianceType: "None",
		winningAllianceNumber: 0,
		redAllianceNumber: slot.red,
		redAlliance: audienceAlliance(allianceByNumber(store, slot.red)),
		redAllianceScore: 0,
		blueAllianceNumber: slot.blue,
		blueAlliance: audienceAlliance(allianceByNumber(store, slot.blue)),
		blueAllianceScore: 0,
		isNextMatch: isNext,
	});
}

/**
 * audience_gs/get/GetBracketData: the full double-elim bracket the audience display renders, with
 * nested alliance objects, the keyed `doubleElimMatches` dictionary, the ordered list, and finals.
 */
export function getBracketData(store: FmsStore): object | null {
	const state = store.getState();
	if (!state.bracket) return null;
	const list = TEMPLATE.map((slot) => doubleElimMatch(store, slot, slot.matchNumber === 1));

	const doubleElimMatches: Record<string, unknown> = { $type: FMS_TYPE.BracketMatchesDict };
	for (let i = 0; i < TEMPLATE.length; i++) {
		const slot = TEMPLATE[i];
		if (slot) doubleElimMatches[String(slot.matchNumber)] = list[i];
	}

	const finals = withType(FMS_TYPE.DoubleElimMatch, {
		matchNumber: 14,
		shortName: null,
		longName: null,
		isComplete: false,
		winningAllianceType: "None",
		winningAllianceNumber: 0,
		redAllianceNumber: null,
		redAlliance: audienceAlliance(undefined),
		redAllianceScore: 0,
		blueAllianceNumber: null,
		blueAlliance: audienceAlliance(undefined),
		blueAllianceScore: 0,
		isNextMatch: false,
	});

	return withType(FMS_TYPE.AudienceBracket, {
		alliances: state.bracket.alliances.map((a) => audienceAlliance(a)),
		doubleElimMatches,
		doubleElimMatchesList: list,
		finals,
		currentLevel: state.bracket.currentLevel,
		allianceCount: state.bracket.allianceCount,
		tournamentType: state.event.tournamentType,
		season: state.event.season,
		eventCode: state.event.code,
		eventName: state.event.name,
		eventLocation: state.event.location,
	});
}

// #endregion
