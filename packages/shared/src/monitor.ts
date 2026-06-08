// #region FMS enums (numeric, must match real FMS / FTA-Buddy FMSEnums)

export enum Level {
	None = 0,
	Practice = 1,
	Qualification = 2,
	Playoff = 3,
}

export enum StationType {
	None = 0,
	Station1 = 1,
	Station2 = 2,
	Station3 = 3,
}

export enum MonitorStatusType {
	Unknown = 0,
	EStopped = 1,
	AStopped = 2,
	DisabledAuto = 3,
	DisabledTeleop = 4,
	EnabledAuto = 5,
	EnabledTeleop = 6,
}

export enum BWUtilizationType {
	Low = 0,
	Medium = 1,
	High = 2,
	VeryHigh = 3,
}

export enum WPAKeyStatusType {
	NotTested = 0,
	UsedInConnectionTest = 1,
	UsedInMatch = 2,
}

// #endregion

// #region SignalRMonitorFrame (the wire shape FMS pushes on fieldMonitorHub)

/**
 * Per-robot status frame as emitted by FMS over the fieldMonitorHub
 * `FieldMonitorDataChanged` event. FTA-Buddy decodes every field; audience-display
 * reads only Alliance + TeamNumber. Field names are PascalCase to match FMS exactly.
 */
export interface SignalRMonitorFrame {
	Alliance: "Red" | "Blue";
	Station: StationType;
	TeamNumber: number;
	Connection: boolean;
	LinkActive: boolean;
	DSLinkActive: boolean;
	RadioLink: boolean;
	RIOLink: boolean;
	IsEnabled: boolean;
	IsAuto: boolean;
	IsBypassed: boolean;
	IsEStopPressed: boolean;
	IsEStopped: boolean;
	Battery: number;
	MonitorStatus: MonitorStatusType;
	AverageTripTime: number;
	LostPackets: number;
	Signal: number;
	Noise: number;
	SNR: number;
	Inactivity: number;
	MACAddress: string | null;
	TxRate: number;
	TxMCS: number;
	TxMCSBandWidth: number;
	TxVHT: number | null;
	TxVHTNSS: boolean | null;
	TxPackets: number;
	RxRate: number;
	RxMCS: number;
	RxMCSBandWidth: number;
	RxVHT: number | null;
	RxVHTNSS: boolean | null;
	RxPackets: number;
	DataRateTotal: number;
	DataRateToRobot: number;
	DataRateFromRobot: number;
	BWUtilization: BWUtilizationType;
	WPAKeyStatus: WPAKeyStatusType;
	DriverStationIsOfficial: boolean;
	StationStatus: "Good" | "WrongStation" | "WrongMatch" | "Waiting" | "Unknown";
	Brownout: boolean;
	EStopSource: string;
	IsAStopPressed: boolean;
	IsAStopped: boolean;
	MoveToStation: string | null;
	RadioConnectionQuality: "Warning" | "Caution" | "Good" | "Excellent" | null;
	RadioConnectedToAp: boolean | null;
}

// #endregion

// #region Station control model (drives the click-to-cycle field monitor)

/**
 * The connection-progress positions a robot cycles through when the operator
 * clicks its indicator in the control UI. Side states (bypass/estop/astop) are
 * tracked separately so they overlay any cycle position.
 */
export type StationCycle =
	| "none" // no DS connection at all
	| "ds" // driver station connected
	| "radio" // radio link up
	| "rio" // roboRIO link up
	| "code" // robot code running
	| "green" // fully connected + healthy
	| "wrongStation" // connected but plugged into the wrong station
	| "waiting"; // connected, FMS waiting

export const CYCLE_ORDER: StationCycle[] = ["none", "ds", "radio", "rio", "code", "green"];

export function nextCycle(current: StationCycle): StationCycle {
	const idx = CYCLE_ORDER.indexOf(current);
	if (idx === -1) return "none"; // wrongStation / waiting fall back into the main loop
	return CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length] as StationCycle;
}

