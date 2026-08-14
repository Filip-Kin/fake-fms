/**
 * Project the fake-fms FmsStore into Cheesy Arena wire shapes. Pure, no side effects, so these can
 * be unit-tested against the captured fixtures in ca-docs/raw-captures. The FMS store is the single
 * source of truth; both the FMS SignalR/REST layer and this CA layer read the same state.
 *
 * Accuracy notes: the match/schedule/rankings/alliance projections aim to match real CA byte-for-byte
 * (flat Match, integer enums, PascalCase keys). The game-specific score projection (realtimeScore /
 * Result scores) maps fake-fms's 2026 point model onto CA's Hub/Tower/Fuel structs; it is structurally
 * correct but not a byte-for-byte reproduction of CA's internal scoring (documented risk R4).
 */
import type { MatchStateString, ScheduleEntry, StationState, TournamentLevel } from "shared";
import { STATION_KEYS, type StationKey } from "shared";
import type { Game2026Score } from "shared";
import { AUTO_SECONDS, teleopSeconds } from "../match/timing";
import type { FmsStore } from "../state/store";
import {
	CaMatchState,
	CaMatchStatus,
	CaMatchType,
	type CaAlliance,
	type CaAllianceScoreFields,
	type CaAllianceStation,
	type CaArenaStatus,
	type CaEventStatus,
	type CaMatch,
	type CaMatchLoad,
	type CaMatchResultWithSummary,
	type CaMatchTime,
	type CaMatchTiming,
	type CaMatchWithResult,
	type CaRanking,
	type CaRankingWithNickname,
	type CaRealtimeScore,
	type CaScore,
	type CaScorePosted,
	type CaScoreSummary,
	type CaStationKey,
	type CaTeam,
	CA_STATIONS,
} from "./types";

const ZERO_TIME = "0001-01-01T00:00:00Z";
const NUM_FUEL_GOAL = 100; // CA constant (live capture).
const TRANSITION_SECONDS = 3; // CA PauseDurationSec.

// StationKey (red1..blue3) <-> CA station key (R1..B3), same canonical order.
const STATION_PAIRS: [StationKey, CaStationKey][] = STATION_KEYS.map((k, i) => [k, CA_STATIONS[i] as CaStationKey]);

// #region enum / naming helpers

export function caMatchType(level: TournamentLevel): CaMatchType {
	switch (level) {
		case "Practice":
			return CaMatchType.Practice;
		case "Qualification":
			return CaMatchType.Qualification;
		case "Playoff":
			return CaMatchType.Playoff;
		default:
			return CaMatchType.Test;
	}
}

/**
 * FMS lifecycle state -> CA MatchState int. CA collapses the several FMS pre-match sub-states into
 * PreMatch(0); readiness is surfaced separately via CanStartMatch.
 */
export function caMatchState(ms: MatchStateString): CaMatchState {
	switch (ms) {
		case "GameSpecificData":
			return CaMatchState.StartMatch;
		case "MatchAuto":
			return CaMatchState.AutoPeriod;
		case "MatchTransition":
			return CaMatchState.PausePeriod;
		case "MatchTeleop":
			return CaMatchState.TeleopPeriod;
		case "WaitingForCommit":
		case "WaitingForPostResults":
		case "MatchCancelled":
			return CaMatchState.PostMatch;
		default:
			return CaMatchState.PreMatch;
	}
}

/** True only when the field is armed (FMS "WaitingForMatchStart" == CA MATCH_READY). */
export function caCanStartMatch(ms: MatchStateString): boolean {
	return ms === "WaitingForMatchStart";
}

export const CA_POST_TIMEOUT_SEC = 4; // CA's PostTimeout dwell.

/** Timeout elapsed seconds, or null when no CA timeout is running. */
export function caTimeoutElapsed(store: FmsStore): number | null {
	const t = store.getState().caTimeout;
	if (!t) return null;
	return Math.max(0, Math.floor((Date.now() - t.startedAtMs) / 1000));
}

/** The effective CA MatchState int, accounting for a running CA timeout (TimeoutActive/PostTimeout). */
export function caEffectiveMatchState(store: FmsStore): CaMatchState {
	const t = store.getState().caTimeout;
	if (t) return t.phase === "post" ? CaMatchState.PostTimeout : CaMatchState.TimeoutActive;
	return caMatchState(store.getState().current.matchState);
}

