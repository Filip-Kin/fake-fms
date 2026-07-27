import type {
	AllianceSelectionChangedData,
	AllianceSelectionType,
	AllianceTimerData,
	AudienceShowMatchResultData,
	BracketData,
	FMSAllianceSelection,
	GameConfig,
	GameSpecificMessage,
	MatchStateString,
	MatchStatusInfo,
	PlcEstopStatusData,
	PlcMatchStatusData,
	PlcAllianceSelectionStatusData,
	ScoreChangedData,
	StoredMatchResult,
	TournamentLevel,
	VideoSwitchOption,
} from "./fms-wire";
import type { SignalRMonitorFrame, StationKey, StationState } from "./monitor";
import type { FTANoteRecord } from "./notes";

export type NoteAction = "added" | "updated" | "reopened" | "resolved" | "deleted";

// #region core state shape

export interface Team {
	number: number;
	name: string;
	wpaKey: string;
	/** Raw base64 PNG (no data: prefix), as real FMS returns it; null if the team has no avatar. */
	avatar: string | null;
}

/** Single source of truth for a scheduled match; rendered into both REST shapes. */
export interface ScheduleEntry {
	fmsMatchId: string;
	matchNumber: number;
	playNumber: number;
	level: TournamentLevel;
	description: string;
	scheduledStartTime: string;
	actualStartTime: string | null;
	red: [number, number, number];
	blue: [number, number, number];
	status: "Pending" | "Played";
	finalScoreRed: number | null;
	finalScoreBlue: number | null;
	redAllianceNumber: number | null;
	blueAllianceNumber: number | null;
}

export interface TimerState {
	phase: GameSpecificMessage["MatchPhase"];
	secondsRemaining: number;
	running: boolean;
}

// #region match-log fault injection

export const FAULT_TYPES = [
	"dsDisconnect",
	"radioDisconnect",
	"rioDisconnect",
	"codeDisconnect",
	"brownout",
	"highPing",
	"sustainedPing",
	"lowSignal",
	"highBandwidth",
] as const;

export type FaultType = (typeof FAULT_TYPES)[number];

export interface LogFaultSpec {
	type: FaultType;
	/** Seconds from match start (auto = 0). Defaults to mid-teleop. */
	startSec?: number;
	/** Window length in seconds. Defaults per fault type. */
	durationSec?: number;
}

// #endregion

export interface CurrentMatch {
	matchNumber: number;
	playNumber: number;
	level: TournamentLevel;
	matchState: MatchStateString;
}

/**
 * A team's qualification ranking record. Holds both the rich sortable data (wins/losses/ties +
 * sort orders, recomputed from committed quals) and the alliance-selection view fields
 * (isDeclined/pickStatus). The three ranking endpoints each project the subset they need.
 */
export interface RankingRecord {
	rank: number;
	teamNumber: number;
	// alliance-selection view
	isDeclined: boolean;
	pickStatus: "None" | "Captain" | "Picked";
	inPotentialCaptainPosition: boolean;
	// qualification record (recomputed from committed match results)
	wins: number;
	losses: number;
	ties: number;
	matchesPlayed: number;
	rankingScore: number; // sort1 = average ranking points
	sort2: number;
	sort3: number;
	sort4: number;
	sort5: number;
	sort6: number;
	rankChange: "NoChange" | "Up" | "Down";
}

/** Live state of one playoff match slot (alliances + result), driving bracket advancement. */
export interface PlayoffMatchState {
	matchNumber: number;
	red: number | null;
	blue: number | null;
	redScore: number;
	blueScore: number;
	winner: "Red" | "Blue" | "None";
	complete: boolean;
}

/** In-progress alliance-selection ceremony. Null when not running. */
export interface AllianceSelectionState {
	active: boolean;
	/**
	 * The live pick order. Starts as the serpentine order; a skipped slot is re-inserted after the
	 * next slot so the skipped alliance comes back on the clock immediately after the next pick.
	 */
	order: { alliance: number; round: number }[];
	/** Index into `order`; >= order length means every pick has been made. */
	pickIndex: number;
	/** Picks/skips made so far, newest last, for undo. teamNumber 0 marks a skipped slot. round is the
	 * 1-based pick round (1=first pick … up to teams-1). captainsBefore snapshots every alliance's
	 * captain when the pick was a captain-pick (which re-seeds), so undo can restore them. */
	history: { alliance: number; round: number; teamNumber: number; captainsBefore?: (number | null)[] }[];
}

export interface HubClientCounts {
	fieldMonitorHub: number;
	infrastructureHub: number;
	gameSpecificHub: number;
	ftaAppHub: number;
}

/** One step of the audience-display test sequence (the showcase that walks every screen). */
export interface TestSequenceStep {
	id: string;
	label: string;
	group: string;
}

/** Live status of the audience-display test sequence runner, mirrored to the control UI. */
export interface TestSequenceState {
	running: boolean;
	/** Index of the step currently showing, or -1 when the sequence has not started. */
	currentIndex: number;
	steps: TestSequenceStep[];
}

