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

// Real FMS serializes these three enums on the wire as their STRING names, not the numeric value
// (confirmed against a real FieldMonitorDataChanged capture). Use these unions for the frame.
export type MonitorStatusName =
	| "Unknown"
	| "EStopped"
	| "AStopped"
	| "DisabledAuto"
	| "DisabledTeleop"
	| "EnabledAuto"
	| "EnabledTeleop";
export type BWUtilizationName = "Low" | "Medium" | "High" | "VeryHigh";
export type WPAKeyStatusName = "NotTested" | "UsedInConnectionTest" | "UsedInMatch";

// #endregion

// #region SignalRMonitorFrame (the wire shape FMS pushes on fieldMonitorHub)

/**
 * Per-robot status frame as emitted by FMS over the fieldMonitorHub
 * `FieldMonitorDataChanged` event. FTA-Buddy decodes every field; audience-display
 * reads only Alliance + TeamNumber. Field names are PascalCase to match FMS exactly.
 */
export interface SignalRMonitorFrame {
	Alliance: "Red" | "Blue";
	/**
	 * The real FMS sends this as the string enum name ("Station1".."Station3"), NOT the numeric
	 * value. FTA-Buddy relies on that: it does `FMSEnums.StationType[Station]` (a name->value
	 * forward lookup) to build the red1..blue3 key. Sending a number breaks that mapping and the
	 * extension's frame handler throws, so it never forwards anything to the server.
	 */
	Station: "Station1" | "Station2" | "Station3";
	TeamNumber: number;
	Connection: boolean;
	LinkActive: boolean;
	DSLinkActive: boolean;
	RadioLink: boolean;
	RIOLink: boolean;
	IsEnabled: boolean;
	IsAuto: boolean;
	IsBypassed: boolean;
	IsEStopLatched: boolean;
	IsEStopped: boolean;
	Battery: number;
	MonitorStatus: MonitorStatusName;
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
	BWUtilization: BWUtilizationName;
	WPAKeyStatus: WPAKeyStatusName;
	DriverStationIsOfficial: boolean;
	StationStatus: "Good" | "WrongStation" | "WrongMatch" | "Waiting" | "Unknown";
	Brownout: boolean;
	EStopSource: string;
	IsAStopLatched: boolean;
	IsAStopped: boolean;
	MoveToStation: string | null;
	RadioConnectionQuality: "Warning" | "Caution" | "Good" | "Excellent" | null;
	RadioConnectedToAp: boolean | null;
	IsEStopPressed: boolean;
	IsAStopPressed: boolean;
}

// #endregion

// #region Station control model (drives the click-to-cycle field monitor)

/**
 * Each robot has four independently-cycleable indicators that mirror what FTA-Buddy renders:
 *  - DS:   red -> greenX (X) -> green -> waiting (W) -> move (M)
 *  - radio/rio/code: red -> greenX (X) -> green
 * Side states (bypass/estop/astop) overlay all four.
 */
export type DsCycle = "red" | "greenX" | "green" | "waiting" | "move";
export type PartCycle = "red" | "greenX" | "green";
export type StationPart = "ds" | "radio" | "rio" | "code";

export const DS_ORDER: DsCycle[] = ["red", "greenX", "green", "waiting", "move"];
export const PART_ORDER: PartCycle[] = ["red", "greenX", "green"];

export function nextDs(c: DsCycle): DsCycle {
	const i = DS_ORDER.indexOf(c);
	return DS_ORDER[(i + 1) % DS_ORDER.length] as DsCycle;
}

export function nextPart(c: PartCycle): PartCycle {
	const i = PART_ORDER.indexOf(c);
	return PART_ORDER[(i + 1) % PART_ORDER.length] as PartCycle;
}

