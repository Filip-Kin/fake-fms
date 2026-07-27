import {
	type AllianceParticipant,
	type AllianceSelectionType,
	type AllianceTimerType,
	type AnyGameModule,
	type AudienceBracketAlliance,
	FAULT_TYPES,
	type FMSAllianceSelection,
	type FMSLogFrame,
	type FTANoteRecord,
	type FmsState,
	type HubClientCounts,
	type LogFaultSpec,
	type MatchPhase,
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
	type StoredMatchResult,
	type StoreEvents,
	type Team,
	toMonitorFrame,
	type TournamentLevel,
	type VideoSwitchOption,
	wireMatchNumber,
} from "shared";
import { TypedEmitter } from "tiny-typed-emitter";
import { dotnetNow } from "../util/dotnet-time";
import { applyAdvance, currentPlayoffLevel, FINALS, initialPlayoffMatches, maybeScheduleOvertime, TEMPLATE, usesTiebreakers } from "../match/playoff";
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
		// MatchStatusInfo is a wire payload: real FMS keeps the internal playoff
		// numbering (finals 14-19) on the wire, except the Final Tiebreaker
		// flips to 0 once scores are in (2026-07-22/23 real-run logs).
		this.emit("matchStateChanged", {
			MatchState: matchState,
			MatchNumber: wireMatchNumber(
				this.state.current.level,
				this.state.current.matchNumber,
				matchState === "WaitingForPostResults",
			),
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

	/**
	 * Update the shown clock for the control UI only - no wire broadcast. Real FMS never ticks
	 * the pick/break clocks over the wire (AudienceAllianceTimer is just the start trigger and
	 * displays run their own countdown), so the selection clocks must stay off TimerChanged.
	 */
	setTimerRemainingLocal(seconds: number): void {
		this.state.timer.secondsRemaining = seconds;
		this.touch();
	}

	/** Mirror the current game phase into state (no broadcast; emitGamePhase sends the frame). */
	setTimerPhase(phase: MatchPhase): void {
		if (this.state.timer.phase === phase) return;
		this.state.timer.phase = phase;
		this.touch();
	}

	/** Mark the match/pick clock running or stopped so the control UI shows the right status. */
	setTimerRunning(running: boolean): void {
		if (this.state.timer.running === running) return;
		this.state.timer.running = running;
		this.touch();
	}

	/** Refresh the connected-hub-client counts shown in the control UI. */
	setClientCounts(counts: HubClientCounts): void {
		this.state.clients = counts;
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

	/** Immediately push a FieldMonitorDataChanged frame (outside the 1 Hz heartbeat) so a consumer's
	 * team lineup reflects the current stations before a screen switch. Carries the same frames the
	 * heartbeat streams; used when the test sequence jumps to a screen without a real prestart gap. */
	pushFieldMonitor(): void {
		this.emit("fieldMonitorPush", this.monitorFrames());
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

	/** Persist a committed result snapshot (the wire DTO, built at commit time). */
	storeResult(key: string, result: StoredMatchResult): void {
		this.state.results[key] = result;
		this.touch();
	}

	getStoredResult(level: TournamentLevel, matchNumber: number): StoredMatchResult | undefined {
		return this.state.results[this.resultKey(level, matchNumber)];
	}

	/** Clear finals/overtime state (matches 14-19) so a test can stage a fresh best-of-3 series;
	 *  seeded alliances are kept. Resets the playoff match slots, their schedule rows (back to
	 *  unplayed, scores + start stamp cleared), and purges their stored results, so
	 *  GetCurrentSchedule / GetResults / the high-score comparison can't see stale finals. */
	resetFinalsSeries(): void {
		for (const m of Object.values(this.state.playoffMatches)) {
			if (m.matchNumber >= 14) {
				m.winner = "None";
				m.complete = false;
				m.redScore = 0;
				m.blueScore = 0;
			}
		}
		for (const e of this.state.schedule) {
			if (e.level === "Playoff" && e.matchNumber >= 14) {
				e.status = "Pending";
				e.finalScoreRed = null;
				e.finalScoreBlue = null;
				e.actualStartTime = null;
			}
		}
		for (let n = 14; n <= 19; n++) {
			delete this.state.results[this.resultKey("Playoff", n)];
		}
		this.touch();
	}

	// #endregion

	// #region cards

	/** Give a team a Yellow or Red card (shows in preview/play as carryingCard, and in results
	 * with the real Yellow/Red status). */
	setTeamCard(teamNumber: number, status: "Yellow" | "Red"): void {
		this.state.cards[teamNumber] = status;
		this.touch();
	}

	/** Drop all cards. The test sequence calls this before each step so cards never leak between steps. */
	clearCards(): void {
		if (Object.keys(this.state.cards).length === 0) return;
		this.state.cards = {};
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
		// A tied bracket/overtime match (every criterion tied) is replayed, not advanced. A tied
		// finals match (14-16, no tiebreakers) stands as a played tie: the series just continues.
		m.complete = m.winner !== "None" || !usesTiebreakers(matchNumber);
		applyAdvance(this.state.playoffMatches, matchNumber);
		if (matchNumber >= 14) maybeScheduleOvertime(this.state.playoffMatches);
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
		const existing = new Map(
			this.state.schedule.filter((e) => e.level === "Playoff").map((e) => [e.matchNumber, e]),
		);
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
				// Keep the stamp markMatchStarted wrote for a match that already started/played.
				actualStartTime: existing.get(matchNumber)?.actualStartTime ?? null,
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
		// Include the three overtime matches (17-19) too so they can be selected/revealed
		// (e.g. the test sequence). Series progression still keys off FINALS_MATCHES (14-16).
		for (const f of FINALS) add(f.matchNumber, f.longName);
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

	// #region pick clock

	private pickClockInterval: ReturnType<typeof setInterval> | null = null;

	/**
	 * Run the shown timer down from `seconds`, ticking it over the wire as
	 * TimerChanged {Timer: "AllianceSelectionTimer"} at 1 Hz. Real FMS ticks BOTH the alliance-selection
	 * break clocks AND the per-pick clock this way (Rainbow Rumble capture: the AllianceSelectionTimer
	 * value counts the pick down and is pause-aware), so displays read the wire value directly rather
	 * than running a local countdown off the AudienceAllianceTimer trigger.
	 */
	private startPickClock(seconds: number, onWire: boolean, onDone?: () => void): void {
		this.stopPickClock();
		let remaining = seconds;
		this.setTimerRemainingLocal(remaining);
		if (onWire) this.emit("allianceSelectionTimerChanged", remaining);
		this.pickClockInterval = setInterval(() => {
			remaining--;
			this.setTimerRemainingLocal(remaining);
			if (onWire) this.emit("allianceSelectionTimerChanged", remaining);
			if (remaining <= 0) {
				this.stopPickClock();
				onDone?.();
			}
		}, 1000);
	}

	private stopPickClock(): void {
		if (this.pickClockInterval) {
			clearInterval(this.pickClockInterval);
			this.pickClockInterval = null;
		}
	}

	/** Stop the pick/break clock without touching selection state (match play resuming). */
	stopSelectionClock(): void {
		this.stopPickClock();
	}

	/** Alliances get 45 seconds for first-round picks and 90 seconds for later rounds. */
	private pickSecondsFor(round: number): number {
		return round === 1 ? 45 : 90;
	}

	/**
	 * (Re)start the pick clock for whatever slot is on the clock. Moving from round 1 into round 2
	 * first runs the 2-minute between-rounds break, then arms the 90-second pick clock. Each clock
	 * announces itself via AudienceAllianceTimer so displays can label pick vs break time.
	 */
	private armPickClock(prevRound: number | null): void {
		const slot = this.currentAllianceSlot();
		if (!slot) {
			this.stopPickClock();
			this.setTimerRemainingLocal(0);
			return;
		}
		const roundName = slot.round === 1 ? "Round1" : slot.round === 2 ? "Round2" : "Backup";
		if (prevRound === 1 && slot.round === 2) {
			// The capture labels the between-rounds break with the round that just ended.
			this.pulseAllianceButton("Break2Button");
			this.startAllianceTimer("Round1", "TwoMinuteBreak");
			this.startPickClock(120, true, () => {
				this.pulseAllianceButton("StartButton");
				this.startAllianceTimer(roundName, "PickTimer");
				this.startPickClock(this.pickSecondsFor(slot.round), true);
			});
		} else {
			this.pulseAllianceButton("StartButton");
			this.startAllianceTimer(roundName, "PickTimer");
			this.startPickClock(this.pickSecondsFor(slot.round), true);
		}
	}

	/**
	 * PLC_ALLIANCESELECTION_STATUS_Changed: a physical alliance-selection console button is momentary,
	 * so the matching boolean pulses true then immediately false (capture: StartButton precedes each
	 * pick clock, Break2/Break8 start the breaks). Reproduce the pulse so the wire matches a real field.
	 */
	private pulseAllianceButton(
		button: "StartButton" | "PauseButton" | "ResetButton" | "Break2Button" | "Break8Button",
	): void {
		const base = { StartButton: false, PauseButton: false, ResetButton: false, Break2Button: false, Break8Button: false };
		this.emit("allianceSelectionButton", { AllianceselectionStatusChanged: button, ...base, [button]: true });
		setTimeout(() => {
			this.emit("allianceSelectionButton", { AllianceselectionStatusChanged: button, ...base });
		}, 120);
	}

	/**
	 * Mimic the FMS wizard's "Break Timer" button (2026-07-19 log): announce an EightMinuteBreak,
	 * tick the 480s clock over the wire, and switch the video option to TimerBug - that
	 * combination IS the selection-break screen on a real field.
	 */
	allianceBreak(): void {
		const slot = this.currentAllianceSlot();
		const roundName = !slot ? "Round1" : slot.round === 1 ? "Round1" : slot.round === 2 ? "Round2" : "Backup";
		this.pulseAllianceButton("Break8Button");
		this.startAllianceTimer(roundName, "EightMinuteBreak");
		this.startPickClock(480, true);
		this.setVideoSwitch("TimerBug");
	}

	// #endregion

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

	/**
	 * Mark every team still in line for a captaincy: the K highest-ranked available teams, where K
	 * is the number of alliances whose captain hasn't been revealed yet. Picking one of these off
	 * the board pulls the next-ranked team (e.g. rank 9) into the potential-captain set.
	 */
	private updatePotentialCaptains(): void {
		const sel = this.state.allianceSelection;
		const remaining = sel?.active
			? this.state.alliances.filter((a) => a.captainTeamNumber == null).length
			: this.state.alliances.length;
		let marked = 0;
		for (const r of this.state.rankings) {
			// Declined teams stay in the captain line (they just can't be picked), so they
			// keep their inPotentialCaptainPosition slot.
			const available = r.pickStatus === "None";
			r.inPotentialCaptainPosition = available && marked < remaining;
			if (r.inPotentialCaptainPosition) marked++;
		}
	}

	/** The slot (alliance + round) currently on the clock, or null when selection is finished. */
	currentAllianceSlot(): { alliance: number; round: number } | null {
		const sel = this.state.allianceSelection;
		if (!sel?.active) return null;
		return sel.order[sel.pickIndex] ?? null;
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

	/**
	 * Begin alliance selection: only Alliance 1's captain is seeded. The remaining captains are
	 * revealed one at a time as round 1 progresses (each alliance's captain is the highest-ranked
	 * team still available when it comes on the clock), matching the real ceremony.
	 */
	allianceStart(): void {
		const first = this.state.rankings[0]?.teamNumber ?? null;
		for (const r of this.state.rankings) {
			r.isDeclined = false;
			r.pickStatus = r.teamNumber === first ? "Captain" : "None";
		}
		for (const al of this.state.alliances) {
			al.firstRoundTeamNumber = null;
			al.firstRoundTeamNameShort = "";
			al.secondRoundTeamNumber = null;
			al.secondRoundTeamNameShort = "";
			al.alternateTeamNumber = null;
			al.alternateTeamNameShort = "";
		}
		this.state.allianceSelection = { active: true, order: this.allianceOrder(), pickIndex: 0, history: [] };
		for (const al of this.state.alliances) {
			this.setCaptain(al, al.allianceNumber === 1 ? first : null);
		}
		this.updatePotentialCaptains();
		this.armPickClock(null);
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

		const entry: { alliance: number; round: number; teamNumber: number; captainsBefore?: (number | null)[] } = {
			alliance: slot.alliance,
			round: slot.round,
			teamNumber,
		};
		// Round-1 picks reveal the next alliance's captain; snapshot so undo can un-reveal.
		if (slot.round === 1) entry.captainsBefore = this.state.alliances.map((a) => a.captainTeamNumber);
		this.setAllianceSlot(slot.alliance, slot.round, teamNumber);
		rec.pickStatus = "Picked";
		sel.history.push(entry);
		sel.pickIndex++;
		this.revealCaptainForCurrentSlot();
		this.updatePotentialCaptains();
		this.armPickClock(slot.round);
		this.emitAllianceSlot(slot.alliance, slot.round, teamNumber);
		this.touch();
		return true;
	}

	private setCaptain(al: FMSAllianceSelection, teamNumber: number | null): void {
		al.captainTeamNumber = teamNumber;
		al.captainTeamNameShort = this.teamName(teamNumber);
		this.emit("allianceSelectionChanged", {
			AllianceNumber: al.allianceNumber,
			AllianceParticipant: "Captain",
			TeamNumber: teamNumber,
		});
	}

	/**
	 * During round 1, the alliance coming on the clock gets its captain assigned the moment its
	 * turn starts: the highest-ranked team still available. No-op outside round 1 or when the
	 * alliance already has its captain.
	 */
	private revealCaptainForCurrentSlot(): void {
		const slot = this.currentAllianceSlot();
		if (!slot || slot.round !== 1) return;
		const al = this.state.alliances.find((a) => a.allianceNumber === slot.alliance);
		if (!al || al.captainTeamNumber != null) return;
		// Declining only blocks being picked; a declined team still takes its captaincy in turn.
		const next = this.state.rankings.find((r) => r.pickStatus === "None");
		if (!next) return;
		next.pickStatus = "Captain";
		this.setCaptain(al, next.teamNumber);
		this.updatePotentialCaptains();
	}

	/** Put every alliance's captain back to a pre-captain-pick snapshot (for undo). */
	private restoreCaptains(captains: (number | null)[]): void {
		this.state.alliances.forEach((al, i) => this.setCaptain(al, captains[i] ?? null));
		const captainSet = new Set(captains.filter((n): n is number => n != null));
		for (const r of this.state.rankings) {
			if (captainSet.has(r.teamNumber)) r.pickStatus = "Captain";
			else if (r.pickStatus === "Captain") r.pickStatus = "None";
		}
	}

	/**
	 * Skip the current slot (the alliance failed to pick in time). The next alliance in order picks,
	 * then the skipped alliance immediately comes back on the clock: its slot is re-inserted right
	 * after the next one, so it keeps returning until it picks (or is skipped again).
	 */
	allianceSkip(): boolean {
		const sel = this.state.allianceSelection;
		const slot = this.currentAllianceSlot();
		if (!sel?.active || !slot) return false;
		sel.history.push({
			alliance: slot.alliance,
			round: slot.round,
			teamNumber: 0,
			...(slot.round === 1 ? { captainsBefore: this.state.alliances.map((a) => a.captainTeamNumber) } : {}),
		});
		sel.order.splice(Math.min(sel.pickIndex + 2, sel.order.length), 0, { ...slot });
		sel.pickIndex++;
		this.revealCaptainForCurrentSlot();
		this.armPickClock(slot.round);
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
		} else {
			// Undoing a skip: remove the retry slot the skip inserted (two ahead, clamped to the
			// end of the order for a skip on the final slot).
			const at = Math.min(sel.pickIndex + 2, sel.order.length - 1);
			const retry = sel.order[at];
			if (retry && retry.alliance === last.alliance && retry.round === last.round) sel.order.splice(at, 1);
		}
		// A round-1 pick revealed the next captain; put every captain back where it was.
		if (last.captainsBefore) this.restoreCaptains(last.captainsBefore);
		// Restart the clock for the slot we backed up to (plain restart, no break replay).
		this.armPickClock(null);
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

	/**
	 * Abort the ceremony entirely: clear every pick, captain, and decline and leave selection
	 * inactive, so the size can be changed and the ceremony restarted from scratch.
	 */
	allianceReset(): void {
		this.stopPickClock();
		this.setTimerRemainingLocal(0);
		this.state.allianceSelection = null;
		for (const r of this.state.rankings) {
			r.isDeclined = false;
			r.pickStatus = "None";
		}
		for (const al of this.state.alliances) {
			al.firstRoundTeamNumber = null;
			al.firstRoundTeamNameShort = "";
			al.secondRoundTeamNumber = null;
			al.secondRoundTeamNameShort = "";
			al.alternateTeamNumber = null;
			al.alternateTeamNameShort = "";
		}
		for (const al of this.state.alliances) {
			this.setCaptain(al, null);
		}
		this.updatePotentialCaptains();
		this.touch();
	}

	/** Finalize alliance selection: build the bracket roster, seed round 1, and enter the playoffs. */
	allianceSave(): void {
		this.stopPickClock();
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
