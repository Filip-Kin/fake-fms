import { type FMSLogFrame, type MatchPhase, STATION_KEYS, type StationKey, wireMatchNumber } from "shared";
import { createLogState, generateStationLog, hashSeed, type LogState, stepLogFrame } from "./log-generator";
import { emitGamePhase } from "./phase";
import { usesTiebreakers } from "./playoff";
import { AUTO_SECONDS, teleopSeconds } from "./timing";
import { buildMatchResult } from "../rest/projectors";
import type { FmsStore } from "../state/store";

// Real 2026 "Rebuilt" clock (confirmed from a ground-truth SignalR capture): auto 20s, teleop
// 140s = Coop(10) + Shift1..4(25 each) + Endgame(30). Warnings fire at teleop remaining 90 / 30.
const WARNING_TELEOP_REMAINING = 90; // matchtimerwarning2
const ENDGAME_WARNING_REMAINING = 30; // matchtimerwarning1 (start of endgame)
const TRANSITION_SECONDS = 3; // auto->teleop pause; clock holds at the teleop length

/**
 * Drives the match lifecycle: the pre-match steps (prestart -> preview -> ready -> start)
 * are individually invokable for manual control, while the in-match timeline (auto ->
 * transition -> teleop -> commit) runs automatically on a 1s timer once the match starts,
 * just like a real field. Autopilot chains the pre-match steps and post-results advance.
 */
export class MatchController {
	private store: FmsStore;
	private ticker: ReturnType<typeof setInterval> | null = null;
	/** Pre-generated per-robot logs replayed through the field monitor while the match runs. */
	private replay: Map<StationKey, FMSLogFrame[]> | null = null;
	/** Pre-match idle telemetry: smooth-voltage frames streamed while robots sit connected, disabled. */
	private idleTicker: ReturnType<typeof setInterval> | null = null;
	private idleStates: Map<StationKey, LogState> | null = null;
	private idleElapsed = 0;
	/**
	 * The alliance holding the goal "advantage" this match (real 2026 rule: whoever scores more
	 * fuel in auto, or a coin flip on a tie). Decided once at teleop start. The advantage alliance
	 * is active in the even shifts (2 & 4) and inactive in the odd shifts (1 & 3).
	 */
	private advantageIsBlue = false;

	constructor(store: FmsStore) {
		this.store = store;
	}

	// #region pre-match idle telemetry

	/**
	 * Stream smooth, disabled telemetry for the connected robots each second until the match starts,
	 * so the field monitor shows steady ~12.8 V (and low ping) before the robots are enabled. Stopped
	 * at match start, where the jumpy enabled telemetry takes over.
	 */
	private startIdleStream(): void {
		this.stopIdleStream();
		if (!this.store.getState().autoplay.replayLogs) return;
		const matchId = this.currentEntry()?.fmsMatchId ?? "idle";
		this.idleStates = new Map();
		this.idleElapsed = 0;
		for (const key of STATION_KEYS) {
			const s = this.store.getState().stations[key];
			this.idleStates.set(key, createLogState(hashSeed(`${matchId}:${s.alliance}:Station${s.station}:idle`)));
		}
		const tick = () => {
			if (!this.idleStates) return;
			for (const key of STATION_KEYS) {
				const st = this.idleStates.get(key);
				if (!st) continue;
				const frame = stepLogFrame(st, {
					elapsed: this.idleElapsed,
					enabled: false,
					auto: false,
					matchTimeBase: AUTO_SECONDS,
					matchTime: AUTO_SECONDS,
					faults: [],
					startMs: Date.now() - this.idleElapsed * 1000,
				});
				this.store.setStationFromLog(key, frame);
			}
			this.store.broadcastStations();
			this.idleElapsed += 1;
		};
		tick();
		this.idleTicker = setInterval(tick, 1000);
	}