const LEVEL_ID_OFFSET: Record<TournamentLevel, number> = {
	None: 0,
	Practice: 1000,
	Qualification: 2000,
	Playoff: 3000,
};

/** Stable synthetic CA match Id, unique across levels (CA uses a DB row id). */
export function caMatchId(level: TournamentLevel, matchNumber: number): number {
	return LEVEL_ID_OFFSET[level] + matchNumber;
}

export function caShortName(level: TournamentLevel, matchNumber: number): string {
	switch (level) {
		case "Practice":
			return `P${matchNumber}`;
		case "Qualification":
			return `Q${matchNumber}`;
		case "Playoff":
			return matchNumber >= 14 ? `F${matchNumber - 13}` : `M${matchNumber}`;
		default:
			return "T";
	}
}

function tbaCompLevel(level: TournamentLevel, matchNumber: number): string {
	switch (level) {
		case "Practice":
			return "pm";
		case "Qualification":
			return "qm";
		case "Playoff":
			return matchNumber >= 14 ? "f" : "sf";
		default:
			return "";
	}
}

// #endregion

// #region match / schedule projection

function matchStatusFor(entry: ScheduleEntry): CaMatchStatus {
	if (entry.status !== "Played") return CaMatchStatus.MatchScheduled;
	const r = entry.finalScoreRed ?? 0;
	const b = entry.finalScoreBlue ?? 0;
	if (r > b) return CaMatchStatus.RedWonMatch;
	if (b > r) return CaMatchStatus.BlueWonMatch;
	return CaMatchStatus.TieMatch;
}

/** Project one schedule entry to a CA model.Match (the struct shared by REST + matchLoad). */
export function caMatch(entry: ScheduleEntry): CaMatch {
	const played = entry.status === "Played";
	return {
		Id: caMatchId(entry.level, entry.matchNumber),
		Type: caMatchType(entry.level),
		TypeOrder: entry.matchNumber,
		Time: entry.scheduledStartTime,
		LongName: entry.description || `${entry.level} ${entry.matchNumber}`,
		ShortName: caShortName(entry.level, entry.matchNumber),
		NameDetail: "",
		PlayoffMatchGroupId: entry.level === "Playoff" ? caShortName(entry.level, entry.matchNumber) : "",
		PlayoffRedAlliance: entry.redAllianceNumber ?? 0,
		PlayoffBlueAlliance: entry.blueAllianceNumber ?? 0,
		Red1: entry.red[0],
		Red1IsSurrogate: false,
		Red2: entry.red[1],
		Red2IsSurrogate: false,
		Red3: entry.red[2],
		Red3IsSurrogate: false,
		Blue1: entry.blue[0],
		Blue1IsSurrogate: false,
		Blue2: entry.blue[1],
		Blue2IsSurrogate: false,
		Blue3: entry.blue[2],
		Blue3IsSurrogate: false,
		StartedAt: entry.actualStartTime ?? ZERO_TIME,
		ScoreCommittedAt: played ? (entry.actualStartTime ?? entry.scheduledStartTime) : ZERO_TIME,
		FieldReadyAt: ZERO_TIME,
		Status: matchStatusFor(entry),
		UseTiebreakCriteria: entry.level === "Playoff",
		TbaMatchKey: {
			CompLevel: tbaCompLevel(entry.level, entry.matchNumber),
			SetNumber: entry.level === "Playoff" ? entry.matchNumber : 0,
			MatchNumber: entry.matchNumber,
		},
	};
}

const REST_LEVELS: Record<string, TournamentLevel> = {
	test: "None",
	practice: "Practice",
	qualification: "Qualification",
	playoff: "Playoff",
};

/** Resolve a /api/matches/{type} path token to a level, or null if the token is invalid (CA -> 500). */
export function caLevelForApiType(type: string): TournamentLevel | null {
	return REST_LEVELS[type.toLowerCase()] ?? null;
}

/** Build the /api/matches/{type} array (flat Match + Result), excluding no matches (CA hides Status 1). */
export function caMatchesForLevel(store: FmsStore, level: TournamentLevel): CaMatchWithResult[] {
	const state = store.getState();
	return state.schedule
		.filter((e) => e.level === level)
		.sort((a, b) => a.matchNumber - b.matchNumber)
		.map((entry) => {
			const match = caMatch(entry);
			const result: CaMatchResultWithSummary | null = entry.status === "Played" ? caMatchResult(store, entry) : null;
			return { ...match, Result: result };
		});
}

