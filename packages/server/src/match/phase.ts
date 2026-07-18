import type { GameSpecificMessage, MatchPhase } from "shared";
import type { FmsStore } from "../state/store";

/**
 * The single way to emit a SendGameSpecificMessage phase frame. The goals are named (not
 * positional) so a call site can never red/blue-swap them; the store mutator keeps the
 * control-UI snapshot in sync with the emitted phase.
 */
export function emitGamePhase(
	store: FmsStore,
	opts: { phase: MatchPhase; seconds: number; redGoal: boolean; blueGoal: boolean },
): void {
	store.setTimerPhase(opts.phase);
	const msg: GameSpecificMessage = {
		MatchPhase: opts.phase,
		BlueAllianceGoalActive: opts.blueGoal,
		RedAllianceGoalActive: opts.redGoal,
		CurrentPhaseTimeSeconds: opts.seconds,
		MessageType: "MatchPhaseChanged",
	};
	store.emit("gameSpecificMessage", msg);
}
