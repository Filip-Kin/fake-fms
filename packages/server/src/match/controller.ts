import type { GameSpecificMessage, MatchPhase, TournamentLevel } from "shared";
import type { FmsStore } from "../state/store";

const AUTO_SECONDS = 15;
const TRANSITION_SECONDS = 3;
const TELEOP_SECONDS = 135;
const WARNING_TELEOP_REMAINING = 90; // matchtimerwarning2
const ENDGAME_WARNING_REMAINING = 20; // matchtimerwarning1

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
		this.store.setMatchState("Prestarting");
		// Prestart completes -> waiting for the operator to set the audience / preview.
		setTimeout(() => {
			this.store.setMatchState("WaitingForMatchPreview");
			this.store.setVideoSwitch("MatchPreview");
		}, 500);
	}

	/** Preview shown / audience set -> field becomes "match not ready". */
	setAudience(): void {
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
		this.runAuto();
	}

	private runAuto(): void {
		this.store.setMatchState("MatchAuto");
		this.store.broadcastStations(); // robots now enabled+auto
		this.emitPhase("Auto", AUTO_SECONDS);
		this.countdown("MatchAuto", AUTO_SECONDS, () => this.runTransition());
	}

	private runTransition(): void {
		this.store.setMatchState("MatchTransition");
		this.store.broadcastStations();
		this.emitPhase("TransitionShift", TRANSITION_SECONDS);
		this.countdown("MatchTransition", TRANSITION_SECONDS, () => this.runTeleop());
	}

	private runTeleop(): void {
		this.store.setMatchState("MatchTeleop");
		this.store.broadcastStations();
		let lastPhase: MatchPhase | null = null;
		this.countdown(
			"MatchTeleop",
			TELEOP_SECONDS,
			() => this.endMatch(),
			(remaining) => {
				if (remaining === WARNING_TELEOP_REMAINING) this.store.emit("timerWarning", 2);
				if (remaining === ENDGAME_WARNING_REMAINING) this.store.emit("timerWarning", 1);
				const phase = this.teleopPhase(TELEOP_SECONDS - remaining);
				if (phase !== lastPhase) {
					lastPhase = phase;
					this.emitPhase(phase, remaining);
				}
			},
		);
	}

	private endMatch(): void {
		this.stopTicker();
		this.store.setMatchState("WaitingForCommit");
		this.store.broadcastStations(); // robots disabled
		this.emitPhase("PostMatch", 0);
	}

	/** Commit the refs' scores and reveal results to the audience. */
	commitScores(): void {
		const state = this.store.getState();
		this.store.setMatchState("WaitingForPostResults");
		this.store.setVideoSwitch("MatchResults");
		this.store.emit("showResults", {
			MatchNumber: state.current.matchNumber,
			TournamentLevel: state.current.level,
			IsRepost: false,
			IsDebug: false,
		});
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

	private emitPhase(phase: MatchPhase, seconds: number): void {
		this.store.getState().timer.phase = phase;
		const msg: GameSpecificMessage = {
			MatchPhase: phase,
			BlueAllianceGoalActive: phase !== "PreMatch" && phase !== "PostMatch",
			RedAllianceGoalActive: phase !== "PreMatch" && phase !== "PostMatch",
			CurrentPhaseTimeSeconds: seconds,
			MessageType: "MatchPhaseChanged",
		};
		this.store.emit("gameSpecificMessage", msg);
	}

	private teleopPhase(elapsed: number): MatchPhase {
		const cfg = this.store.getState().gameConfig;
		const s1 = cfg.shift1LengthSeconds;
		const s2 = s1 + cfg.shift2LengthSeconds;
		const s3 = s2 + cfg.shift3LengthSeconds;
		const s4 = s3 + cfg.shift4LengthSeconds;
		if (elapsed < s1) return "Shift1";
		if (elapsed < s2) return "Shift2";
		if (elapsed < s3) return "Shift3";
		if (elapsed < s4) return "Shift4";
		return "Endgame";
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