function caMatchResult(store: FmsStore, entry: ScheduleEntry): CaMatchResultWithSummary {
	// The committed per-alliance score isn't retained per-match in the FMS store beyond totals, so
	// project a Score/summary from the final totals. For the currently-loaded match the live score
	// is used; otherwise a totals-only summary is emitted (documented approximation).
	const state = store.getState();
	const isCurrent = state.current.level === entry.level && state.current.matchNumber === entry.matchNumber;
	const red = isCurrent ? caScore(store, "Red") : caScoreFromTotal(entry.finalScoreRed ?? 0);
	const blue = isCurrent ? caScore(store, "Blue") : caScoreFromTotal(entry.finalScoreBlue ?? 0);
	return {
		Id: caMatchId(entry.level, entry.matchNumber),
		MatchId: caMatchId(entry.level, entry.matchNumber),
		MatchType: caMatchType(entry.level),
		PlayNumber: entry.playNumber,
		RedScore: red.score,
		BlueScore: blue.score,
		RedCards: {},
		BlueCards: {},
		RedSummary: red.summary,
		BlueSummary: blue.summary,
	};
}

// #endregion

// #region station / arenaStatus projection

function caTeam(store: FmsStore, teamNumber: number): CaTeam | null {
	if (!teamNumber) return null;
	const t = store.getState().teams.find((x) => x.number === teamNumber);
	return {
		Id: teamNumber,
		Name: t?.name ?? "",
		Nickname: t?.name ?? "",
		City: "",
		StateProv: "",
		Country: "",
		SchoolName: "",
		RookieYear: 0,
		RobotName: "",
		Accomplishments: "",
		WpaKey: t?.wpaKey ?? "",
		YellowCard: store.getState().cards[teamNumber] === "Yellow",
		HasConnected: false,
		FtaNotes: "",
	};
}

/** Project one fake-fms StationState to a CA AllianceStation. */
export function caAllianceStation(
	store: FmsStore,
	s: StationState,
	ctx: { isEnabled: boolean; isAuto: boolean },
): CaAllianceStation {
	const connected = s.ds !== "red"; // DS present at all
	const enabled = ctx.isEnabled && !s.bypassed && !s.estop;
	const robotLinked = s.code === "green";
	const dsConn = connected
		? {
				TeamId: s.teamNumber,
				AllianceStation: `${s.alliance}${s.station}`,
				Auto: ctx.isAuto,
				Enabled: enabled,
				EStop: s.estop,
				AStop: s.astop,
				DsLinked: s.ds === "green" || s.ds === "greenX" || s.ds === "waiting" || s.ds === "move",
				RadioLinked: s.radio === "green",
				RioLinked: s.rio !== "red",
				RobotLinked: robotLinked,
				BatteryVoltage: robotLinked ? s.battery : 0,
				DsRobotTripTimeMs: robotLinked ? s.ping : 0,
				MissedPacketCount: 0,
				DsReportedStatusValid: robotLinked,
				DsReportedAuto: ctx.isAuto,
				DsReportedTeleop: !ctx.isAuto && enabled,
				DsReportedDisabled: !enabled,
				DsReportedEnabled: enabled,
				SecondsSinceLastRobotLink: robotLinked ? 0 : 100,
				SentGameData: "",
				WrongStation: s.ds === "move" ? `${s.alliance}${s.station}` : "",
			}
		: null;
	const radioToAp = s.radio !== "red";
	return {
		DsConn: dsConn,
		TeamMatchLog: null,
		Ethernet: connected,
		AStop: s.astop,
		EStop: s.estop,
		Bypass: s.bypassed,
		Team: caTeam(store, s.teamNumber),
		WifiStatus: {
			TeamId: s.teamNumber,
			RadioLinked: s.radio === "green",
			MBits: robotLinked ? 1.2 : 0,
			RxRate: robotLinked ? 550.6 : 0,
			TxRate: robotLinked ? 550.6 : 0,
			SignalNoiseRatio: robotLinked ? 45 : 0,
			ConnectionQuality: radioToAp ? 3 : 0,
		},
		GameData: "",
	};
}