/** Internal per-station state held in the store; one per Red1-3 / Blue1-3. */
export interface StationState {
	alliance: "Red" | "Blue";
	station: StationType;
	teamNumber: number;
	cycle: StationCycle;
	bypassed: boolean;
	estop: boolean;
	astop: boolean;
	battery: number;
	ping: number;
	mac: string | null;
}

export const STATION_KEYS = ["red1", "red2", "red3", "blue1", "blue2", "blue3"] as const;
export type StationKey = (typeof STATION_KEYS)[number];

export function stationKey(alliance: "Red" | "Blue", station: StationType): StationKey {
	return `${alliance.toLowerCase()}${station}` as StationKey;
}

// #endregion

// #region StationState -> SignalRMonitorFrame projection

interface FrameContext {
	/** Robot enabled by FMS (true once match is running and not bypassed/estopped). */
	isEnabled: boolean;
	/** Match currently in the autonomous period. */
	isAuto: boolean;
}

function monitorStatus(s: StationState, ctx: FrameContext): MonitorStatusType {
	if (s.estop) return MonitorStatusType.EStopped;
	if (s.astop) return MonitorStatusType.AStopped;
	if (ctx.isEnabled && ctx.isAuto) return MonitorStatusType.EnabledAuto;
	if (ctx.isEnabled) return MonitorStatusType.EnabledTeleop;
	if (ctx.isAuto) return MonitorStatusType.DisabledAuto;
	return MonitorStatusType.DisabledTeleop;
}

function stationStatus(s: StationState): SignalRMonitorFrame["StationStatus"] {
	if (s.cycle === "wrongStation") return "WrongStation";
	if (s.cycle === "waiting") return "Waiting";
	if (s.cycle === "none") return "Unknown";
	return "Good";
}

/** Build the wire frame FMS would emit for one station from its control state. */
export function toMonitorFrame(s: StationState, ctx: FrameContext): SignalRMonitorFrame {
	const dsLink = s.cycle !== "none";
	const radio = ["radio", "rio", "code", "green"].includes(s.cycle);
	const rio = ["rio", "code", "green"].includes(s.cycle);
	const code = ["code", "green"].includes(s.cycle);
	const connected = dsLink;
	const enabled = ctx.isEnabled && !s.bypassed && !s.estop;

	return {
		Alliance: s.alliance,
		Station: s.station,
		TeamNumber: s.teamNumber,
		Connection: connected,
		LinkActive: code,
		DSLinkActive: dsLink,
		RadioLink: radio,
		RIOLink: rio,
		IsEnabled: enabled,
		IsAuto: ctx.isAuto,
		IsBypassed: s.bypassed,
		IsEStopPressed: s.estop,
		IsEStopped: s.estop,
		Battery: code ? s.battery : 0,
		MonitorStatus: monitorStatus(s, ctx),
		AverageTripTime: code ? s.ping : 0,
		LostPackets: 0,
		Signal: code ? -45 : 0,
		Noise: code ? -90 : 0,
		SNR: code ? 45 : 0,
		Inactivity: 0,
		MACAddress: s.mac,
		TxRate: code ? 550.6 : 0,
		TxMCS: code ? 5 : 0,
		TxMCSBandWidth: 20,
		TxVHT: null,
		TxVHTNSS: null,
		TxPackets: 0,
		RxRate: code ? 550.6 : 0,
		RxMCS: code ? 5 : 0,
		RxMCSBandWidth: 20,
		RxVHT: null,
		RxVHTNSS: null,
		RxPackets: 0,
		DataRateTotal: code ? 1.2 : 0,
		DataRateToRobot: code ? 0.6 : 0,
		DataRateFromRobot: code ? 0.6 : 0,
		BWUtilization: BWUtilizationType.Low,
		WPAKeyStatus: WPAKeyStatusType.UsedInMatch,
		DriverStationIsOfficial: true,
		StationStatus: stationStatus(s),
		Brownout: false,
		EStopSource: s.estop ? "Robot" : "",
		IsAStopPressed: s.astop,
		IsAStopped: s.astop,
		MoveToStation: s.cycle === "wrongStation" ? `${s.alliance}${s.station}` : null,
		RadioConnectionQuality: radio ? "Good" : null,
		RadioConnectedToAp: radio,
	};
}

// #endregion
