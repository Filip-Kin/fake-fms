import type { AllianceScoreDetails, GameConfig, ScoreChangedData } from "../fms-wire";

/**
 * A descriptor for one operator-editable score field. The React score editor renders
 * generically from these so swapping the season's game module changes only the module.
 */
export interface ScoreFieldDescriptor {
	key: string;
	label: string;
	kind: "number" | "boolean" | "count" | "select";
	group: "auto" | "teleop" | "endgame" | "penalty";
	/** For kind "select": dropdown options. The stored value is `value` (the points for that level). */
	options?: { label: string; value: number }[];
}

/**
 * Outcome of a playoff match once the season's tiebreaker rules are applied. `winner` is null
 * only when every tiebreaker criterion is also tied (the match is replayed); `criterion` names
 * what decided it ("Total" for a normal score difference, the tiebreaker name otherwise, or
 * "Replay").
 */
export interface MatchDecision {
	winner: "Red" | "Blue" | null;
	criterion: string;
	/** Which tiebreaker decided it: 0 = the totals differed (no tiebreaker), 1..N = the Nth
	 * tiebreaker criterion, or the last value when every criterion tied (the match is replayed).
	 * Maps to FMS's PlayoffTiebreakType (TieBreakSortOrderN / TrueTie). */
	sortOrder: number;
}

/**
 * A season's scoring rules. The internal `TScore` is the editable source of truth held
 * in the store; the module projects it into the FMS wire shapes (gameSpecificHub payload
 * and the REST results block) so the emulator stays game-agnostic everywhere else.
 */
export interface GameModule<TScore extends Record<string, unknown>> {
	readonly id: string;
	readonly season: number;
	/** A fresh zeroed score. */
	emptyScore(): TScore;
	/** Recompute derived totals/achievements after an operator edits a raw field. */
	recompute(score: TScore): TScore;
	/** Build the gameSpecificHub ScoreChangedData payload (PascalCase). */
	toScoreChangedData(score: TScore, timestamp: string): ScoreChangedData;
	/** Build the REST GetMatchResults*Data AllianceScoreDetails block. */
	toAllianceScoreDetails(score: TScore, opts: { win: boolean; tie: boolean; isHighScore: boolean }): AllianceScoreDetails;
	/**
	 * Decide a playoff match (both scores already recomputed): higher total wins, else apply the
	 * season's tiebreaker criteria in order. Used for the playoff winner the audience display shows.
	 */
	decidePlayoffMatch(red: TScore, blue: TScore): MatchDecision;
	defaultGameConfig(): GameConfig;
	/** Fields the score editor should render. */
	readonly editorSchema: ScoreFieldDescriptor[];
}

// A loosely-typed module handle for storage/registry use where TScore is not known.
export type AnyGameModule = GameModule<Record<string, unknown>>;