export function caArenaStatus(store: FmsStore): CaArenaStatus {
	const state = store.getState();
	const ctx = store.frameContext();
	const ms = state.current.matchState;
	const stations: Record<string, CaAllianceStation> = {};
	for (const [fmsKey, caKey] of STATION_PAIRS) {
		stations[caKey] = caAllianceStation(store, state.stations[fmsKey], ctx);
	}
	// We emulate a no-PLC / no-managed-network Cheesy Arena field (the common offseason/scrimmage
	// config, and exactly the reference instance captured in ca-docs). Real CA in that config reports
	// component status "UNKNOWN", PlcIsHealthy false, FieldEStop true (the raw e-stop input reads high
	// when no PLC is wired; it's ignored for match-start because checkCanStartMatch only consults the
	// PLC when one is enabled), and GetArmorBlockStatuses() always returns its four keys, all false.
	return {
		MatchId: caMatchId(state.current.level, state.current.matchNumber),
		AllianceStations: stations,
		MatchState: caEffectiveMatchState(store),
		CanStartMatch: state.caTimeout ? false : caCanStartMatch(ms),
		AccessPointStatus: "UNKNOWN",
		SwitchStatus: "UNKNOWN",
		RedSCCStatus: "UNKNOWN",
		BlueSCCStatus: "UNKNOWN",
		PlcIsHealthy: false,
		FieldEStop: true,
		PlcArmorBlockStatuses: { BlueDs: false, BlueIoLink: false, RedDs: false, RedIoLink: false },
	};
}

// #endregion

// #region matchLoad / matchTime / matchTiming / eventStatus

export function currentEntry(store: FmsStore): ScheduleEntry | undefined {
	const { current, schedule } = store.getState();
	return schedule.find((e) => e.matchNumber === current.matchNumber && e.level === current.level);
}

/** playoff.Matchup for the loaded match (null unless a playoff match is loaded). */
export function caMatchup(store: FmsStore): unknown | null {
	const state = store.getState();
	if (state.current.level !== "Playoff") return null;
	const entry = currentEntry(store);
	if (!entry) return null;
	const n = state.current.matchNumber;
	const pm = state.playoffMatches[n];
	// Finals (14-16, overtime 17-19) are a best-of-3 series; bracket rounds are single matches.
	const isFinals = n >= 14;
	const finalsWins = (side: "Red" | "Blue"): number => {
		if (!isFinals) return 0;
		return Object.values(state.playoffMatches).filter(
			(m) => m.matchNumber >= 14 && m.matchNumber <= 19 && m.complete && m.winner === side,
		).length;
	};
	return {
		NumWinsToAdvance: isFinals ? 2 : 1,
		RedAllianceId: entry.redAllianceNumber ?? 0,
		BlueAllianceId: entry.blueAllianceNumber ?? 0,
		RedAllianceWins: finalsWins("Red"),
		BlueAllianceWins: finalsWins("Blue"),
		NumMatchesPlayed: pm?.complete ? 1 : 0,
	};
}

/** Alliance members not in the current playoff match's on-field three (CA RedOffFieldTeams). */
export function caOffFieldTeams(store: FmsStore, side: "red" | "blue"): CaTeam[] {
	const state = store.getState();
	if (state.current.level !== "Playoff") return [];
	const entry = currentEntry(store);
	if (!entry) return [];
	const allianceNum = side === "red" ? entry.redAllianceNumber : entry.blueAllianceNumber;
	if (!allianceNum) return [];
	const alliance = state.alliances.find((a) => a.allianceNumber === allianceNum);
	if (!alliance) return [];
	const onField = side === "red" ? entry.red : entry.blue;
	const members = [
		alliance.captainTeamNumber,
		alliance.firstRoundTeamNumber,
		alliance.secondRoundTeamNumber,
		alliance.alternateTeamNumber,
	]
		.map((x) => x ?? 0)
		.filter((x) => x > 0);
	return members
		.filter((n) => !onField.includes(n))
		.map((n) => caTeam(store, n))
		.filter((t): t is CaTeam => t !== null);
}

