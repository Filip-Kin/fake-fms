import type { GameConfig } from "shared";

/**
 * Real 2026 "Rebuilt" match clock. Auto is a fixed 20s; teleop is the sum of the game-config phase
 * lengths (Coop + four shifts + endgame = 140s by default). Shared by the match controller, the
 * GetLog endpoint, and live log replay so generated logs line up exactly with the running clock.
 */
export const AUTO_SECONDS = 20;

export function teleopSeconds(cfg: GameConfig): number {
	return (
		cfg.coopShiftLengthSeconds +
		cfg.shift1LengthSeconds +
		cfg.shift2LengthSeconds +
		cfg.shift3LengthSeconds +
		cfg.shift4LengthSeconds +
		cfg.endgameLengthSeconds
	);
}
