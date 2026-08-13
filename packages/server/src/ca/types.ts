/**
 * Cheesy Arena (Team254) wire types, transcribed from the CA source at rev 5b91a8a (2026 "Hub"
 * game) and cross-checked against live captures. CA marshals Go structs with `encoding/json` and
 * NO json tags, so every JSON key here is the exact PascalCase Go field name, and enums serialise
 * as raw integers. The only json-tagged object is the websocket envelope `{type,data}`.
 *
 * See ca-docs/cheesy-arena-api-reference.md for provenance of each field (LIVE vs SRC).
 */

// #region enums (serialise as raw ints)

export enum CaMatchState {
	PreMatch = 0,
	StartMatch = 1,
	AutoPeriod = 2,
	PausePeriod = 3,
	TeleopPeriod = 4,
	PostMatch = 5,
	TimeoutActive = 6,
	PostTimeout = 7,
}

export enum CaMatchType {
	Test = 0,
	Practice = 1,
	Qualification = 2,
	Playoff = 3,
}

export enum CaMatchStatus {
	MatchScheduled = 0,
	MatchHidden = 1,
	RedWonMatch = 2,
	BlueWonMatch = 3,
	TieMatch = 4,
}

// #endregion

// #region websocket envelope

/** Every CA websocket frame. This is the ONLY json-tagged struct in the CA surface. */
export interface CaMessage<T = unknown> {
	type: string;
	data: T;
}

// #endregion

// #region REST + notifier payload shapes

export interface CaTbaMatchKey {
	CompLevel: string;
	SetNumber: number;
	MatchNumber: number;
}

/** model.Match, marshaled with PascalCase keys. Used both flat (REST) and nested (matchLoad). */
export interface CaMatch {
	Id: number;
	Type: number; // CaMatchType
	TypeOrder: number;
	Time: string; // RFC3339
	LongName: string;
	ShortName: string;
	NameDetail: string;
	PlayoffMatchGroupId: string;
	PlayoffRedAlliance: number;
	PlayoffBlueAlliance: number;
	Red1: number;
	Red1IsSurrogate: boolean;
	Red2: number;
	Red2IsSurrogate: boolean;
	Red3: number;
	Red3IsSurrogate: boolean;
	Blue1: number;
	Blue1IsSurrogate: boolean;
	Blue2: number;
	Blue2IsSurrogate: boolean;
	Blue3: number;
	Blue3IsSurrogate: boolean;
	StartedAt: string;
	ScoreCommittedAt: string;
	FieldReadyAt: string;
	Status: number; // CaMatchStatus
	UseTiebreakCriteria: boolean;
	TbaMatchKey: CaTbaMatchKey;
}

export interface CaTeam {
	Id: number;
	Name: string;
	Nickname: string;
	City: string;
	StateProv: string;
	Country: string;
	SchoolName: string;
	RookieYear: number;
	RobotName: string;
	Accomplishments: string;
	WpaKey: string;
	YellowCard: boolean;
	HasConnected: boolean;
	FtaNotes: string;
}

export interface CaWifiStatus {
	TeamId: number;
	RadioLinked: boolean;
	MBits: number;
	RxRate: number;
	TxRate: number;
	SignalNoiseRatio: number;
	/** 0 none, 1 caution, 2 warning, 3 good, 4 excellent. */
	ConnectionQuality: number;
}

export interface CaDriverStationConnection {
	TeamId: number;
	AllianceStation: string;
	Auto: boolean;
	Enabled: boolean;
	EStop: boolean;
	AStop: boolean;
	DsLinked: boolean;
	RadioLinked: boolean;
	RioLinked: boolean;
	RobotLinked: boolean;
	BatteryVoltage: number;
	DsRobotTripTimeMs: number;
	MissedPacketCount: number;
	DsReportedStatusValid: boolean;
	DsReportedAuto: boolean;
	DsReportedTeleop: boolean;
	DsReportedDisabled: boolean;
	DsReportedEnabled: boolean;
	SecondsSinceLastRobotLink: number;
	SentGameData: string;
	/** Non-empty when the connected team is in the wrong station. */
	WrongStation: string;
}

export interface CaAllianceStation {
	DsConn: CaDriverStationConnection | null;
	TeamMatchLog: null;
	Ethernet: boolean;
	AStop: boolean;
	EStop: boolean;
	Bypass: boolean;
	Team: CaTeam | null;
	WifiStatus: CaWifiStatus;
	GameData: string;
}

/** The six station keys in CA order. */
export const CA_STATIONS = ["R1", "R2", "R3", "B1", "B2", "B3"] as const;
export type CaStationKey = (typeof CA_STATIONS)[number];