export function caMatchLoad(store: FmsStore): CaMatchLoad {
	const state = store.getState();
	const entry = currentEntry(store);
	const match: CaMatch = entry
		? caMatch(entry)
		: {
				...caMatch({
					fmsMatchId: "",
					matchNumber: state.current.matchNumber,
					playNumber: state.current.playNumber,
					level: state.current.level,
					description: "",
					scheduledStartTime: ZERO_TIME,
					actualStartTime: null,
					red: [0, 0, 0],
					blue: [0, 0, 0],
					status: "Pending",
					finalScoreRed: null,
					finalScoreBlue: null,
					redAllianceNumber: null,
					blueAllianceNumber: null,
				}),
			};
	const teams: Record<string, CaTeam | null> = {};
	const rankings: Record<string, number> = {};
	const nums = entry ? [...entry.red, ...entry.blue] : [0, 0, 0, 0, 0, 0];
	for (let i = 0; i < STATION_PAIRS.length; i++) {
		const caKey = STATION_PAIRS[i]?.[1] as CaStationKey;
		const num = nums[i] ?? 0;
		teams[caKey] = caTeam(store, num);
		const rank = state.rankings.find((r) => r.teamNumber === num)?.rank;
		if (num > 0 && rank) rankings[String(num)] = rank;
	}
	return {
		Match: match,
		AllowSubstitution: state.current.level !== "Qualification",
		IsReplay: state.current.playNumber > 1,
		Teams: teams,
		Rankings: rankings,
		Matchup: caMatchup(store),
		RedOffFieldTeams: caOffFieldTeams(store, "red"),
		BlueOffFieldTeams: caOffFieldTeams(store, "blue"),
		BreakDescription: state.caTimeout?.description ?? "",
		BreakNextMatchName: state.caTimeout?.nextMatchName ?? "",
	};
}

/** CA MatchTimeSec: seconds since match start while running; the timeout clock during a timeout; else 0. */
export function caMatchTimeSec(store: FmsStore): number {
	const state = store.getState();
	const timeout = caTimeoutElapsed(store);
	if (timeout !== null) {
		// TimeoutActive counts up to the duration; PostTimeout resets to 0 (like a match's PostMatch).
		return state.caTimeout?.phase === "post" ? 0 : Math.min(timeout, state.caTimeout?.durationSec ?? 0);
	}
	const cms = caMatchState(state.current.matchState);
	if (cms === CaMatchState.AutoPeriod || cms === CaMatchState.PausePeriod || cms === CaMatchState.TeleopPeriod) {
		const entry = currentEntry(store);
		if (entry?.actualStartTime) {
			const elapsed = Math.floor((Date.now() - Date.parse(entry.actualStartTime)) / 1000);
			const teleopEnd = AUTO_SECONDS + TRANSITION_SECONDS + teleopSeconds(state.gameConfig);
			return Math.max(0, Math.min(elapsed, teleopEnd));
		}
	}
	return 0;
}

export function caMatchTime(store: FmsStore): CaMatchTime {
	return { MatchState: caEffectiveMatchState(store), MatchTimeSec: caMatchTimeSec(store) };
}

export function caMatchTiming(store: FmsStore): CaMatchTiming {
	const state = store.getState();
	const cfg = state.gameConfig;
	return {
		AutoDurationSec: AUTO_SECONDS,
		PauseDurationSec: TRANSITION_SECONDS,
		TransitionShiftDurationSec: cfg.coopShiftLengthSeconds,
		ShiftDurationSec: cfg.shift1LengthSeconds,
		EndgameDurationSec: cfg.endgameLengthSeconds,
		TimeoutDurationSec: state.caTimeout?.durationSec ?? 0,
	};
}

export function caEventStatus(store: FmsStore): CaEventStatus {
	const state = store.getState();
	// CA emits an empty EarlyLateMessage for a Test match or when no real match is loaded, and the
	// verbose on-schedule string otherwise (we don't model ahead/behind).
	const hasRealMatch = state.current.level !== "None" && currentEntry(store) !== undefined;
	return {
		CycleTime: state.caCycleTime ?? "",
		EarlyLateMessage: hasRealMatch ? "Event is running on schedule" : "",
	};
}

// #endregion

// #region score projection (game-specific; approximate, see file header)

function towerLevel(points: number, perLevel: number): number {
	if (points <= 0) return 0;
	return Math.min(3, Math.round(points / perLevel));
}