	private stopIdleStream(): void {
		if (this.idleTicker) {
			clearInterval(this.idleTicker);
			this.idleTicker = null;
		}
		this.idleStates = null;
	}

	private currentEntry() {
		const { current, schedule } = this.store.getState();
		return schedule.find((e) => e.matchNumber === current.matchNumber && e.level === current.level);
	}

	// #endregion

	// #region pre-match steps (each is an explicit, manually-triggered transition)

	/** Load the current match onto the field and begin the prestart sequence. */
	prestart(): void {
		this.stopTicker();
		this.stopIdleStream();
		// A leftover selection pick/break clock must not keep ticking into match play.
		this.store.stopSelectionClock();
		this.replay = null;
		const state = this.store.getState();
		const entry = state.schedule.find(
			(e) => e.matchNumber === state.current.matchNumber && e.level === state.current.level,
		);
		if (entry) this.store.loadStationsFromMatch(entry.red, entry.blue);
		this.store.resetScores();
		this.store.resetStations();
		// In replay mode, show the robots linked during the pre-match (real fields connect at prestart);
		// the generated log then drives their connection states once the match runs. The idle stream
		// keeps their voltage smooth and live until the match starts.
		if (state.autoplay.replayLogs) {
			this.store.connectStations();
			this.startIdleStream();
		}
		// Clear the PLC ready/done flags for the fresh match.
		this.store.setPlcStatus({ RefDone: false, ScoreReady: false, RefReady: false, RefUnderReview: false });
		this.store.setMatchState("Prestarting");
		// Real FMS clears the goals here, not at the previous match's end: prestart emits a None
		// frame with both goals inactive.
		this.emitPhase("None", 0, { redGoal: false, blueGoal: false });
		// Prestart completes -> WaitingForMatchPreview. Real FMS does NOT switch the audience to the
		// preview here; showing the preview is a separate operator action (showMatchPreview).
		setTimeout(() => {
			this.store.setMatchState("WaitingForMatchPreview");
		}, 500);
	}

	/** Show the upcoming-match preview on the audience display (the explicit step after prestart). */
	showMatchPreview(): void {
		this.store.setMatchState("WaitingForSetAudience");
		this.store.setVideoSwitch("MatchPreview");
	}

	/** Set the audience display to live video+score; the field becomes "match not ready". */
	setAudience(): void {
		this.store.setMatchState("WaitingForMatchReady"); // MATCH_NOT_READY
		this.store.setVideoSwitch("VideoAndScore");
		// Real FMS pre-loads the match timer to the auto duration here (it sits at 20 until start).
		this.store.setTimerRemaining(AUTO_SECONDS);
	}

	/** Field/refs ready -> "match ready", scorekeeper can start. */
	armMatch(): void {
		this.store.setMatchState("WaitingForMatchStart"); // MATCH_READY
	}

	// #endregion

	// #region in-match timeline

	startMatch(): void {
		const state = this.store.getState();
		// Robots are enabled now: stop the smooth idle stream so the jumpy match telemetry takes over.
		this.stopIdleStream();
		// Stamp the start time, then (per the autoplay switches) roll random faults and/or build the
		// log buffer to replay through the field monitor.
		this.store.markMatchStarted();
		const entry = state.schedule.find(
			(e) => e.matchNumber === state.current.matchNumber && e.level === state.current.level,
		);
		if (entry && state.autoplay.autoFaults) {
			this.store.generateMatchFaults(entry.fmsMatchId, AUTO_SECONDS, teleopSeconds(state.gameConfig));
		}
		if (entry && state.autoplay.replayLogs) this.buildReplay(entry.fmsMatchId);
		else this.replay = null;
		// Real FMS transmits game-specific data (a brief GameSpecificData state) before auto begins.
		this.store.setMatchState("GameSpecificData");
		this.runAuto();
	}

