import type {
	AudienceShowMatchResultData,
	BracketData,
	FMSAllianceSelection,
	FMSMatchScore,
	FMSRankingTeam,
	GameConfig,
	GameSpecificMessage,
	MatchStateString,
	MatchStatusInfo,
	PlcMatchStatusData,
	ScoreChangedData,
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
	autopilot: boolean;
}

export interface CurrentMatch {
	matchNumber: number;
	playNumber: number;
	level: TournamentLevel;
	matchState: MatchStateString;
}

export interface HubClientCounts {
	fieldMonitorHub: number;
	infrastructureHub: number;
	gameSpecificHub: number;
	ftaAppHub: number;
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
	schedule: ScheduleEntry[];
	alliances: FMSAllianceSelection[];
	rankings: FMSRankingTeam[];
	bracket: BracketData | null;
	current: CurrentMatch;
	stations: Record<StationKey, StationState>;
	/** Game-specific scores; typed by the active game module's TScore. */
	score: { red: Record<string, unknown>; blue: Record<string, unknown> };
	timer: TimerState;
	gameConfig: GameConfig;
	plc: PlcMatchStatusData;
	results: Record<string, FMSMatchScore>;
	notes: FTANoteRecord[];
	clients: HubClientCounts;
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
	scoreChanged: (alliance: "Red" | "Blue", data: ScoreChangedData) => void;
	gameSpecificMessage: (msg: GameSpecificMessage) => void;
	timerChanged: (secondsRemaining: number) => void;
	timerWarning: (which: 1 | 2 | "timeout") => void;
	showResults: (data: AudienceShowMatchResultData) => void;
	videoSwitchChanged: (option: VideoSwitchOption) => void;
	tournamentLevelChanged: (level: TournamentLevel) => void;
	plcMatchStatus: (data: PlcMatchStatusData) => void;
	noteChanged: (action: NoteAction, record: FTANoteRecord) => void;
}

// #endregion
