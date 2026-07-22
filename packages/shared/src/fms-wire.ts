// Wire types for the SignalR payloads and REST responses FMS exposes.
// Names/casing copied verbatim from the real consumers so payloads are byte-compatible:
//  - FTA-Buddy: shared/types.ts, shared/fmsApiTypes.ts
//  - audience-display: packages/lib/types/*

// #region tournament levels & match state

export type TournamentLevel = "None" | "Practice" | "Qualification" | "Playoff";

/** Levels as the audience-display REST schedule reports them (superset of TournamentLevel). */
export type ScheduleLevel = TournamentLevel | "DoubleElimPlayoff" | "DoubleElimFinal";

/**
 * The exact MatchState strings FMS emits via MatchStatusInfoChanged. Both consumers
 * switch on these literally; the "...TO" timeout variants are recognised by audience-display.
 */
export type MatchStateString =
	| "WaitingForPrestart"
	| "WaitingForPrestartTO"
	| "Prestarting"
	| "WaitingForMatchPreview"
	| "WaitingForSetAudience"
	| "WaitingForMatchReady"
	| "WaitingForMatchStart"
	| "GameSpecificData"
	| "MatchAuto"
	| "MatchTransition"
	| "MatchTeleop"
	| "WaitingForCommit"
	| "WaitingForPostResults"
	| "MatchCancelled";

export interface MatchStatusInfo {
	MatchState: MatchStateString;
	MatchNumber: number;
	PlayNumber: number;
	Level: TournamentLevel;
}

export interface AudienceShowMatchResultData {
	MatchNumber: number;
	TournamentLevel: TournamentLevel;
	IsRepost: boolean;
	IsDebug: boolean;
}

/**
 * The real FMS VideoSwitchOption values, verbatim from the audience web bundle's enum
 * (web/main.js: Background=0 .. RegionalAdvancers=18) and the VideoSwitchOptionChanged values in
 * signalr.jsonl. These are stored internally AND emitted raw on the wire; there is no mapping layer.
 * Note "MatchResult" is singular, and "Background" and "VideoOnly" are distinct states.
 */
export const VIDEO_SWITCH_OPTIONS = [
	"Background",
	"MatchPreview",
	"VideoOnly",
	"VideoAndScore",
	"MatchResult",
	"Rankings",
	"Schedule",
	"Alliance",
	"AllianceHybrid",
	"AllianceFullscreen",
	"Bracket",
	"Timeout",
	"Award",
	"AwardAssignment",
	"WifiReminder",
	"Message",
	"TimerBug",
	"RegionalPreviouslyQualified",
	"RegionalAdvancers",
] as const;

export type VideoSwitchOption = (typeof VIDEO_SWITCH_OPTIONS)[number];

/**
 * The match number real FMS puts on the wire. Ground truth (2026-07-22/23
 * real 8-alliance runs, MIRR laptop logs): finals ride the wire with their
 * internal playoff numbers (14/15, overtime 17-19) on all surfaces,
 * INCLUDING the Final Tiebreaker as 16 while it loads and plays - but from
 * WaitingForPostResults onward the FT flips to MatchNumber 0, and its
 * AudienceShowMatchResult posts as 0. Callers on those two paths pass
 * postingTiebreaker to reproduce that.
 */
export function wireMatchNumber(
	level: TournamentLevel,
	matchNumber: number,
	postingTiebreaker = false,
): number {
	return level === "Playoff" && matchNumber === 16 && postingTiebreaker ? 0 : matchNumber;
}

/** PLC_ESTOP_STATUS_Changed payload. EStopStatusChanged is a comma-joined list of e-stopped stations. */
export interface PlcEstopStatusData {
	EStopStatusChanged: string;
	EStopStatusValue: string;
	Source: string;
	EStopButtonStatusChanged: string;
	EStopButtonStatusValue: string;
}

/** FieldMonitorPreviousMacAddressesChanged payload (the last-seen robot MACs; empty when none). */
export interface FieldMonitorPreviousMacAddresses {
	Red1MacAddress: string;
	Red2MacAddress: string;
	Red3MacAddress: string;
	Blue1MacAddress: string;
	Blue2MacAddress: string;
	Blue3MacAddress: string;
}