	/** Generate the six robots' logs for the match so they can be replayed through the field monitor. */
	private buildReplay(matchId: string): void {
		const state = this.store.getState();
		const teleop = teleopSeconds(state.gameConfig);
		const entry = state.schedule.find((e) => e.fmsMatchId === matchId);
		const startMs = entry?.actualStartTime ? Date.parse(entry.actualStartTime) : undefined;
		this.replay = new Map();
		for (const key of STATION_KEYS) {
			const s = state.stations[key];
			// Same seed + faults + timings the GetLog endpoint uses, so the live replay and the
			// post-match log FTA-Buddy pulls are identical.
			const seed = hashSeed(`${matchId}:${s.alliance}:Station${s.station}`);
			this.replay.set(
				key,
				generateStationLog({
					seed,
					faults: this.store.getLogFaults(matchId, key),
					autoSeconds: AUTO_SECONDS,
					teleopSeconds: teleop,
					transitionSeconds: 0,
					startTimeMs: startMs,
				}),
			);
		}
		this.applyReplayFrame(0);
	}

	/** Push the log frame at the given match-elapsed second onto the six stations. */
	private applyReplayFrame(elapsed: number): void {
		if (!this.replay) return;
		const idx = Math.round(elapsed * 2); // logs are 2 Hz
		for (const key of STATION_KEYS) {
			const frames = this.replay.get(key);
			const f = frames?.[Math.min(idx, frames.length - 1)];
			if (f) this.store.setStationFromLog(key, f);
		}
		this.store.broadcastStations();
	}

	private runAuto(): void {
		this.store.setMatchState("MatchAuto");
		this.store.broadcastStations(); // robots now enabled+auto
		// Real FMS streams the game-specific Auto phase every second, counting the phase clock down.
		this.emitPhase("Auto", AUTO_SECONDS, { redGoal: true, blueGoal: true });
		this.countdown(
			"MatchAuto",
			AUTO_SECONDS,
			() => this.runTransition(),
			(remaining) => {
				this.emitPhase("Auto", remaining, { redGoal: true, blueGoal: true });
				this.applyReplayFrame(AUTO_SECONDS - remaining);
			},
		);
	}

	private runTransition(): void {
		// Real 2026 sequence (2026-07-19 ground-truth log, qual 1): auto hits 0, the match clock
		// immediately preloads to the full teleop length and HOLDS there while MatchTransitionTimer
		// ticks 3..0 at 1 Hz; one Auto phase frame with 0s phase time goes out at the start of the
		// transition, and teleop begins when the transition clock expires.
		this.store.setMatchState("MatchTransition");
		this.store.broadcastStations();
		this.store.setTimerRemaining(this.teleopLength());
		this.emitPhase("Auto", 0, { redGoal: true, blueGoal: true });
		this.stopTicker();
		let remaining = TRANSITION_SECONDS;
		this.store.emit("transitionTimerChanged", remaining);
		this.ticker = setInterval(() => {
			if (this.store.getState().current.matchState !== "MatchTransition") {
				this.stopTicker();
				return;
			}
			remaining -= 1;
			this.store.emit("transitionTimerChanged", remaining);
			if (remaining <= 0) {
				this.stopTicker();
				this.runTeleop();
			}
		}, 1000);
	}

	private runTeleop(): void {
		this.store.setMatchState("MatchTeleop");
		this.store.broadcastStations();
		this.decideAdvantage();
		const length = this.teleopLength();
		// Emit the opening (elapsed 0) phase frame; the countdown's onTick covers the rest each second.
		this.emitTeleopPhase(0);
		this.countdown(
			"MatchTeleop",
			length,
			() => this.endMatch(),
			(remaining) => {
				if (remaining === WARNING_TELEOP_REMAINING) this.store.emit("timerWarning", 2);
				if (remaining === ENDGAME_WARNING_REMAINING) this.store.emit("timerWarning", 1);
				this.emitTeleopPhase(length - remaining);
				this.applyReplayFrame(AUTO_SECONDS + (length - remaining));
			},
		);
	}