export function caScoreFromGame(g: Game2026Score): { score: CaScore; summary: CaScoreSummary } {
	const shiftCounts = [
		g.autoFuelPoints,
		g.coopFuelPoints,
		g.shift1FuelPoints,
		g.shift2FuelPoints,
		g.shift3FuelPoints,
		g.shift4FuelPoints,
		g.endgameFuelPoints,
		0,
	];
	const score: CaScore = {
		AutoTowerStatuses: [towerLevel(g.autoClimbPoints, 5), 0, 0],
		Hub: { WonAuto: g.advantageAchieved, ShiftCounts: shiftCounts },
		EndgameTowerStatuses: [towerLevel(g.endgameClimbPoints, 10), 0, 0],
		// fake-fms tracks foul points as a scalar, not individual game.Foul objects, so this is always
		// null (a nil slice on the wire) exactly as CA emits when no per-foul records exist.
		Fouls: null,
		PlayoffDq: false,
	};
	const bonuses = [g.energizedAchieved, g.superchargedAchieved, g.traversalAchieved].filter(Boolean).length;
	const summary: CaScoreSummary = {
		AutoFuelPoints: g.autoFuelPoints,
		AutoTowerPoints: g.autoClimbPoints,
		TeleopFuelPoints: g.teleopFuelPoints,
		TeleopTowerPoints: g.endgameClimbPoints,
		NumFuel: g.totalFuelCount,
		NumFuelPostMatch: g.totalFuelCount,
		NumFuelGoal: NUM_FUEL_GOAL,
		MatchPoints: g.autoPoints + g.teleopPoints,
		PostMatchPoints: 0,
		FoulPoints: g.foulPoints,
		Score: g.totalPoints,
		PlayoffDq: false,
		EnergizedBonusRankingPoint: g.energizedAchieved,
		SuperchargedBonusRankingPoint: g.superchargedAchieved,
		TraversalBonusRankingPoint: g.traversalAchieved,
		BonusRankingPoints: bonuses,
		NumOpponentMajorFouls: Math.round((g.majorFoulPoints ?? 0) / 6),
	};
	return { score, summary };
}

function caScore(store: FmsStore, alliance: "Red" | "Blue"): { score: CaScore; summary: CaScoreSummary } {
	const raw = alliance === "Red" ? store.getState().score.red : store.getState().score.blue;
	const g = store.getGameModule().recompute(raw) as Game2026Score;
	return caScoreFromGame(g);
}

function caScoreFromTotal(total: number): { score: CaScore; summary: CaScoreSummary } {
	const empty = caScoreFromGame({ ...(store0() as Game2026Score) });
	empty.summary.Score = total;
	empty.summary.MatchPoints = total;
	return empty;
}

// A zeroed Game2026Score for totals-only projection (avoids importing the module instance here).
function store0(): Partial<Game2026Score> {
	return {
		autoFuelPoints: 0,
		coopFuelPoints: 0,
		shift1FuelPoints: 0,
		shift2FuelPoints: 0,
		shift3FuelPoints: 0,
		shift4FuelPoints: 0,
		endgameFuelPoints: 0,
		autoClimbPoints: 0,
		endgameClimbPoints: 0,
		foulPoints: 0,
		majorFoulPoints: 0,
		teleopFuelPoints: 0,
		totalFuelCount: 0,
		autoPoints: 0,
		teleopPoints: 0,
		totalPoints: 0,
		energizedAchieved: false,
		superchargedAchieved: false,
		traversalAchieved: false,
		advantageAchieved: false,
	};
}

/**
 * CA Hub active-shift timing for the audience "hub active" indicator, reproducing
 * game/hub.go GetActiveShiftTiming: during the current shift, if this alliance's hub is active
 * (Auto/Transition/Endgame active for both; odd shifts 1&3 active for the auto-loser, even shifts
 * 2&4 for the auto-winner), return {remaining-in-shift, shift-duration}; if not active, {0, duration};
 * outside any shift, {0, 0}.
 */