// #endregion

// #region game-specific SignalR payloads (gameSpecificHub)

// Key order matches the real RedScoreChanged/BlueScoreChanged payload exactly (signalr.jsonl):
// AdvantageAchieved sits between TotalFuelCount and AutoClimbPoints, and TimeStamp is last.
export type ScoreChangedData = {
	AdjustPoints: number;
	G206Penalty: boolean;
	G418Penalty: boolean;
	G419Penalty: boolean;
	TotalPoints: number;
	AutoPoints: number;
	TeleopPoints: number;
	FoulPoints: number;

	EnergizedAchieved: boolean;
	SuperchargedAchieved: boolean;
	TraversalAchieved: boolean;

	AutoFuelPoints: number;
	CoopFuelPoints: number;
	Shift1FuelPoints: number;
	Shift2FuelPoints: number;
	Shift3FuelPoints: number;
	Shift4FuelPoints: number;
	EndgameFuelPoints: number;
	TeleopFuelPoints: number;
	TotalFuelPoints: number;
	TeleopFuelCount: number;
	TotalFuelCount: number;
	AdvantageAchieved: boolean;

	AutoClimbPoints: number;
	EndgameClimbPoints: number;
	TotalClimbPoints: number;

	EnergizedThreshold: number;
	SuperchargedThreshold: number;
	TraversalThreshold: number;

	TimeStamp: string;
};

// The real 2026 SendGameSpecificMessage MatchPhase values (confirmed from capture). The earlier
// PreMatch/TransitionShift/PostMatch names were never emitted by real FMS; idle/post-match is "None".
export type MatchPhase =
	| "None"
	| "Auto"
	| "Coop"
	| "Shift1"
	| "Shift2"
	| "Shift3"
	| "Shift4"
	| "Endgame";

export type GameSpecificMessage = {
	MatchPhase: MatchPhase;
	BlueAllianceGoalActive: boolean;
	RedAllianceGoalActive: boolean;
	CurrentPhaseTimeSeconds: number;
	MessageType: "MatchPhaseChanged" | string;
};

// Per-station "new card" flag on the PLC status. Only "None" was seen in the capture; the card
// values themselves live in the results, so this stays a string rather than a guessed enum.
export type CardNewStatus = "None" | string;

// Key order matches the real PLC_MATCH_STATUS_Changed payload exactly. MatchStatusChanged is a
// comma-joined list of the ready/done flags that are currently true (e.g. "ScoreReady, RefDone").
export type PlcMatchStatusData = {
	MatchStatusChanged: string;
	RefReady: boolean;
	ScoreReady: boolean;
	FieldCleanup: boolean;
	ArenaClear: boolean;
	RefDone: boolean;
	RefUnderReview: boolean;
	BlueFouls: number;
	BlueFoulsTech: number;
	RedFouls: number;
	RedFoulsTech: number;
	Blue1CardNew: CardNewStatus;
	Blue2CardNew: CardNewStatus;
	Blue3CardNew: CardNewStatus;
	Red1CardNew: CardNewStatus;
	Red2CardNew: CardNewStatus;
	Red3CardNew: CardNewStatus;
};

// #endregion

// #region REST: schedule / matches

/** fieldmonitor/get/GetResults/{level} item (FTA-Buddy FMSMatch). Key order matches the capture. */
export interface FMSMatch {
	fmsMatchId: string;
	tournamentLevel: TournamentLevel;
	fmsEventId: string;
	startTime: string;
	actualStartTime: string;
	description: string;
	dayNumber: number;
	matchNumber: number;
	playNumber: number;
	teamNumberBlue1: number;
	teamNumberBlue2: number;
	teamNumberBlue3: number;
	teamNumberRed1: number;
	teamNumberRed2: number;
	teamNumberRed3: number;
}

/** A Json.NET-serialized gzipped byte array (e.g. the GetCurrentResults scoreDetails blob). */
export interface DotNetByteArray {
	$value: string;
}

