import type { GameSpecificMessage, MatchPhase, TournamentLevel } from "shared";
import type { FmsStore } from "../state/store";

// Real 2026 "Rebuilt" clock (confirmed from a ground-truth SignalR capture): auto 20s, teleop
// 140s = Coop(10) + Shift1..4(25 each) + Endgame(30). Warnings fire at teleop remaining 90 / 30.
const AUTO_SECONDS = 20;
const WARNING_TELEOP_REMAINING = 90; // matchtimerwarning2
const ENDGAME_WARNING_REMAINING = 30; // matchtimerwarning1 (start of endgame)

/**
 * Drives the match lifecycle: the pre-match steps (prestart -> preview -> ready -> start)
 * are individually invokable for manual control, while the in-match timeline (auto ->
 * transition -> teleop -> commit) runs automatically on a 1s timer once the match starts,
 * just like a real field. Autopilot chains the pre-match steps and post-results advance.
 */
export class MatchController {
	private store: FmsStore;
	private ticker: ReturnType<typeof setInterval> | null = null;

	constructor(store: FmsStore) {
		this.store = store;
	}

	// #region pre-match steps (each is an explicit, manually-triggered transition)

	/** Load the current match onto the field and begin the prestart sequence. */
	prestart(): void {
		this.stopTicker();
		const state = this.store.getState();
		const entry = state.schedule.find(
			(e) => e.matchNumber === state.current.matchNumber && e.level === state.current.level,
		);
		if (entry) this.store.loadStationsFromMatch(entry.red, entry.blue);
		this.store.resetScores();
		this.store.resetStations();
		// Clear the PLC ready/done flags for the fresh match.
		this.store.setPlcStatus({ RefDone: false, ScoreReady: false, RefReady: false, RefUnderReview: false });
		this.store.setMatchState("Prestarting");
		// Prestart completes -> waiting for the operator to set the audience / preview.
		setTimeout(() => {
			this.store.setMatchState("WaitingForMatchPreview");
			this.store.setVideoSwitch("MatchPreview");
		}, 500);
	}

	/** Preview shown / audience set -> field becomes "match not ready". */
	setAudience(): void {
		// Real FMS passes through WaitingForSetAudience before the field becomes "not ready".
		this.store.setMatchState("WaitingForSetAudience");
		this.store.setVideoSwitch("VideoAndScore");
		this.store.setMatchState("WaitingForMatchReady"); // MATCH_NOT_READY
	}

	/** Field/refs ready -> "match ready", scorekeeper can start. */
	armMatch(): void {
		this.store.setMatchState("WaitingForMatchStart"); // MATCH_READY
	}

	// #endregion

	// #region in-match timeline

	startMatch(): void {
		// Real FMS transmits game-specific data (a brief GameSpecificData state) before auto begins.
		this.store.setMatchState("GameSpecificData");
		this.runAuto();
	}

	private runAuto(): void {
		this.store.setMatchState("MatchAuto");
		this.store.broadcastStations(); // robots now enabled+auto
		// Real FMS streams the game-specific Auto phase every second, counting the phase clock down.
		this.emitPhase("Auto", AUTO_SECONDS, true, true);
		this.countdown(
			"MatchAuto",
			AUTO_SECONDS,
			() => this.runTransition(),
			(remaining) => this.emitPhase("Auto", remaining, true, true),
		);
	}

	private runTransition(): void {
		// Real 2026 has no auto->teleop transition pause (the match clock jumps straight from auto
		// 0 to teleop 140) and emits no transition game-phase, so this is instantaneous.
		this.store.setMatchState("MatchTransition");
		this.store.broadcastStations();
		this.runTeleop();
	}

