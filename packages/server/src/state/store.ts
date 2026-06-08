import {
	type AnyGameModule,
	type FMSMatchScore,
	type FTANoteRecord,
	type FmsState,
	type LogFaultSpec,
	type NoteAction,
	type PlcEstopStatusData,
	type PlcMatchStatusData,
	getGameModule,
	type MatchStateString,
	nextDs,
	nextPart,
	type SignalRMonitorFrame,
	type StationKey,
	type StationPart,
	STATION_KEYS,
	type StoreEvents,
	type Team,
	toMonitorFrame,
	type TournamentLevel,
	type VideoSwitchOption,
} from "shared";
import { TypedEmitter } from "tiny-typed-emitter";
import { dotnetNow } from "../util/dotnet-time";

/**
 * The single source of truth. Holds the in-memory FmsState, exposes typed getters for the
 * REST/SignalR read layers, and typed mutators for the control API and match controller.
 * Every mutator emits the relevant domain event(s) plus `stateChanged` (consumed by the
 * control UI websocket); `fanout.ts` maps the domain events to SignalR broadcasts.
 */
export class FmsStore extends TypedEmitter<StoreEvents> {
	private state: FmsState;
	private gameModule: AnyGameModule;

	constructor(initial: FmsState) {
		super();
		this.state = initial;
		this.gameModule = getGameModule(initial.gameModuleId);
	}

	// #region reads

	getState(): FmsState {
		return this.state;
	}

	getGameModule(): AnyGameModule {
		return this.gameModule;
	}

	/** Whether robots are enabled / in auto, derived from the current match state. */
	frameContext(): { isEnabled: boolean; isAuto: boolean } {
		const ms = this.state.current.matchState;
		return { isEnabled: ms === "MatchAuto" || ms === "MatchTeleop", isAuto: ms === "MatchAuto" };
	}

	/** The 6 station frames in canonical order (red1..3, blue1..3). */
	monitorFrames(): SignalRMonitorFrame[] {
		const ctx = this.frameContext();
		return STATION_KEYS.map((k) => toMonitorFrame(this.state.stations[k], ctx));
	}

	// #endregion

	/** Emit a fresh snapshot to the control UI. Call after any mutation. */
	private touch(): void {
		this.emit("stateChanged", this.state);
	}

	// #region event / teams / schedule

	updateEvent(patch: Partial<FmsState["event"]>): void {
		this.state.event = { ...this.state.event, ...patch };
		this.touch();
	}

	setGameModule(id: string): void {
		this.gameModule = getGameModule(id);
		this.state.gameModuleId = this.gameModule.id;
		this.state.gameConfig = this.gameModule.defaultGameConfig();
		this.state.score = { red: this.gameModule.emptyScore(), blue: this.gameModule.emptyScore() };
		this.touch();
	}

	setTeams(teams: Team[]): void {
		this.state.teams = teams;
		this.touch();
	}

	addTeam(team: Team): void {
		if (!this.state.teams.some((t) => t.number === team.number)) {
			this.state.teams.push(team);
			this.state.teams.sort((a, b) => a.number - b.number);
			this.touch();
		}
	}

	removeTeam(number: number): void {
		this.state.teams = this.state.teams.filter((t) => t.number !== number);
		this.touch();
	}

	setSchedule(schedule: FmsState["schedule"]): void {
		this.state.schedule = schedule;
		this.touch();
	}

	setRankings(rankings: FmsState["rankings"]): void {
		this.state.rankings = rankings;
		this.touch();
	}

	setAlliances(alliances: FmsState["alliances"]): void {
		this.state.alliances = alliances;
		this.touch();
	}

	// #endregion

	// #region tournament level / video switch / current match

	setTournamentLevel(level: TournamentLevel): void {
		this.state.event.level = level;
		this.state.current.level = level;
		this.emit("tournamentLevelChanged", level);
		this.touch();
	}