export function caActiveShiftTiming(store: FmsStore, wonAuto: boolean): { remaining: number; duration: number } {
	const state = store.getState();
	const elapsed = caMatchTimeSec(store);
	const cms = caMatchState(state.current.matchState);
	if (cms !== CaMatchState.AutoPeriod && cms !== CaMatchState.PausePeriod && cms !== CaMatchState.TeleopPeriod) {
		return { remaining: 0, duration: 0 };
	}
	const cfg = state.gameConfig;
	if (elapsed < AUTO_SECONDS) {
		return { remaining: AUTO_SECONDS - elapsed, duration: AUTO_SECONDS }; // Auto: active for both
	}
	const te = elapsed - (AUTO_SECONDS + TRANSITION_SECONDS); // teleop-elapsed
	if (te < 0) return { remaining: 0, duration: 0 }; // pause between auto and teleop
	// Shift boundaries within teleop.
	const bounds = [
		{ name: "coop", end: cfg.coopShiftLengthSeconds, dur: cfg.coopShiftLengthSeconds, active: true },
		{ name: "s1", dur: cfg.shift1LengthSeconds, active: !wonAuto },
		{ name: "s2", dur: cfg.shift2LengthSeconds, active: wonAuto },
		{ name: "s3", dur: cfg.shift3LengthSeconds, active: !wonAuto },
		{ name: "s4", dur: cfg.shift4LengthSeconds, active: wonAuto },
		{ name: "endgame", dur: cfg.endgameLengthSeconds, active: true },
	] as { name: string; dur: number; active: boolean }[];
	let acc = 0;
	for (const b of bounds) {
		if (te < acc + b.dur) {
			const remaining = acc + b.dur - te;
			return { remaining: b.active ? Math.ceil(remaining) : 0, duration: b.dur };
		}
		acc += b.dur;
	}
	return { remaining: 0, duration: 0 };
}

/** Current shift index during a match (0 Auto, 1 Coop/Transition, 2-5 Shift1-4, 6 Endgame), else -1. */
export function caCurrentShift(store: FmsStore): number {
	const state = store.getState();
	const cms = caMatchState(state.current.matchState);
	if (cms !== CaMatchState.AutoPeriod && cms !== CaMatchState.PausePeriod && cms !== CaMatchState.TeleopPeriod)
		return -1;
	const elapsed = caMatchTimeSec(store);
	if (elapsed < AUTO_SECONDS) return 0;
	const te = elapsed - (AUTO_SECONDS + TRANSITION_SECONDS);
	if (te < 0) return 1;
	const cfg = state.gameConfig;
	const durs = [
		cfg.coopShiftLengthSeconds,
		cfg.shift1LengthSeconds,
		cfg.shift2LengthSeconds,
		cfg.shift3LengthSeconds,
		cfg.shift4LengthSeconds,
		cfg.endgameLengthSeconds,
	];
	let acc = 0;
	for (let i = 0; i < durs.length; i++) {
		if (te < acc + (durs[i] as number)) return 1 + i;
		acc += durs[i] as number;
	}
	return -1;
}

function allianceScoreFields(store: FmsStore, alliance: "Red" | "Blue"): CaAllianceScoreFields {
	const { score, summary } = caScore(store, alliance);
	const timing = caActiveShiftTiming(store, score.Hub.WonAuto);
	return {
		Score: score,
		ScoreSummary: summary,
		ActiveRemainingSec: timing.remaining,
		ActiveDurationSec: timing.duration,
	};
}

/**
 * The CA audienceDisplayMode string, driven by the match lifecycle + the FMS video-switch option so
 * the audience feed follows CA's real screen sequence: intro (preview) -> match (running) -> blank
 * (match-end dwell) -> score (posted), plus operator screens (allianceSelection/bracket/timeout).
 * CA's ten modes: blank, intro, match, score, sponsor, allianceSelection, timeout, bracket, logo, logoLuma.
 */
export function caAudienceMode(store: FmsStore): string {
	const state = store.getState();
	const ms = state.current.matchState;
	if (ms === "GameSpecificData" || ms === "MatchAuto" || ms === "MatchTransition" || ms === "MatchTeleop")
		return "match";
	if (ms === "WaitingForPostResults") return "score";
	if (ms === "WaitingForCommit") return "blank"; // match ended, awaiting scores (CA blanks after dwell)
	if (ms === "MatchCancelled") return "blank";
	switch (state.event.videoSwitchOption) {
		case "MatchPreview":
			return "intro";
		case "VideoAndScore":
		case "VideoOnly":
			return "match";
		case "MatchResult":
			return "score";
		case "Alliance":
		case "AllianceHybrid":
		case "AllianceFullscreen":
			return "allianceSelection";
		case "Bracket":
			return "bracket";
		case "Timeout":
			return "timeout";
		case "Message":
			return "logo";
		default:
			return "blank";
	}
}

export function caRealtimeScore(store: FmsStore): CaRealtimeScore {
	return {
		Red: allianceScoreFields(store, "Red"),
		Blue: allianceScoreFields(store, "Blue"),
		RedCards: {},
		BlueCards: {},
		MatchState: caMatchState(store.getState().current.matchState),
	};
}