	private runTeleop(): void {
		this.store.setMatchState("MatchTeleop");
		this.store.broadcastStations();
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
			},
		);
	}

	private endMatch(): void {
		this.stopTicker();
		this.store.setMatchState("WaitingForCommit");
		this.store.broadcastStations(); // robots disabled
		// Back to the idle "None" phase with both goals inactive (matches the real post-match stream).
		this.emitPhase("None", 0, false, false);
	}

	/** Commit the refs' scores and reveal results to the audience. */
	commitScores(): void {
		const state = this.store.getState();
		// Real FMS reports refs done + score ready on the PLC just before results go up.
		this.store.setPlcStatus({ RefDone: true, ScoreReady: true, RefReady: false });
		this.store.setMatchState("WaitingForPostResults");
		this.store.setVideoSwitch("MatchResults");
		this.store.emit("showResults", {
			MatchNumber: state.current.matchNumber,
			TournamentLevel: state.current.level,
			IsRepost: false,
			IsDebug: false,
		});
		// Mark the match committed + posted (real FMS fires both with the fmsMatchId).
		const entry = state.schedule.find(
			(e) => e.matchNumber === state.current.matchNumber && e.level === state.current.level,
		);
		if (entry) this.store.emit("matchCommitted", entry.fmsMatchId);
	}

	abort(): void {
		this.stopTicker();
		this.store.setMatchState("MatchCancelled");
		this.store.broadcastStations();
	}

	advanceToNextMatch(): void {
		const state = this.store.getState();
		const next = state.current.matchNumber + 1;
		this.store.setCurrentMatch(next, 1, state.current.level);
		this.store.setMatchState("WaitingForPrestart");
		this.store.setVideoSwitch("VideoOnly");
	}

	// #endregion

	// #region timer helpers

	private emitPhase(phase: MatchPhase, seconds: number, blueGoal: boolean, redGoal: boolean): void {
		this.store.getState().timer.phase = phase;
		const msg: GameSpecificMessage = {
			MatchPhase: phase,
			BlueAllianceGoalActive: blueGoal,
			RedAllianceGoalActive: redGoal,
			CurrentPhaseTimeSeconds: seconds,
			MessageType: "MatchPhaseChanged",
		};
		this.store.emit("gameSpecificMessage", msg);
	}

	/** Total teleop seconds = Coop + four shifts + endgame (from game config; real 2026 = 140). */
	private teleopLength(): number {
		const cfg = this.store.getState().gameConfig;
		return (
			cfg.coopShiftLengthSeconds +
			cfg.shift1LengthSeconds +
			cfg.shift2LengthSeconds +
			cfg.shift3LengthSeconds +
			cfg.shift4LengthSeconds +
			cfg.endgameLengthSeconds
		);
	}

	/**
	 * Map teleop elapsed seconds to the real 2026 phase sequence and emit it: Coop (both goals) ->
	 * Shift1..4 (the active alliance alternates each shift) -> Endgame (both goals). The alliance
	 * that gets the first shift alternates per match. CurrentPhaseTimeSeconds counts down within the
	 * current phase, matching the real FMS stream.
	 */
	private emitTeleopPhase(elapsed: number): void {
		const cfg = this.store.getState().gameConfig;
		const c0 = cfg.coopShiftLengthSeconds;
		const c1 = c0 + cfg.shift1LengthSeconds;
		const c2 = c1 + cfg.shift2LengthSeconds;
		const c3 = c2 + cfg.shift3LengthSeconds;
		const c4 = c3 + cfg.shift4LengthSeconds;
		const c5 = c4 + cfg.endgameLengthSeconds;
		// Whether Blue is the active alliance in the odd shifts (1, 3); alternates per match.
		const blueFirst = this.store.getState().current.matchNumber % 2 === 0;
		const odd: [boolean, boolean] = [blueFirst, !blueFirst];
		const even: [boolean, boolean] = [!blueFirst, blueFirst];
		let phase: MatchPhase;
		let end: number;
		let goals: [boolean, boolean];
		if (elapsed < c0) {
			phase = "Coop";
			end = c0;
			goals = [true, true];
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
			goals = [true, true];
		}
		this.emitPhase(phase, end - elapsed, goals[0], goals[1]);
	}

	private countdown(
		duringState: string,
		seconds: number,
		onDone: () => void,
		onTick?: (remaining: number) => void,
	): void {
		this.stopTicker();
		let remaining = seconds;
		const state = this.store.getState();
		state.timer.running = true;
		state.timer.secondsRemaining = remaining;
		this.store.emit("timerChanged", remaining);
		this.ticker = setInterval(() => {
			// Abort the loop if a manual transition changed the state out from under us.
			if (this.store.getState().current.matchState !== duringState) {
				this.stopTicker();
				return;
			}
			remaining -= 1;
			state.timer.secondsRemaining = remaining;
			this.store.emit("timerChanged", remaining);
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
		this.store.getState().timer.running = false;
	}

	// #endregion
}