export interface CaArenaStatus {
	MatchId: number;
	AllianceStations: Record<string, CaAllianceStation>;
	MatchState: number;
	CanStartMatch: boolean;
	AccessPointStatus: string;
	SwitchStatus: string;
	RedSCCStatus: string;
	BlueSCCStatus: string;
	PlcIsHealthy: boolean;
	FieldEStop: boolean;
	PlcArmorBlockStatuses: Record<string, boolean>;
}

export interface CaMatchLoad {
	Match: CaMatch;
	AllowSubstitution: boolean;
	IsReplay: boolean;
	Teams: Record<string, CaTeam | null>;
	Rankings: Record<string, number>;
	Matchup: unknown | null;
	RedOffFieldTeams: CaTeam[];
	BlueOffFieldTeams: CaTeam[];
	BreakDescription: string;
	BreakNextMatchName: string;
}

export interface CaMatchTime {
	MatchState: number;
	MatchTimeSec: number;
}

export interface CaMatchTiming {
	AutoDurationSec: number;
	PauseDurationSec: number;
	TransitionShiftDurationSec: number;
	ShiftDurationSec: number;
	EndgameDurationSec: number;
	TimeoutDurationSec: number;
}

export interface CaEventStatus {
	CycleTime: string;
	EarlyLateMessage: string;
}

// 2026 Hub game score model.
export interface CaHub {
	WonAuto: boolean;
	/** [8]int: Auto, Transition, Shift1..4, Endgame, PostMatch. */
	ShiftCounts: number[];
}

export interface CaScore {
	/** [3]TowerStatus (0 None, 1-3 Level). */
	AutoTowerStatuses: number[];
	Hub: CaHub;
	EndgameTowerStatuses: number[];
	Fouls: unknown[] | null;
	PlayoffDq: boolean;
}

export interface CaScoreSummary {
	AutoFuelPoints: number;
	AutoTowerPoints: number;
	TeleopFuelPoints: number;
	TeleopTowerPoints: number;
	NumFuel: number;
	NumFuelPostMatch: number;
	NumFuelGoal: number;
	MatchPoints: number;
	PostMatchPoints: number;
	FoulPoints: number;
	Score: number;
	PlayoffDq: boolean;
	EnergizedBonusRankingPoint: boolean;
	SuperchargedBonusRankingPoint: boolean;
	TraversalBonusRankingPoint: boolean;
	BonusRankingPoints: number;
	NumOpponentMajorFouls: number;
}

export interface CaAllianceScoreFields {
	Score: CaScore;
	ScoreSummary: CaScoreSummary;
	ActiveRemainingSec: number;
	ActiveDurationSec: number;
}

export interface CaRealtimeScore {
	Red: CaAllianceScoreFields;
	Blue: CaAllianceScoreFields;
	RedCards: Record<string, string>;
	BlueCards: Record<string, string>;
	MatchState: number;
}

export interface CaRanking {
	TeamId: number;
	Rank: number;
	PreviousRank: number;
	RankingPoints: number;
	MatchPoints: number;
	AutoFuelPoints: number;
	TowerPoints: number;
	Random: number;
	Wins: number;
	Losses: number;
	Ties: number;
	Disqualifications: number;
	Played: number;
}

/** /api/rankings element = Ranking + Nickname. */
export interface CaRankingWithNickname extends CaRanking {
	Nickname: string;
}

export interface CaAlliance {
	Id: number;
	TeamIds: number[];
	Lineup: [number, number, number];
}

/** /api/matches element = flat Match (inline) + Result. */
export interface CaMatchWithResult extends CaMatch {
	Result: CaMatchResultWithSummary | null;
}

export interface CaMatchResult {
	Id: number;
	MatchId: number;
	MatchType: number;
	PlayNumber: number;
	RedScore: CaScore;
	BlueScore: CaScore;
	RedCards: Record<string, string>;
	BlueCards: Record<string, string>;
}

export interface CaMatchResultWithSummary extends CaMatchResult {
	RedSummary: CaScoreSummary;
	BlueSummary: CaScoreSummary;
}

export interface CaScorePosted {
	Match: CaMatch;
	RedScoreSummary: CaScoreSummary;
	BlueScoreSummary: CaScoreSummary;
	RedRankingPoints: number;
	BlueRankingPoints: number;
	RedFouls: unknown[];
	BlueFouls: unknown[];
	RulesViolated: Record<string, unknown>;
	RedCards: Record<string, string>;
	BlueCards: Record<string, string>;
	RedRankings: Record<string, CaRanking | null>;
	BlueRankings: Record<string, CaRanking | null>;
	RedOffFieldTeamIds: number[];
	BlueOffFieldTeamIds: number[];
	RedWon: boolean;
	BlueWon: boolean;
	TiebreakReason: string;
	RedWins: number;
	BlueWins: number;
	RedDestination: string;
	BlueDestination: string;
}

// #endregion