	private endMatch(): void {
		this.stopTicker();
		this.store.setMatchState("WaitingForCommit");
		this.store.broadcastStations(); // robots disabled
		// Real FMS (2026-07-19 log): the post-match None frame keeps BOTH goals active; they only
		// clear in the None frame sent at the next match's prestart.
		this.emitPhase("None", 0, { redGoal: true, blueGoal: true });
	}

	/** Commit the refs' scores. Locks the result; does NOT yet show it to the audience. */
	commitScores(): void {
		const state = this.store.getState();
		// Real FMS reports refs done + score ready on the PLC when scores are committed.
		this.store.setPlcStatus({ RefDone: true, ScoreReady: true, RefReady: false });
		this.store.setMatchState("WaitingForPostResults");

		// Persist the result: qual results re-rank the field; playoff results advance the bracket.
		const module = this.store.getGameModule();
		const red = module.recompute(state.score.red);
		const blue = module.recompute(state.score.blue);
		const redTotal = Number(red.totalPoints ?? 0);
		const blueTotal = Number(blue.totalPoints ?? 0);
		const { level, matchNumber } = state.current;
		if (level === "Qualification") {
			this.store.commitQualResult(matchNumber, redTotal, blueTotal);
		} else if (level === "Playoff") {
			// Resolve the winner through the season's tiebreaker criteria so the bracket advances the
			// same alliance the audience-display result shows (and replays a true tie). Finals 14-16
			// do NOT tiebreak: a points tie stands (the series continues, to overtime if needed).
			const winner = usesTiebreakers(matchNumber)
				? module.decidePlayoffMatch(red, blue).winner
				: redTotal > blueTotal
					? "Red"
					: blueTotal > redTotal
						? "Blue"
						: null;
			this.store.commitPlayoffResult(matchNumber, redTotal, blueTotal, winner);
		}

		// Snapshot the committed wire DTO (after the rank/bracket update, so teamRankChange,
		// advancement, seriesWins and the isHighScore flag are frozen at commit time). Fetching this
		// match later serves the snapshot instead of re-synthesizing from whatever score is live.
		const snapshot = buildMatchResult(this.store, level, matchNumber);
		if (snapshot === null) {
			console.error(`[match] commit for ${level} ${matchNumber} has no schedule entry; result not stored`);
		} else {
			this.store.storeResult(this.store.resultKey(level, matchNumber), snapshot);
		}

		const entry = state.schedule.find((e) => e.matchNumber === matchNumber && e.level === level);
		if (entry) this.store.emit("matchCommitted", entry.fmsMatchId);
	}

	/** Post the committed results: switch the audience to the results screen and announce them. */
	postResults(): void {
		const state = this.store.getState();
		this.store.setVideoSwitch("MatchResult");
		this.store.emit("showResults", {
			// Wire numbering: real FMS announces finals with their internal numbers (14-19).
			MatchNumber: wireMatchNumber(state.current.level, state.current.matchNumber),
			TournamentLevel: state.current.level,
			IsRepost: false,
			IsDebug: false,
		});
		const entry = state.schedule.find(
			(e) => e.matchNumber === state.current.matchNumber && e.level === state.current.level,
		);
		if (entry) this.store.emit("matchPosted", entry.fmsMatchId);
	}

	abort(): void {
		this.stopTicker();
		this.stopIdleStream();
		this.replay = null;
		this.store.setMatchState("MatchCancelled");
		this.store.broadcastStations();
	}

	// #endregion

	// #region timer helpers

	/** Emit a phase frame through the shared helper (named goals, so no red/blue swap is possible). */
	private emitPhase(phase: MatchPhase, seconds: number, goals: { redGoal: boolean; blueGoal: boolean }): void {
		emitGamePhase(this.store, { phase, seconds, redGoal: goals.redGoal, blueGoal: goals.blueGoal });
	}

