import {
	type AllianceParticipant,
	type AllianceSelectionType,
	type AllianceTimerType,
	type AnyGameModule,
	type AudienceBracketAlliance,
	FAULT_TYPES,
	type FMSLogFrame,
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
	type ScheduleEntry,
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
import { applyAdvance, currentPlayoffLevel, FINALS, initialPlayoffMatches, TEMPLATE } from "../match/playoff";
import { stableMatchId } from "./seed";

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

	/**
	 * Set the displayed match timer (seconds remaining): broadcasts MatchTimerChanged AND pushes a
	 * fresh state to the control UI, so the on-screen clock updates every tick (1 Hz) rather than
	 * only on the periodic refresh. Used both to pre-load the timer before the match and to tick it.
	 */
	setTimerRemaining(seconds: number): void {
		this.state.timer.secondsRemaining = seconds;
		this.emit("timerChanged", seconds);
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

	// #region rankings (recomputed from committed qualification results)

	/**
	 * Record a committed qualification result on its schedule entry, then recompute every team's
	 * win/loss/tie + ranking points from all played qual matches and re-rank. Ranking points follow
	 * the modern FRC scheme (win 3 / tie 1 / loss 0); sort1 is average RP, sort2 average match score.
	 */
	commitQualResult(matchNumber: number, redScore: number, blueScore: number): void {
		const entry = this.state.schedule.find((e) => e.level === "Qualification" && e.matchNumber === matchNumber);
		if (entry) {
			entry.finalScoreRed = redScore;
			entry.finalScoreBlue = blueScore;
			entry.status = "Played";
		}
		this.recomputeRankings();
	}

	recomputeRankings(): void {
		interface Tally {
			w: number;
			l: number;
			t: number;
			mp: number;
			rp: number;
			pts: number;
		}
		const tally = new Map<number, Tally>();
		const ensure = (n: number): Tally => {
			let s = tally.get(n);
			if (!s) {
				s = { w: 0, l: 0, t: 0, mp: 0, rp: 0, pts: 0 };
				tally.set(n, s);
			}
			return s;
		};
		for (const e of this.state.schedule) {
			if (e.level !== "Qualification" || e.status !== "Played") continue;
			const r = e.finalScoreRed ?? 0;
			const b = e.finalScoreBlue ?? 0;
			const redWin = r > b;
			const tie = r === b;
			const apply = (teams: number[], own: number, win: boolean): void => {
				for (const tn of teams) {
					const s = ensure(tn);
					s.mp++;
					s.pts += own;
					if (tie) {
						s.t++;
						s.rp += 1;
					} else if (win) {
						s.w++;
						s.rp += 3;
					} else {
						s.l++;
					}
				}
			};
			apply(e.red, r, redWin);
			apply(e.blue, b, !redWin && !tie);
		}
		const prevRank = new Map(this.state.rankings.map((r) => [r.teamNumber, r.rank]));
		for (const rec of this.state.rankings) {
			const s = tally.get(rec.teamNumber);
			rec.wins = s?.w ?? 0;
			rec.losses = s?.l ?? 0;
			rec.ties = s?.t ?? 0;
			rec.matchesPlayed = s?.mp ?? 0;
			rec.rankingScore = s && s.mp ? Number((s.rp / s.mp).toFixed(2)) : 0;
			rec.sort2 = s && s.mp ? Number((s.pts / s.mp).toFixed(2)) : 0;
		}
		// Sort by ranking score, then average score, then team number (a stable final tiebreak).
		this.state.rankings.sort(
			(a, b) => b.rankingScore - a.rankingScore || b.sort2 - a.sort2 || a.teamNumber - b.teamNumber,
		);
		this.state.rankings.forEach((rec, i) => {
			rec.rank = i + 1;
			const prev = prevRank.get(rec.teamNumber);
			rec.rankChange = prev === undefined || prev === rec.rank ? "NoChange" : prev > rec.rank ? "Up" : "Down";
		});
		this.touch();
	}

	// #endregion

	// #region playoff bracket (auto-advances as playoff matches commit)

	/**
	 * Record a committed playoff result and route the alliances downstream. `winner` is the outcome
	 * after the season's tiebreaker criteria (null = every criterion tied, so the match is replayed,
	 * not advanced); the caller resolves it via the game module so the bracket and the displayed
	 * result agree.
	 */
	commitPlayoffResult(matchNumber: number, redScore: number, blueScore: number, winner: "Red" | "Blue" | null): void {
		const m = this.state.playoffMatches[matchNumber];
		if (!m) return;
		m.redScore = redScore;
		m.blueScore = blueScore;
		m.winner = winner ?? "None";
		m.complete = m.winner !== "None"; // an unbreakable tie is replayed, not advanced
		applyAdvance(this.state.playoffMatches, matchNumber);
		if (this.state.bracket) this.state.bracket.currentLevel = currentPlayoffLevel(this.state.playoffMatches);
		this.rebuildPlayoffSchedule();
		this.touch();
	}

	private teamName(number: number | null | undefined): string {
		if (!number) return "";
		return this.state.teams.find((t) => t.number === number)?.name ?? `Team ${number}`;
	}

	/** The three team numbers of an alliance (captain, 1st pick, 2nd pick); zeros when unfilled. */
	private allianceTeams(allianceNumber: number | null): [number, number, number] {
		const a = allianceNumber ? this.state.alliances.find((x) => x.allianceNumber === allianceNumber) : undefined;
		return [a?.captainTeamNumber ?? 0, a?.firstRoundTeamNumber ?? 0, a?.secondRoundTeamNumber ?? 0];
	}

	/**
	 * Regenerate the Playoff schedule entries from the current bracket state so each playoff match's
	 * teams reflect the alliances currently routed into it (the match lifecycle reads these entries).
	 * Quals are left untouched.
	 */
	private rebuildPlayoffSchedule(): void {
		const nonPlayoff = this.state.schedule.filter((e) => e.level !== "Playoff");
		const fullCode = `${this.state.event.season}${this.state.event.code}`;
		const base = Date.UTC(2026, 2, 14, 15, 0, 0);
		const playoff: ScheduleEntry[] = [];
		let i = 0;
		const add = (matchNumber: number, description: string): void => {
			const m = this.state.playoffMatches[matchNumber];
			playoff.push({
				fmsMatchId: stableMatchId(`${fullCode}:Playoff:${matchNumber}:1`),
				matchNumber,
				playNumber: 1,
				level: "Playoff",
				description,
				scheduledStartTime: new Date(base + i * 10 * 60 * 1000).toISOString(),
				actualStartTime: null,
				red: this.allianceTeams(m?.red ?? null),
				blue: this.allianceTeams(m?.blue ?? null),
				status: m?.complete ? "Played" : "Pending",
				finalScoreRed: m?.complete ? m.redScore : null,
				finalScoreBlue: m?.complete ? m.blueScore : null,
				redAllianceNumber: m?.red ?? null,
				blueAllianceNumber: m?.blue ?? null,
			});
			i++;
		};
		for (const slot of TEMPLATE) add(slot.matchNumber, `Match ${slot.matchNumber} (${slot.round})`);
		for (const f of FINALS.filter((x) => x.matchNumber <= 16)) add(f.matchNumber, f.longName);
		this.state.schedule = [...nonPlayoff, ...playoff];
	}

	private buildBracketAlliances(): AudienceBracketAlliance[] {
		return this.state.alliances.map((a) => ({
			allianceNumber: a.allianceNumber,
			allianceName: a.allianceName,
			einsteinAlliance: "",
			captainTeamNumber: a.captainTeamNumber ?? 0,
			captainTeamNameShort: a.captainTeamNameShort,
			captainAvatar: "",
			firstRoundTeamNumber: a.firstRoundTeamNumber ?? 0,
			firstRoundTeamNameShort: a.firstRoundTeamNameShort,
			firstRoundAvatar: "",
			secondRoundTeamNumber: a.secondRoundTeamNumber ?? 0,
			secondRoundTeamNameShort: a.secondRoundTeamNameShort,
			secondRoundAvatar: "",
			alternateTeamNumber: a.alternateTeamNumber ?? 0,
			alternateTeamNameShort: a.alternateTeamNameShort,
			alternateAvatar: "",
			cardEffectiveStatus: "None" as const,
		}));
	}

	// #endregion

	// #region alliance selection ceremony

	setAllianceSelectionType(type: AllianceSelectionType): void {
		this.state.allianceSelectionType = type;
		this.touch();
	}

	/** Pick rounds for the configured alliance size: 2-team=1, 3-team=2, 4-team=3. */
	private pickRounds(): number {
		const t = this.state.allianceSelectionType;
		return t === "TwoTeam" ? 1 : t === "FourTeam" ? 3 : 2;
	}

	/** Serpentine pick order: round 1 alliances 1..N, round 2 N..1, round 3 1..N (per alliance size). */
	private allianceOrder(): { alliance: number; round: number }[] {
		const n = this.state.alliances.length || 8;
		const order: { alliance: number; round: number }[] = [];
		for (let round = 1; round <= this.pickRounds(); round++) {
			const forward = round % 2 === 1;
			for (let i = 0; i < n; i++) order.push({ alliance: forward ? i + 1 : n - i, round });
		}
		return order;
	}

	/** Mark the highest-ranked still-available, not-yet-on-an-alliance team as a potential captain. */
	private updatePotentialCaptains(): void {
		let marked = false;
		for (const r of this.state.rankings) {
			const available = r.pickStatus === "None" && !r.isDeclined;
			r.inPotentialCaptainPosition = available && !marked;
			if (available && !marked) marked = true;
		}
	}

	/** The slot (alliance + round) currently on the clock, or null when selection is finished. */
	currentAllianceSlot(): { alliance: number; round: number } | null {
		const sel = this.state.allianceSelection;
		if (!sel?.active) return null;
		return this.allianceOrder()[sel.pickIndex] ?? null;
	}

	private emitAllianceSlot(alliance: number, round: number, teamNumber: number | null): void {
		const participant: AllianceParticipant = round === 1 ? "Round1" : round === 2 ? "Round2" : "Backup";
		this.emit("allianceSelectionChanged", { AllianceNumber: alliance, AllianceParticipant: participant, TeamNumber: teamNumber });
	}

	/** Apply a pick to the alliance slot for the given round (1=first, 2=second, 3=backup/alternate). */
	private setAllianceSlot(allianceNumber: number, round: number, teamNumber: number | null): void {
		const al = this.state.alliances.find((a) => a.allianceNumber === allianceNumber);
		if (!al) return;
		const name = teamNumber ? this.teamName(teamNumber) : "";
		if (round === 1) {
			al.firstRoundTeamNumber = teamNumber;
			al.firstRoundTeamNameShort = name;
		} else if (round === 2) {
			al.secondRoundTeamNumber = teamNumber;
			al.secondRoundTeamNameShort = name;
		} else {
			al.alternateTeamNumber = teamNumber;
			al.alternateTeamNameShort = name;
		}
	}

	/** Begin alliance selection: lock the top-N ranked (non-declined) teams as captains. */
	allianceStart(): void {
		const captains = this.state.rankings
			.filter((r) => !r.isDeclined)
			.slice(0, this.state.alliances.length)
			.map((r) => r.teamNumber);
		this.state.alliances.forEach((al, i) => {
			al.captainTeamNumber = captains[i] ?? null;
			al.captainTeamNameShort = this.teamName(captains[i]);
			al.firstRoundTeamNumber = null;
			al.firstRoundTeamNameShort = "";
			al.secondRoundTeamNumber = null;
			al.secondRoundTeamNameShort = "";
			al.alternateTeamNumber = null;
			al.alternateTeamNameShort = "";
		});
		for (const r of this.state.rankings) {
			r.isDeclined = false;
			r.pickStatus = captains.includes(r.teamNumber) ? "Captain" : "None";
		}
		this.updatePotentialCaptains();
		this.state.allianceSelection = { active: true, pickIndex: 0, history: [] };
		for (const al of this.state.alliances) {
			this.emit("allianceSelectionChanged", {
				AllianceNumber: al.allianceNumber,
				AllianceParticipant: "Captain",
				TeamNumber: al.captainTeamNumber,
			});
		}
		this.touch();
	}

	/** Accept the given team into the current alliance slot. Returns false if not a legal pick. */
	alliancePick(teamNumber: number): boolean {
		const sel = this.state.allianceSelection;
		const slot = this.currentAllianceSlot();
		if (!sel?.active || !slot) return false;
		const rec = this.state.rankings.find((r) => r.teamNumber === teamNumber);
		if (!rec || rec.isDeclined || rec.pickStatus !== "None") return false;
		if (!this.state.alliances.some((a) => a.allianceNumber === slot.alliance)) return false;
		this.setAllianceSlot(slot.alliance, slot.round, teamNumber);
		rec.pickStatus = "Picked";
		sel.history.push({ alliance: slot.alliance, round: slot.round, teamNumber });
		sel.pickIndex++;
		this.updatePotentialCaptains();
		this.emitAllianceSlot(slot.alliance, slot.round, teamNumber);
		this.touch();
		return true;
	}

	/** Skip the current slot (e.g. an alliance fails to pick in time), leaving it empty. */
	allianceSkip(): boolean {
		const sel = this.state.allianceSelection;
		const slot = this.currentAllianceSlot();
		if (!sel?.active || !slot) return false;
		sel.history.push({ alliance: slot.alliance, round: slot.round, teamNumber: 0 });
		sel.pickIndex++;
		this.emitAllianceSlot(slot.alliance, slot.round, null);
		this.touch();
		return true;
	}

	/** Undo the most recent pick or skip, freeing the team and backing up to that slot. */
	allianceUndoPick(): boolean {
		const sel = this.state.allianceSelection;
		if (!sel?.active || sel.pickIndex === 0) return false;
		const last = sel.history.pop();
		if (!last) return false;
		sel.pickIndex--;
		this.setAllianceSlot(last.alliance, last.round, null);
		if (last.teamNumber) {
			const rec = this.state.rankings.find((r) => r.teamNumber === last.teamNumber);
			if (rec) rec.pickStatus = "None";
		}
		this.updatePotentialCaptains();
		this.emitAllianceSlot(last.alliance, last.round, null);
		this.touch();
		return true;
	}

	/**
	 * Tell the audience display to start one of the selection clocks. Real FMS sends this as a
	 * trigger only (no seconds): the audience display runs its own countdown. Round is "Round1" etc.
	 */
	startAllianceTimer(round: string, type: AllianceTimerType): void {
		this.emit("allianceTimer", { Round: round, TimerType: type });
	}

	/** Flag a team as declining a pick (or undo the decline). */
	allianceDecline(teamNumber: number, declined: boolean): void {
		const rec = this.state.rankings.find((r) => r.teamNumber === teamNumber);
		if (!rec || rec.pickStatus !== "None") return;
		rec.isDeclined = declined;
		this.updatePotentialCaptains();
		this.emit("allianceDecline", teamNumber, declined);
		this.touch();
	}

	/** Finalize alliance selection: build the bracket roster, seed round 1, and enter the playoffs. */
	allianceSave(): void {
		this.state.allianceSelection = null;
		if (this.state.bracket) {
			this.state.bracket.alliances = this.buildBracketAlliances();
			this.state.bracket.currentLevel = "Level6";
		}
		this.state.playoffMatches = initialPlayoffMatches();
		this.rebuildPlayoffSchedule();
		this.setCurrentMatch(1, 1, "Playoff");
		this.setMatchState("WaitingForPrestart");
		this.setTournamentLevel("Playoff");
		this.emit("scheduleChanged");
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

	// #region autoplay (auto-faults + live log replay through the field monitor)

	setAutoplay(patch: Partial<FmsState["autoplay"]>): void {
		this.state.autoplay = { ...this.state.autoplay, ...patch };
		this.touch();
	}

	/** Stamp the current match's actual start time (used by GetLog / GetResults timestamps). */
	markMatchStarted(): void {
		const { current } = this.state;
		const entry = this.state.schedule.find((e) => e.matchNumber === current.matchNumber && e.level === current.level);
		if (entry) entry.actualStartTime = new Date().toISOString();
		this.touch();
	}

	/**
	 * Roll 2-3 random faults onto 1-2 randomly-chosen robots for a match and store them as that
	 * match's log faults. Both GetLog and live replay then surface the same faults.
	 */
	generateMatchFaults(matchId: string, autoSeconds: number, teleopSeconds: number): void {
		this.clearLogFaults(matchId);
		const keys = [...STATION_KEYS];
		for (let i = keys.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[keys[i], keys[j]] = [keys[j] as StationKey, keys[i] as StationKey];
		}
		const numRobots = 1 + Math.floor(Math.random() * 2); // 1-2 robots
		for (const key of keys.slice(0, numRobots)) {
			const numFaults = 2 + Math.floor(Math.random() * 2); // 2-3 faults
			const slot = teleopSeconds / (numFaults + 1);
			const specs: LogFaultSpec[] = [];
			for (let i = 0; i < numFaults; i++) {
				const type = FAULT_TYPES[Math.floor(Math.random() * FAULT_TYPES.length)] as LogFaultSpec["type"];
				// Spread the faults across teleop with a little jitter so they don't all overlap.
				const startSec = Math.round(autoSeconds + slot * (i + 1) + (Math.random() - 0.5) * slot * 0.5);
				specs.push({ type, startSec: Math.max(2, startSec) });
			}
			this.setLogFaults(matchId, key, specs);
		}
	}

	/** Set all six stations fully connected (used to show robots linked pre-match during replay). */
	connectStations(): void {
		for (const k of STATION_KEYS) {
			const s = this.state.stations[k];
			s.ds = "green";
			s.radio = "green";
			s.rio = "green";
			s.code = "green";
		}
		this.emitStations();
	}

	/** Drive one station's indicators + battery/ping from a generated log frame (no broadcast). */
	setStationFromLog(key: StationKey, f: FMSLogFrame): void {
		const s = this.state.stations[key];
		s.ds = f.dsLinkActive ? "green" : "red";
		s.radio = f.radioLink ? "green" : "red";
		s.rio = f.rioLink ? "green" : "red";
		s.code = f.linkActive ? "green" : "red";
		s.battery = f.battery;
		s.ping = f.averageTripTime;
	}

	// #endregion

	// #region test sequence (audience-display walk-every-screen showcase)

	/** Mirror the test-sequence runner's status into the state pushed to the control UI. */
	setTestSequence(patch: Partial<FmsState["testSequence"]>): void {
		this.state.testSequence = { ...this.state.testSequence, ...patch };
		this.touch();
	}

	/**
	 * Wire a playoff match's alliances directly (used by the test sequence to stage bracket/finals
	 * matchups without playing the whole bracket): set the playoff match slot and fill its schedule
	 * entry's on-field teams from the two alliance rosters.
	 */
	seedPlayoffMatch(matchNumber: number, redAllianceNumber: number, blueAllianceNumber: number): void {
		const m = this.state.playoffMatches[matchNumber] ?? {
			matchNumber,
			red: null,
			blue: null,
			redScore: 0,
			blueScore: 0,
			winner: "None" as const,
			complete: false,
		};
		m.red = redAllianceNumber;
		m.blue = blueAllianceNumber;
		this.state.playoffMatches[matchNumber] = m;
		const entry = this.state.schedule.find((e) => e.level === "Playoff" && e.matchNumber === matchNumber);
		if (entry) {
			entry.red = this.allianceTeams(redAllianceNumber);
			entry.blue = this.allianceTeams(blueAllianceNumber);
			entry.redAllianceNumber = redAllianceNumber;
			entry.blueAllianceNumber = blueAllianceNumber;
		}
		this.touch();
	}

	// #endregion
}