export interface FmsState {
	event: {
		code: string;
		name: string;
		location: string;
		season: number;
		tournamentType: string;
		level: TournamentLevel;
		videoSwitchOption: VideoSwitchOption;
		fmsEventId: string;
		fmsEventPassword: string;
		fmsVersion: string;
	};
	gameModuleId: string;
	teams: Team[];
	/** Teams currently carrying a card, keyed by team number. Absent = no card. */
	cards: Record<number, "Yellow" | "Red">;
	schedule: ScheduleEntry[];
	alliances: FMSAllianceSelection[];
	rankings: RankingRecord[];
	/** Teams per alliance for the selection ceremony (default ThreeTeam). */
	allianceSelectionType: AllianceSelectionType;
	bracket: BracketData | null;
	/** Per-match playoff state keyed by playoff match number (1-13 bracket, 14-16 finals). */
	playoffMatches: Record<number, PlayoffMatchState>;
	/** In-progress alliance selection, or null when not running. */
	allianceSelection: AllianceSelectionState | null;
	current: CurrentMatch;
	stations: Record<StationKey, StationState>;
	/** Game-specific scores; typed by the active game module's TScore. */
	score: { red: Record<string, unknown>; blue: Record<string, unknown> };
	timer: TimerState;
	gameConfig: GameConfig;
	plc: PlcMatchStatusData;
	/** Committed match results, keyed by `${level}:${matchNumber}`, snapshotted at commit time. */
	results: Record<string, StoredMatchResult>;
	/**
	 * Operator conveniences. replayLogs: at match start, generate the per-robot match logs and play
	 * them live through the field monitor (so connection states + faults animate without manual
	 * clicking). autoFaults: at match start, roll 2-3 random faults onto 1-2 robots for the match.
	 */
	autoplay: { replayLogs: boolean; autoFaults: boolean };
	notes: FTANoteRecord[];
	/** Per-robot injected log faults, keyed by `${fmsMatchId}:${robotKey}` (robotKey = red1..blue3). */
	logFaults: Record<string, LogFaultSpec[]>;
	clients: HubClientCounts;
	/** State of the audience-display test sequence runner (the walk-every-screen showcase). */
	testSequence: TestSequenceState;
}

// #endregion

// #region store -> fanout event contract

/**
 * Domain events emitted by the store. `fanout.ts` is the single place that maps each to
 * the matching SignalR broadcast(s); `stateChanged` always fires so the control UI
 * receives a fresh snapshot after any mutation.
 */
export interface StoreEvents {
	stateChanged: (state: FmsState) => void;
	matchStateChanged: (info: MatchStatusInfo) => void;
	stationsChanged: (frames: SignalRMonitorFrame[]) => void;
	/** Push the current field-monitor frames as a FieldMonitorDataChanged broadcast out of the 1 Hz
	 * heartbeat cadence (e.g. so a consumer's team lineup is current before a screen switch). */
	fieldMonitorPush: (frames: SignalRMonitorFrame[]) => void;
	scoreChanged: (alliance: "Red" | "Blue", data: ScoreChangedData) => void;
	gameSpecificMessage: (msg: GameSpecificMessage) => void;
	timerChanged: (secondsRemaining: number) => void;
	/** The 3s auto->teleop pause clock (wire timer name MatchTransitionTimer). */
	transitionTimerChanged: (secondsRemaining: number) => void;
	/** Alliance-selection clock ticks (wire timer name AllianceSelectionTimer). Carries BOTH the
	 * break clocks AND the per-pick clock - real FMS ticks the pick clock over the wire too. */
	allianceSelectionTimerChanged: (secondsRemaining: number) => void;
	timerWarning: (which: 1 | 2 | "timeout") => void;
	showResults: (data: AudienceShowMatchResultData) => void;
	videoSwitchChanged: (option: VideoSwitchOption) => void;
	tournamentLevelChanged: (level: TournamentLevel) => void;
	plcMatchStatus: (data: PlcMatchStatusData) => void;
	estopStatusChanged: (data: PlcEstopStatusData) => void;
	matchCommitted: (fmsMatchId: string) => void;
	matchPosted: (fmsMatchId: string) => void;
	noteChanged: (action: NoteAction, record: FTANoteRecord) => void;
	allianceSelectionChanged: (data: AllianceSelectionChangedData) => void;
	allianceTimer: (data: AllianceTimerData) => void;
	/** PLC_ALLIANCESELECTION_STATUS_Changed console-button pulse (start/pause/break buttons). */
	allianceSelectionButton: (data: PlcAllianceSelectionStatusData) => void;
	allianceDecline: (teamNumber: number, declined: boolean) => void;
	scheduleChanged: () => void;
	/** LastCycleTimeCalculated: match cycle time as a .NET TimeSpan string (FTA-Buddy cycle stats). */
	lastCycleTime: (timeSpan: string) => void;
}

// #endregion
