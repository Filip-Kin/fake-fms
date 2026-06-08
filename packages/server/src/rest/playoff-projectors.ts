import type { AudienceBracketAlliance } from "shared";
import type { FmsStore } from "../state/store";
import { FINALS, TEMPLATE } from "../match/playoff";
import { FMS_TYPE, withType } from "./fms-types";

/**
 * Playoff + alliance-selection projectors. These mirror the heavy structured endpoints the real
 * FMS serves for the audience display (`GetAllAlliances`, `GetAllianceSelectionData`,
 * `GetQualificationRankData`, `GetPlayoffMatches`, `GetPlayoffMatchGroups`, `GetBracketData`).
 *
 * Bracket topology + routing come from `../match/playoff`; per-match alliances/scores/winner come
 * from live `state.playoffMatches` (which the store advances as playoff matches commit). Alliance
 * rosters + rankings come from the store. Field names, `$type` discriminators, and the bracket
 * topology are taken verbatim from the `fms-capture/` ground-truth capture (event mibat2).
 */

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
	const fourTeam = state.allianceSelectionType === "FourTeam";
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
			round3TeamNumberRaw: fourTeam ? raw(a.alternateTeamNumber) : "",
			round3TeamNumberHold: fourTeam ? a.alternateTeamNumber : null,
			round3SubstituteChecked: false,
			round3TeamNumber: fourTeam ? a.alternateTeamNumber : null,
			round3Enabled: fourTeam,
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
		allianceSelectionType: state.allianceSelectionType,
	});
}

/** audience/get/GetQualRankings: the alliance-selection ranking list (5 wire fields only). */
export function getQualRankings(store: FmsStore): object[] {
	return store.getState().rankings.map((r) =>
		withType(FMS_TYPE.QualRankingTeam, {
			rank: r.rank,
			teamNumber: r.teamNumber,
			isDeclined: r.isDeclined,
			pickStatus: r.pickStatus,
			inPotentialCaptainPosition: r.inPotentialCaptainPosition,
		}),
	);
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
			sort1: r.rankingScore,
			sort2: r.sort2,
			sort3: r.sort3,
			sort4: r.sort4,
			sort5: r.sort5,
			sort6: r.sort6,
			wins: r.wins,
			losses: r.losses,
			ties: r.ties,
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
	const matches = store.getState().playoffMatches;
	const out: Record<string, unknown> = { $type: FMS_TYPE.PlayoffMatchesDict };
	for (const slot of TEMPLATE) {
		const m = matches[slot.matchNumber];
		out[String(slot.matchNumber)] = withType(FMS_TYPE.PlayoffMatchSpec, {
			matchNumber: slot.matchNumber,
			longName: `Match ${slot.matchNumber} (${slot.round})`,
			shortName: slot.shortName,
			useTiebreakers: true,
			redAlliance: m?.red ?? null,
			blueAlliance: m?.blue ?? null,
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
	const matches = store.getState().playoffMatches;
	const out: Record<string, unknown> = { $type: FMS_TYPE.PlayoffMatchGroupsDict };
	for (const slot of TEMPLATE) {
		const m = matches[slot.matchNumber];
		const complete = m?.complete ?? false;
		out[slot.group] = withType(FMS_TYPE.MatchGroupView, {
			id: slot.group,
			type: "HeadToHeadMatchup",
			playoffLevel: slot.level,
			matchNumbers: [slot.matchNumber],
			isComplete: complete,
			winnersNextRoundIsByeRound: slot.winnersNextRoundIsByeRound,
			redAlliance: m?.red ?? null,
			blueAlliance: m?.blue ?? null,
			matchesPlayed: complete ? 1 : 0,
			redWins: m?.winner === "Red" ? 1 : 0,
			blueWins: m?.winner === "Blue" ? 1 : 0,
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

function doubleElimMatch(
	store: FmsStore,
	matchNumber: number,
	shortName: string | null,
	longName: string | null,
	isNext: boolean,
): object {
	const m = store.getState().playoffMatches[matchNumber];
	const red = m?.red ?? null;
	const blue = m?.blue ?? null;
	const winner = m?.winner ?? "None";
	const winningAllianceNumber = winner === "Red" ? (red ?? 0) : winner === "Blue" ? (blue ?? 0) : 0;
	return withType(FMS_TYPE.DoubleElimMatch, {
		matchNumber,
		shortName,
		longName,
		isComplete: m?.complete ?? false,
		winningAllianceType: winner,
		winningAllianceNumber,
		redAllianceNumber: red,
		redAlliance: audienceAlliance(allianceByNumber(store, red)),
		redAllianceScore: m?.redScore ?? 0,
		blueAllianceNumber: blue,
		blueAlliance: audienceAlliance(allianceByNumber(store, blue)),
		blueAllianceScore: m?.blueScore ?? 0,
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
	// The "next" match is the lowest-numbered bracket match not yet complete.
	const nextMatch = TEMPLATE.find((s) => !state.playoffMatches[s.matchNumber]?.complete)?.matchNumber ?? 0;
	const list = TEMPLATE.map((slot) =>
		doubleElimMatch(store, slot.matchNumber, slot.shortName, `Match ${slot.matchNumber} (${slot.round})`, slot.matchNumber === nextMatch),
	);

	const doubleElimMatches: Record<string, unknown> = { $type: FMS_TYPE.BracketMatchesDict };
	for (let i = 0; i < TEMPLATE.length; i++) {
		const slot = TEMPLATE[i];
		if (slot) doubleElimMatches[String(slot.matchNumber)] = list[i];
	}

	const finals = doubleElimMatch(store, 14, null, null, false);

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