// #endregion

// #region rankings / alliances / scorePosted

function deterministicRandom(teamNumber: number): number {
	// Stable pseudo-random in [0,1) so /api/rankings has a Random field without real RNG.
	const x = Math.sin(teamNumber * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

export function caRanking(store: FmsStore, teamNumber: number): CaRanking | null {
	const r = store.getState().rankings.find((x) => x.teamNumber === teamNumber);
	if (!r) return null;
	return {
		TeamId: r.teamNumber,
		Rank: r.rank,
		PreviousRank: 0,
		RankingPoints: Math.round(r.rankingScore * r.matchesPlayed),
		MatchPoints: r.sort2,
		AutoFuelPoints: r.sort3,
		TowerPoints: r.sort4,
		Random: deterministicRandom(r.teamNumber),
		Wins: r.wins,
		Losses: r.losses,
		Ties: r.ties,
		Disqualifications: 0,
		Played: r.matchesPlayed,
	};
}

export function caRankings(store: FmsStore): { Rankings: CaRankingWithNickname[]; HighestPlayedMatch: string } {
	const state = store.getState();
	const teams = new Map(state.teams.map((t) => [t.number, t.name] as const));
	const rankings = [...state.rankings]
		.sort((a, b) => a.rank - b.rank)
		.map((r) => ({ ...(caRanking(store, r.teamNumber) as CaRanking), Nickname: teams.get(r.teamNumber) ?? "" }));
	const playedQuals = state.schedule
		.filter((e) => e.level === "Qualification" && e.status === "Played")
		.sort((a, b) => a.matchNumber - b.matchNumber);
	const last = playedQuals[playedQuals.length - 1];
	return { Rankings: rankings, HighestPlayedMatch: last ? caShortName("Qualification", last.matchNumber) : "" };
}

export function caAlliances(store: FmsStore): CaAlliance[] {
	return store
		.getState()
		.alliances.filter((a) => (a.captainTeamNumber ?? 0) > 0)
		.map((a) => {
			const ids = [a.captainTeamNumber, a.firstRoundTeamNumber, a.secondRoundTeamNumber, a.alternateTeamNumber]
				.map((n) => n ?? 0)
				.filter((n) => n > 0);
			// CA finalize lineup: first pick left, captain middle, second pick right.
			const lineup: [number, number, number] = [
				a.firstRoundTeamNumber ?? 0,
				a.captainTeamNumber ?? 0,
				a.secondRoundTeamNumber ?? 0,
			];
			return { Id: a.allianceNumber, TeamIds: ids, Lineup: lineup };
		});
}

/** scorePosted payload for the currently loaded (just-committed) match. */
export function caScorePosted(store: FmsStore): CaScorePosted {
	const state = store.getState();
	const entry = currentEntry(store);
	const match = entry ? caMatch(entry) : caMatchLoad(store).Match;
	const red = caScore(store, "Red");
	const blue = caScore(store, "Blue");
	const redWon = match.Status === CaMatchStatus.RedWonMatch;
	const blueWon = match.Status === CaMatchStatus.BlueWonMatch;
	const redRankings: Record<string, CaRanking | null> = {};
	const blueRankings: Record<string, CaRanking | null> = {};
	if (entry) {
		for (const n of entry.red) redRankings[String(n)] = caRanking(store, n);
		for (const n of entry.blue) blueRankings[String(n)] = caRanking(store, n);
	}
	return {
		Match: match,
		RedScoreSummary: red.summary,
		BlueScoreSummary: blue.summary,
		RedRankingPoints: redWon ? 3 : match.Status === CaMatchStatus.TieMatch ? 1 : 0,
		BlueRankingPoints: blueWon ? 3 : match.Status === CaMatchStatus.TieMatch ? 1 : 0,
		RedFouls: null,
		BlueFouls: null,
		RulesViolated: {},
		RedCards: {},
		BlueCards: {},
		RedRankings: redRankings,
		BlueRankings: blueRankings,
		RedOffFieldTeamIds: [],
		BlueOffFieldTeamIds: [],
		RedWon: redWon,
		BlueWon: blueWon,
		TiebreakReason: "",
		RedWins: 0,
		BlueWins: 0,
		RedDestination: "",
		BlueDestination: "",
	};
}

// #endregion