	setVideoSwitch(option: VideoSwitchOption): void {
		this.state.event.videoSwitchOption = option;
		this.emit("videoSwitchChanged", option);
		this.touch();
	}

	setCurrentMatch(matchNumber: number, playNumber: number, level: TournamentLevel): void {
		this.state.current.matchNumber = matchNumber;
		this.state.current.playNumber = playNumber;
		this.state.current.level = level;
		this.touch();
	}

	/** Set the FMS match state and emit MatchStatusInfoChanged to listeners. */
	setMatchState(matchState: MatchStateString): void {
		this.state.current.matchState = matchState;
		this.emit("matchStateChanged", {
			MatchState: matchState,
			MatchNumber: this.state.current.matchNumber,
			PlayNumber: this.state.current.playNumber,
			Level: this.state.current.level,
		});
		this.touch();
	}

	// #endregion

	// #region field monitor stations

	private emitStations(): void {
		this.emit("stationsChanged", this.monitorFrames());
		this.touch();
	}

	/** Re-broadcast the current station frames (e.g. on prestart or enable change). */
	broadcastStations(): void {
		this.emitStations();
	}

	/** Advance one indicator (ds/radio/rio/code) of a station to its next state. */
	cycleStationPart(key: StationKey, part: StationPart): void {
		const s = this.state.stations[key];
		if (part === "ds") s.ds = nextDs(s.ds);
		else s[part] = nextPart(s[part]);
		this.emitStations();
	}

	setBypass(key: StationKey, on: boolean): void {
		this.state.stations[key].bypassed = on;
		this.emitStations();
	}

	setEstop(key: StationKey, on: boolean): void {
		this.state.stations[key].estop = on;
		this.emitStations();
		this.emit("estopStatusChanged", this.estopStatusPayload());
	}

	/** PLC_ESTOP_STATUS_Changed payload: the currently e-stopped stations as "BlueStation1, ...". */
	private estopStatusPayload(): PlcEstopStatusData {
		const order: StationKey[] = ["blue1", "blue2", "blue3", "red1", "red2", "red3"];
		const estopped = order
			.filter((k) => this.state.stations[k].estop)
			.map((k) => {
				const s = this.state.stations[k];
				return `${s.alliance}Station${s.station}`;
			});
		return {
			EStopStatusChanged: estopped.join(", "),
			EStopStatusValue: "None",
			Source: "",
			EStopButtonStatusChanged: "None",
			EStopButtonStatusValue: "None",
		};
	}

	setAstop(key: StationKey, on: boolean): void {
		this.state.stations[key].astop = on;
		this.emitStations();
	}

	/** Reset all stations to disconnected, clearing bypass/estop/astop. */
	resetStations(): void {
		for (const k of STATION_KEYS) {
			const s = this.state.stations[k];
			s.ds = "red";
			s.radio = "red";
			s.rio = "red";
			s.code = "red";
			s.bypassed = false;
			s.estop = false;
			s.astop = false;
		}
		this.emitStations();
	}

	/** Assign team numbers to the 6 stations from a schedule entry. */
	loadStationsFromMatch(red: [number, number, number], blue: [number, number, number]): void {
		this.state.stations.red1.teamNumber = red[0];
		this.state.stations.red2.teamNumber = red[1];
		this.state.stations.red3.teamNumber = red[2];
		this.state.stations.blue1.teamNumber = blue[0];
		this.state.stations.blue2.teamNumber = blue[1];
		this.state.stations.blue3.teamNumber = blue[2];
		this.emitStations();
	}

	// #endregion

	// #region scoring

	private scoreOf(alliance: "Red" | "Blue"): Record<string, unknown> {
		return alliance === "Red" ? this.state.score.red : this.state.score.blue;
	}

	private broadcastScore(alliance: "Red" | "Blue"): void {
		const recomputed = this.gameModule.recompute(this.scoreOf(alliance));
		if (alliance === "Red") this.state.score.red = recomputed;
		else this.state.score.blue = recomputed;
		this.emit("scoreChanged", alliance, this.gameModule.toScoreChangedData(recomputed, dotnetNow()));
		this.touch();
	}