/** Internal per-station state held in the store; one per Red1-3 / Blue1-3. */
export interface StationState {
	alliance: "Red" | "Blue";
	station: StationType;
	teamNumber: number;
	ds: DsCycle;
	radio: PartCycle;
	rio: PartCycle;
	code: PartCycle;
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
	// Real FMS reports "Unknown" until a driver station actually connects (ds past red).
	if (s.ds === "red") return MonitorStatusType.Unknown;
	if (ctx.isEnabled && ctx.isAuto) return MonitorStatusType.EnabledAuto;
	if (ctx.isEnabled) return MonitorStatusType.EnabledTeleop;
	if (ctx.isAuto) return MonitorStatusType.DisabledAuto;
	return MonitorStatusType.DisabledTeleop;
}

function stationStatus(s: StationState): SignalRMonitorFrame["StationStatus"] {
	// FTA-Buddy's dsState(): WrongStation -> M, WrongMatch -> W, anything else (with no DS link)
	// -> GREEN_X. So map the DS cycle to the StationStatus that yields the intended letter.
	if (s.ds === "move") return "WrongStation";
	if (s.ds === "waiting") return "WrongMatch";
	if (s.ds === "red") return "Unknown";
	return "Good";
}

/**
 * Build the wire frame FMS would emit for one station from its four part-states. The mappings are
 * chosen so FTA-Buddy's decode (signalR.ts dsState() + raw RadioLink/RIOLink/LinkActive booleans,
 * plus the radioConnected/!radio and rio/!code "X" overlays) renders each indicator as intended.
 */
export function toMonitorFrame(s: StationState, ctx: FrameContext): SignalRMonitorFrame {
	const connected = s.ds !== "red"; // Connection: any DS state but red
	const dsLink = s.ds === "green"; // DSLinkActive: only full green
	const radio = s.radio === "green"; // RadioLink
	const radioToAp = s.radio !== "red"; // greenX/green -> connected to AP (FTA-Buddy radio "X")
	const rio = s.rio !== "red"; // RIOLink up for greenX/green
	const code = s.code === "green"; // LinkActive (robot code)
	const enabled = ctx.isEnabled && !s.bypassed && !s.estop;

	return {
		Alliance: s.alliance,
		Station: `Station${s.station}` as SignalRMonitorFrame["Station"],
		TeamNumber: s.teamNumber,
		Connection: connected,
		LinkActive: code,
		DSLinkActive: dsLink,
		RadioLink: radio,
		RIOLink: rio,
		IsEnabled: enabled,
		IsAuto: ctx.isAuto,
		IsBypassed: s.bypassed,
		IsEStopLatched: s.estop,
		IsEStopped: s.estop,
		Battery: code ? s.battery : 0,
		MonitorStatus: MonitorStatusType[monitorStatus(s, ctx)] as MonitorStatusName,
		AverageTripTime: code ? s.ping : 0,
		LostPackets: 0,
		Signal: code ? -45 : 0,
		Noise: code ? -90 : 0,
		SNR: code ? 45 : 0,
		Inactivity: 0,
		MACAddress: s.mac,
		TxRate: code ? 550.6 : 0,
		TxMCS: code ? 5 : 0,
		TxMCSBandWidth: code ? 20 : 0,
		TxVHT: null,
		TxVHTNSS: null,
		TxPackets: 0,
		RxRate: code ? 550.6 : 0,
		RxMCS: code ? 5 : 0,
		RxMCSBandWidth: code ? 20 : 0,
		RxVHT: null,
		RxVHTNSS: null,
		RxPackets: 0,
		DataRateTotal: code ? 1.2 : 0,
		DataRateToRobot: code ? 0.6 : 0,
		DataRateFromRobot: code ? 0.6 : 0,
		BWUtilization: "Low",
		WPAKeyStatus: code ? "UsedInMatch" : "NotTested",
		DriverStationIsOfficial: connected,
		StationStatus: stationStatus(s),
		Brownout: false,
		EStopSource: s.estop ? "Robot" : "D",
		IsAStopLatched: s.astop,
		IsAStopped: s.astop,
		MoveToStation: s.ds === "move" ? `${s.alliance}${s.station}` : null,
		RadioConnectionQuality: radioToAp ? "Good" : "Warning",
		RadioConnectedToAp: radioToAp,
		IsEStopPressed: s.estop,
		IsAStopPressed: s.astop,
	};
}

// #endregion