/** match/get/GetCurrentResults item (MatchModuleMatchViewItem): per-station result + score blob. */
export interface FMSCurrentResult {
	matchId: string;
	scheduleDetailId: string;
	tournamentLevel: TournamentLevel;
	fmsEventId: string;
	actualStartTime: string;
	description: string;
	dayNumber: number | null;
	matchNumber: number;
	teamNumberBlue1: number;
	cardBlue1: string;
	isDisqualifiedBlue1: boolean;
	isBypassedBlue1: boolean;
	teamNumberBlue2: number;
	cardBlue2: string;
	isDisqualifiedBlue2: boolean;
	isBypassedBlue2: boolean;
	teamNumberBlue3: number;
	cardBlue3: string;
	isDisqualifiedBlue3: boolean;
	isBypassedBlue3: boolean;
	teamNumberRed1: number;
	cardRed1: string;
	isDisqualifiedRed1: boolean;
	isBypassedRed1: boolean;
	teamNumberRed2: number;
	cardRed2: string;
	isDisqualifiedRed2: boolean;
	isBypassedRed2: boolean;
	teamNumberRed3: number;
	cardRed3: string;
	isDisqualifiedRed3: boolean;
	isBypassedRed3: boolean;
	blueAutoScore: number;
	bluePenalty: number;
	blueScore: number;
	redAutoScore: number;
	redPenalty: number;
	redScore: number;
	redAllianceNumber: number;
	blueAllianceNumber: number;
	headRefReview: boolean;
	scoreDetails: DotNetByteArray;
}

/** match/get/GetCurrentSchedule item (audience-display FMSMatchSchedule; superset). */
export interface FMSMatchSchedule {
	scheduleDetailId: string;
	tournamentLevel: ScheduleLevel;
	fmsEventId: string;
	startTime: string;
	description: string;
	dayNumber: number | null;
	fieldType: string;
	matchNumber: number;
	teamNumberBlue1: number;
	teamNumberBlue2: number;
	teamNumberBlue3: number;
	teamNumberRed1: number;
	teamNumberRed2: number;
	teamNumberRed3: number;
	finalScoreBlue: number | null;
	finalScoreRed: number | null;
	matchStatus: string;
	redAllianceNumber: number | null;
	blueAllianceNumber: number | null;
}

export interface FMSLogFrame {
	timeStamp: string;
	matchTimeBase: number;
	matchTime: number;
	auto: boolean;
	dsLinkActive: boolean;
	enabled: boolean;
	aStopPressed: boolean;
	eStopPressed: boolean;
	linkActive: boolean;
	radioLink: boolean;
	rioLink: boolean;
	averageTripTime: number;
	lostPackets: number;
	sentPackets: number;
	battery: number;
	brownout: boolean;
	signal: number | null;
	noise: number | null;
	snr: number | null;
	txRate: number | null;
	txMCS: number | null;
	rxRate: number | null;
	rxMCS: number | null;
	dataRateTotal: number;
}

// #endregion

// #region REST: preview / results / alliances / rankings / bracket

export interface FMSMatchPreviewTeam {
	teamNumber: number;
	// Real FMS sends null (not "Team 0"/"") for an empty alliance slot.
	teamName: string | null;
	// Real FMS sends null (not 0) on Test-level previews, where there is no qual-rank context.
	teamRank: number | null;
	avatar: string | null;
	carryingCard: boolean;
}

export interface FMSMatchPreviewAlliance {
	allianceName?: string;
	allianceNumber?: number;
	carryingCard?: boolean;
	team1: FMSMatchPreviewTeam;
	team2: FMSMatchPreviewTeam;
	team3: FMSMatchPreviewTeam;
	team4?: FMSMatchPreviewTeam;
}

// Key order matches the capture: matchNumber, numberOfQualMatches, matchDescription, ...
export interface FMSMatchPreview {
	matchNumber: number;
	numberOfQualMatches?: number;
	matchDescription: string;
	eventName: string;
	eventCode: string;
	tournamentType: string;
	redAlliance: FMSMatchPreviewAlliance;
	blueAlliance: FMSMatchPreviewAlliance;
}

// NOTE: results teams do NOT carry `carryingCard` (that is preview-only); they report card status
// via cardCarryStatus/cardEffectiveStatus. So this does NOT extend FMSMatchPreviewTeam.
export interface FMSMatchResultsTeam {
	teamNumber: number;
	teamName: string | null;
	teamRank: number;
	teamRankChange: "Up" | "Down" | "NoChange" | null;
	avatar: string | null;
	cardCarryStatus: "None" | "Yellow" | "Red";
	cardEffectiveStatus: "None" | "Yellow" | "Red";
}