	/**
	 * Merge a PLC status patch, recompute MatchStatusChanged (the comma-joined list of ready/done
	 * flags currently true, e.g. "ScoreReady, RefDone"), and broadcast PLC_MATCH_STATUS_Changed.
	 */
	setPlcStatus(patch: Partial<PlcMatchStatusData>): void {
		Object.assign(this.state.plc, patch);
		const flags = ["RefReady", "ScoreReady", "FieldCleanup", "ArenaClear", "RefDone", "RefUnderReview"] as const;
		this.state.plc.MatchStatusChanged = flags.filter((f) => this.state.plc[f]).join(", ");
		this.emit("plcMatchStatus", { ...this.state.plc });
		this.touch();
	}

	setScoreField(alliance: "Red" | "Blue", key: string, value: number | boolean): void {
		this.scoreOf(alliance)[key] = value;
		this.broadcastScore(alliance);
	}

	resetScores(): void {
		this.state.score = { red: this.gameModule.emptyScore(), blue: this.gameModule.emptyScore() };
		this.broadcastScore("Red");
		this.broadcastScore("Blue");
	}

	/** Force re-emit of both alliance scores (used on prestart / score open). */
	broadcastScores(): void {
		this.broadcastScore("Red");
		this.broadcastScore("Blue");
	}

	// #endregion

	// #region results storage

	resultKey(level: TournamentLevel, matchNumber: number): string {
		return `${level}:${matchNumber}`;
	}

	storeResult(key: string, result: FMSMatchScore): void {
		this.state.results[key] = result;
		this.touch();
	}

	// #endregion

	// #region notes

	addNoteRecord(record: FTANoteRecord): void {
		this.state.notes.push(record);
		this.emit("noteChanged", "added", record);
		this.touch();
	}

	updateNoteRecord(id: string, patch: Partial<FTANoteRecord>): FTANoteRecord | undefined {
		const record = this.state.notes.find((n) => n.fmsEventNoteId === id);
		if (!record) return undefined;
		const wasResolved = record.resolutionStatus === "Resolved";
		Object.assign(record, patch);
		const action: NoteAction =
			patch.resolutionStatus === "Resolved"
				? "resolved"
				: wasResolved && patch.resolutionStatus === "Open"
					? "reopened"
					: "updated";
		this.emit("noteChanged", action, record);
		this.touch();
		return record;
	}

	deleteNoteRecord(id: string): FTANoteRecord | undefined {
		const record = this.state.notes.find((n) => n.fmsEventNoteId === id);
		if (!record) return undefined;
		record.isDeleted = true;
		this.emit("noteChanged", "deleted", record);
		this.touch();
		return record;
	}

	notesForTeam(teamNumber: number): FTANoteRecord[] {
		return this.state.notes.filter((n) => n.teamNumber === teamNumber && !n.isDeleted);
	}

	// #endregion

	// #region log faults

	private faultKey(matchId: string, robot: string): string {
		return `${matchId}:${robot}`;
	}

	setLogFaults(matchId: string, robot: string, faults: LogFaultSpec[]): void {
		if (faults.length === 0) delete this.state.logFaults[this.faultKey(matchId, robot)];
		else this.state.logFaults[this.faultKey(matchId, robot)] = faults;
		this.touch();
	}

	getLogFaults(matchId: string, robot: string): LogFaultSpec[] {
		return this.state.logFaults[this.faultKey(matchId, robot)] ?? [];
	}

	/** Clear faults for one match (all robots) or, with no arg, every match. */
	clearLogFaults(matchId?: string): void {
		if (!matchId) {
			this.state.logFaults = {};
		} else {
			for (const key of Object.keys(this.state.logFaults)) {
				if (key.startsWith(`${matchId}:`)) delete this.state.logFaults[key];
			}
		}
		this.touch();
	}

	// #endregion
}