	/** Total teleop seconds = Coop + four shifts + endgame (from game config; real 2026 = 140). */
	private teleopLength(): number {
		return teleopSeconds(this.store.getState().gameConfig);
	}

	/**
	 * Decide the alliance advantage from auto fuel (more auto fuel wins; a tie is a coin flip) and
	 * publish it on both alliance scores so the audience display can follow it. Called once at
	 * teleop start; emitTeleopPhase then drives the shift goals from it.
	 */
	private decideAdvantage(): void {
		const score = this.store.getState().score;
		const redAutoFuel = Number(score.red.autoFuelPoints) || 0;
		const blueAutoFuel = Number(score.blue.autoFuelPoints) || 0;
		this.advantageIsBlue =
			blueAutoFuel === redAutoFuel ? Math.random() < 0.5 : blueAutoFuel > redAutoFuel;
		this.store.setScoreField("Blue", "advantageAchieved", this.advantageIsBlue);
		this.store.setScoreField("Red", "advantageAchieved", !this.advantageIsBlue);
	}

	/**
	 * Map teleop elapsed seconds to the real 2026 phase sequence and emit it: Coop (both goals) ->
	 * Shift1..4 (the active alliance alternates each shift) -> Endgame (both goals). The advantage
	 * alliance (decideAdvantage) is active in the even shifts and inactive in the odd shifts.
	 * CurrentPhaseTimeSeconds counts down within the current phase, matching the real FMS stream.
	 */
	private emitTeleopPhase(elapsed: number): void {
		const cfg = this.store.getState().gameConfig;
		const c0 = cfg.coopShiftLengthSeconds;
		const c1 = c0 + cfg.shift1LengthSeconds;
		const c2 = c1 + cfg.shift2LengthSeconds;
		const c3 = c2 + cfg.shift3LengthSeconds;
		const c4 = c3 + cfg.shift4LengthSeconds;
		const c5 = c4 + cfg.endgameLengthSeconds;
		// Odd shifts (1, 3): the non-advantage alliance is active. Even shifts (2, 4): the
		// advantage alliance is active.
		const both = { redGoal: true, blueGoal: true };
		const odd = { redGoal: this.advantageIsBlue, blueGoal: !this.advantageIsBlue };
		const even = { redGoal: !this.advantageIsBlue, blueGoal: this.advantageIsBlue };
		let phase: MatchPhase;
		let end: number;
		let goals: { redGoal: boolean; blueGoal: boolean };
		if (elapsed < c0) {
			phase = "Coop";
			end = c0;
			goals = both;
		} else if (elapsed < c1) {
			phase = "Shift1";
			end = c1;
			goals = odd;
		} else if (elapsed < c2) {
			phase = "Shift2";
			end = c2;
			goals = even;
		} else if (elapsed < c3) {
			phase = "Shift3";
			end = c3;
			goals = odd;
		} else if (elapsed < c4) {
			phase = "Shift4";
			end = c4;
			goals = even;
		} else {
			phase = "Endgame";
			end = c5;
			goals = both;
		}
		this.emitPhase(phase, end - elapsed, goals);
	}

	private countdown(
		duringState: string,
		seconds: number,
		onDone: () => void,
		onTick?: (remaining: number) => void,
	): void {
		this.stopTicker();
		let remaining = seconds;
		this.store.setTimerRunning(true);
		this.store.setTimerRemaining(remaining);
		this.ticker = setInterval(() => {
			// Abort the loop if a manual transition changed the state out from under us.
			if (this.store.getState().current.matchState !== duringState) {
				this.stopTicker();
				return;
			}
			remaining -= 1;
			this.store.setTimerRemaining(remaining);
			onTick?.(remaining);
			if (remaining <= 0) {
				this.stopTicker();
				onDone();
			}
		}, 1000);
	}

	private stopTicker(): void {
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = null;
		}
		this.store.setTimerRunning(false);
	}

	// #endregion
}