export type AllianceScoreDetails = {
	win: boolean;
	tie: boolean;
	totalScore: number;
	isHighScore: boolean;
	autoFuelPoints: number;
	autoClimbPoints: number;
	teleopFuelPoints: number;
	teleopClimbPoints: number;
	penaltyPoints: number;
	energizedAchieved: boolean;
	superchargedAchieved: boolean;
	traversalAchieved: boolean;
	rankingPoints: number;
};

export type FMSAllianceData = {
	scoreDetails: AllianceScoreDetails;
	allianceName?: string;
	allianceNumber?: number;
	seriesWins?: number;
	cardCarryStatus?: "None" | "Yellow" | "Red";
	cardEffectiveStatus?: "None" | "Yellow" | "Red";
	team1: FMSMatchResultsTeam;
	team2: FMSMatchResultsTeam;
	team3: FMSMatchResultsTeam;
	team4?: FMSMatchResultsTeam;
};

export type PlayoffLevel = "Final" | "Level2" | "Level3" | "Level4" | "Level5" | "Level6" | "Level7";
export type Bracket = "Single" | "DoubleUpper" | "DoubleLower";
export type PlayoffSizeTypes =
	| "TwoAlliance"
	| "FourAlliance"
	| "FiveAlliance"
	| "SixAlliance"
	| "SevenAlliance"
	| "EightAlliance"
	| "SixteenAlliance";
export type PlayoffTiebreakType =
	| "Unknown"
	| "TrueTie"
	| "TieBreakSortOrder1"
	| "TieBreakSortOrder2"
	| "TieBreakSortOrder3"
	| "TieBreakSortOrder4"
	| "TieBreakSortOrder5"
	| "TieBreakSortOrder6";

export type FMSMatchScore = {
	matchNumber: number;
	numberOfQualMatches?: number;
	matchDescription: string;
	eventName: string;
	eventCode: string;
	season: number;
	tournamentType: string;
	redAllianceData: FMSAllianceData;
	blueAllianceData: FMSAllianceData;
	matchWinner: "Red" | "Blue" | null;
	cooppertitionBonusAchieved?: boolean;
	playoffLevel?: PlayoffLevel;
	playoffBracket?: Bracket;
	allianceCount?: PlayoffSizeTypes;
	tiebreaker?: PlayoffTiebreakType;
};

// #region playoff / finals preview + results DTOs (audience web bundle model shapes)

// Field lists and declaration order are verbatim from the real audience web bundle
// (web/main.js: AudienceMatchPreviewPlayoffData / AudiencePlayoffMatchResultData /
// AudienceFinalsMatchResultData model classes). The double-elim endpoints were never captured
// over REST, so the exact `$type` strings are extrapolated from the endpoint names following the
// qual naming pattern; the JS consumers ignore `$type`.

/** Team object inside playoff/finals previews AND results: 3 fields only (no rank, no card). */
export interface FMSPlayoffTeam {
	teamNumber: number;
	teamName: string | null;
	avatar: string | null;
}

/** Where the winner/loser of a playoff match goes next (bundle AudiencePlayoffMatchResultAdvancementData). */
export interface FMSPlayoffAdvancement {
	matchNumber: number;
	matchLevel: PlayoffLevel | "";
	matchBracket: Bracket | "";
	matchDescription: string;
	isEliminated: boolean;
}

/** Alliance inside GetDoubleElim{Playoff,Final}MatchPreviewData (cards are alliance-level here). */
export interface FMSPlayoffPreviewAlliance {
	allianceName: string;
	allianceNumber: number;
	carryingCard: boolean;
	team1: FMSPlayoffTeam;
	team2: FMSPlayoffTeam;
	team3: FMSPlayoffTeam;
	team4: FMSPlayoffTeam | null;
}

export interface FMSPlayoffMatchPreview {
	matchNumber: number;
	matchDescription: string;
	eventName: string;
	eventCode: string;
	tournamentType: string;
	playoffBracket: Bracket;
	allianceCount: PlayoffSizeTypes;
	playoffLevel: PlayoffLevel;
	winnerPlayoffAdvancementData: FMSPlayoffAdvancement;
	loserPlayoffAdvancementData: FMSPlayoffAdvancement;
	redAlliance: FMSPlayoffPreviewAlliance;
	blueAlliance: FMSPlayoffPreviewAlliance;
}

/** Finals preview adds the live best-of-3 series tally on top of the playoff preview shape. */
export interface FMSFinalsMatchPreview extends FMSPlayoffMatchPreview {
	redWins: number;
	blueWins: number;
}

/** Alliance inside GetMatchResultsDoubleElimPlayoffData (bundle AudiencePlayoffMatchResultAllianceData). */
export interface FMSPlayoffResultsAlliance {
	allianceName: string;
	allianceNumber: number;
	scoreDetails: AllianceScoreDetails;
	cardCarryStatus: "None" | "Yellow" | "Red";
	cardEffectiveStatus: "None" | "Yellow" | "Red";
	playoffAdvancementStatus: FMSPlayoffAdvancement;
	team1: FMSPlayoffTeam;
	team2: FMSPlayoffTeam;
	team3: FMSPlayoffTeam;
	team4: FMSPlayoffTeam | null;
}

/** Alliance inside GetMatchResultsDoubleElimFinalData: seriesWins after allianceNumber, no advancement. */
export interface FMSFinalsResultsAlliance {
	allianceName: string;
	allianceNumber: number;
	seriesWins: number;
	scoreDetails: AllianceScoreDetails;
	cardCarryStatus: "None" | "Yellow" | "Red";
	cardEffectiveStatus: "None" | "Yellow" | "Red";
	team1: FMSPlayoffTeam;
	team2: FMSPlayoffTeam;
	team3: FMSPlayoffTeam;
	team4: FMSPlayoffTeam | null;
}

export interface FMSPlayoffMatchResult {
	matchNumber: number;
	matchDescription: string;
	eventName: string;
	eventCode: string;
	season: number;
	tournamentType: string;
	playoffBracket: Bracket;
	allianceCount: PlayoffSizeTypes;
	playoffLevel: PlayoffLevel;
	redAllianceData: FMSPlayoffResultsAlliance;
	blueAllianceData: FMSPlayoffResultsAlliance;
	matchWinner: "Red" | "Blue" | null;
	tiebreaker: PlayoffTiebreakType | null;
}

export interface FMSFinalsMatchResult {
	matchNumber: number;
	matchDescription: string;
	eventName: string;
	eventCode: string;
	season: number;
	tournamentType: string;
	playoffBracket: Bracket;
	allianceCount: PlayoffSizeTypes;
	playoffLevel: PlayoffLevel;
	redAllianceData: FMSFinalsResultsAlliance;
	blueAllianceData: FMSFinalsResultsAlliance;
	matchWinner: "Red" | "Blue" | null;
	tiebreaker: PlayoffTiebreakType | null;
}

/** What commitScores snapshots per (level, matchNumber): the level-appropriate results DTO. */
export type StoredMatchResult = FMSMatchScore | FMSPlayoffMatchResult | FMSFinalsMatchResult;

// #endregion

export type FMSAllianceSelection = {
	allianceNumber: number;
	allianceName: string;
	einsteinAlliance: string;
	isEinstein: boolean;
	captainTeamNumber: number | null;
	captainTeamNameShort: string;
	captainAvatar: string;
	firstRoundTeamNumber: number | null;
	firstRoundTeamNameShort: string;
	firstRoundAvatar: string;
	secondRoundTeamNumber: number | null;
	secondRoundTeamNameShort: string;
	secondRoundAvatar: string;
	alternateTeamNumber: number | null;
	alternateTeamNameShort: string;
	alternateAvatar: string;
	cardEffectiveStatus: "None" | "Yellow" | "Red";
};

/** rankings/get/GetTeamRankings item (real type FMS.Contract.TeamRankingForSort). */
export interface FMSTeamRanking {
	randomSortValue: number;
	eventParticipant: null;
	fmsEventId: string;
	fmsTeamId: string;
	ranking: number;
	rankChange: string;
	wins: number;
	losses: number;
	ties: number;
	qualifyingScore: number;
	pointsScoredTotal: number;
	pointsScoredAverage: number;
	pointsScoredAverageChange: string;
	matchesPlayed: number;
	disqualified: number;
	sortOrder1: number;
	sortOrder2: number;
	sortOrder3: number;
	sortOrder4: number;
	sortOrder5: number;
	sortOrder6: number;
	createdOn: string;
	createdBy: string;
	modifiedOn: string;
	modifiedBy: string;
}

// GetQualRankings item (real type AllianceSelectionRankingEventWizard). Field order matches real.
export type FMSRankingTeam = {
	rank: number;
	teamNumber: number;
	isDeclined: boolean;
	pickStatus: string;
	inPotentialCaptainPosition: boolean;
};

/** Which slot of an alliance an AllianceSelectionChanged event refers to. */
export type AllianceParticipant = "Captain" | "Round1" | "Round2" | "Backup";

/** Number of teams per alliance: TwoTeam=captain+1 pick, ThreeTeam=+2 (default), FourTeam=+3. */
export type AllianceSelectionType = "TwoTeam" | "ThreeTeam" | "FourTeam";

/**
 * infrastructureHub `AllianceSelectionChanged` payload: real FMS fires one of these for each slot
 * whenever it changes during the selection ceremony (TeamNumber null clears the slot).
 */
export interface AllianceSelectionChangedData {
	AllianceNumber: number;
	AllianceParticipant: AllianceParticipant;
	TeamNumber: number | null;
}

/** Which selection clock FMS is asking the audience display to run. */
export type AllianceTimerType = "PickTimer" | "TwoMinuteBreak" | "EightMinuteBreak";

/**
 * infrastructureHub `AudienceAllianceTimer` payload (confirmed from a real-FMS capture). For
 * PickTimer it is a trigger, not a tick: the audience display runs the pick countdown itself.
 * The BREAK clocks (TwoMinuteBreak = between rounds, EightMinuteBreak = the wizard's Break
 * Timer button) DO tick over the wire afterwards, as TimerChanged
 * {Timer: "AllianceSelectionTimer"} at 1 Hz (2026-07-19 ground-truth log).
 */
export interface AllianceTimerData {
	Round: string;
	TimerType: AllianceTimerType;
}

export type AudienceBracketAlliance = {
	allianceNumber: number;
	allianceName: string;
	einsteinAlliance: string;
	captainTeamNumber: number;
	captainTeamNameShort: string;
	captainAvatar: string;
	firstRoundTeamNumber: number;
	firstRoundTeamNameShort: string;
	firstRoundAvatar: string;
	secondRoundTeamNumber: number;
	secondRoundTeamNameShort: string;
	secondRoundAvatar: string;
	alternateTeamNumber: number;
	alternateTeamNameShort: string;
	alternateAvatar: string;
	cardEffectiveStatus: "None" | "Yellow" | "Red";
};

export type AudienceDoubleElimMatch = {
	matchNumber: number;
	shortName: string;
	longName: string;
	isComplete: boolean;
	winningAllianceType: "None" | "Red" | "Blue";
	winningAllianceNumber: number;
	redAllianceNumber: number;
	redAllianceScore: number;
	blueAllianceNumber: number;
	blueAllianceScore: number;
	isNextMatch: boolean;
};

export type BracketData = {
	alliances: AudienceBracketAlliance[];
	doubleElimMatchesList: AudienceDoubleElimMatch[];
	finals: AudienceDoubleElimMatch | null;
	currentLevel: PlayoffLevel;
	allianceCount: PlayoffSizeTypes;
	tournamentType: string;
	season: number;
	eventCode: string;
	eventName: string;
	eventLocation: string;
};

export type AuxIOConfigType = "NotInUse" | "RedSpare" | "BlueSpare";

export type GameConfig = {
	traversalThreshold: number;
	energizedThreshold: number;
	superchargedThreshold: number;
	coopShiftLengthSeconds: number;
	shift1LengthSeconds: number;
	shift2LengthSeconds: number;
	shift3LengthSeconds: number;
	shift4LengthSeconds: number;
	endgameLengthSeconds: number;
	postMatchScoringDelayMilliseconds: number;
	spareCounterBox: AuxIOConfigType;
};

// #endregion
