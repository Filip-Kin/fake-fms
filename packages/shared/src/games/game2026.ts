import type { AllianceScoreDetails, GameConfig, ScoreChangedData } from "../fms-wire";
import type { GameModule, ScoreFieldDescriptor } from "./game-module";

/**
 * Internal, operator-editable 2026 score. Point components are entered directly; derived
 * totals/achievements are filled by `recompute`. Field names mirror ScoreChangedData where
 * a 1:1 mapping exists. The exact 2026 manual values should be confirmed against the real
 * game manual; this models the fuel/climb/shift structure seen in the audience-display types.
 */
export interface Game2026Score extends Record<string, unknown> {
	// Raw editable inputs
	autoFuelPoints: number;
	coopFuelPoints: number;
	shift1FuelPoints: number;
	shift2FuelPoints: number;
	shift3FuelPoints: number;
	shift4FuelPoints: number;
	endgameFuelPoints: number;
	teleopFuelCount: number;
	totalFuelCount: number;
	autoClimbPoints: number;
	endgameClimbPoints: number;
	foulPoints: number;
	adjustPoints: number;
	g206Penalty: boolean;
	g418Penalty: boolean;
	g419Penalty: boolean;

	// Derived (filled by recompute)
	teleopFuelPoints: number;
	totalFuelPoints: number;
	totalClimbPoints: number;
	autoPoints: number;
	teleopPoints: number;
	totalPoints: number;
	energizedAchieved: boolean;
	superchargedAchieved: boolean;
	traversalAchieved: boolean;
	advantageAchieved: boolean;
}

const TRAVERSAL_THRESHOLD = 50;
const ENERGIZED_THRESHOLD = 100;
const SUPERCHARGED_THRESHOLD = 360;

const EDITOR_SCHEMA: ScoreFieldDescriptor[] = [
	{ key: "autoFuelPoints", label: "Auto Fuel", kind: "number", group: "auto" },
	{ key: "autoClimbPoints", label: "Auto Climb", kind: "number", group: "auto" },
	{ key: "coopFuelPoints", label: "Coop Fuel", kind: "number", group: "teleop" },
	{ key: "shift1FuelPoints", label: "Shift 1 Fuel", kind: "number", group: "teleop" },
	{ key: "shift2FuelPoints", label: "Shift 2 Fuel", kind: "number", group: "teleop" },
	{ key: "shift3FuelPoints", label: "Shift 3 Fuel", kind: "number", group: "teleop" },
	{ key: "shift4FuelPoints", label: "Shift 4 Fuel", kind: "number", group: "teleop" },
	{ key: "teleopFuelCount", label: "Teleop Fuel Count", kind: "count", group: "teleop" },
	{ key: "totalFuelCount", label: "Total Fuel Count", kind: "count", group: "teleop" },
	{ key: "endgameFuelPoints", label: "Endgame Fuel", kind: "number", group: "endgame" },
	{ key: "endgameClimbPoints", label: "Endgame Climb", kind: "number", group: "endgame" },
	{ key: "foulPoints", label: "Foul Points", kind: "number", group: "penalty" },
	{ key: "adjustPoints", label: "Adjustment", kind: "number", group: "penalty" },
	{ key: "g206Penalty", label: "G206", kind: "boolean", group: "penalty" },
	{ key: "g418Penalty", label: "G418", kind: "boolean", group: "penalty" },
	{ key: "g419Penalty", label: "G419", kind: "boolean", group: "penalty" },
];

export const game2026: GameModule<Game2026Score> = {
	id: "reefscape2026",
	season: 2026,

	emptyScore(): Game2026Score {
		return {
			autoFuelPoints: 0,
			coopFuelPoints: 0,
			shift1FuelPoints: 0,
			shift2FuelPoints: 0,
			shift3FuelPoints: 0,
			shift4FuelPoints: 0,
			endgameFuelPoints: 0,
			teleopFuelCount: 0,
			totalFuelCount: 0,
			autoClimbPoints: 0,
			endgameClimbPoints: 0,
			foulPoints: 0,
			adjustPoints: 0,
			g206Penalty: false,
			g418Penalty: false,
			g419Penalty: false,
			teleopFuelPoints: 0,
			totalFuelPoints: 0,
			totalClimbPoints: 0,
			autoPoints: 0,
			teleopPoints: 0,
			totalPoints: 0,
			energizedAchieved: false,
			superchargedAchieved: false,
			traversalAchieved: false,
			advantageAchieved: false,
		};
	},

	recompute(score: Game2026Score): Game2026Score {
		const teleopFuelPoints =
			score.coopFuelPoints +
			score.shift1FuelPoints +
			score.shift2FuelPoints +
			score.shift3FuelPoints +
			score.shift4FuelPoints +
			score.endgameFuelPoints;
		const totalFuelPoints = score.autoFuelPoints + teleopFuelPoints;
		const totalClimbPoints = score.autoClimbPoints + score.endgameClimbPoints;
		const autoPoints = score.autoFuelPoints + score.autoClimbPoints;
		const teleopPoints = teleopFuelPoints + score.endgameClimbPoints;
		const totalPoints = autoPoints + teleopPoints + score.foulPoints + score.adjustPoints;
		return {
			...score,
			teleopFuelPoints,
			totalFuelPoints,
			totalClimbPoints,
			autoPoints,
			teleopPoints,
			totalPoints,
			energizedAchieved: totalFuelPoints >= ENERGIZED_THRESHOLD,
			superchargedAchieved: totalFuelPoints >= SUPERCHARGED_THRESHOLD,
			traversalAchieved: totalClimbPoints >= TRAVERSAL_THRESHOLD,
			advantageAchieved: score.advantageAchieved,
		};
	},

	toScoreChangedData(score: Game2026Score, timestamp: string): ScoreChangedData {
		return {
			AdjustPoints: score.adjustPoints,
			G206Penalty: score.g206Penalty,
			G418Penalty: score.g418Penalty,
			G419Penalty: score.g419Penalty,
			TotalPoints: score.totalPoints,
			AutoPoints: score.autoPoints,
			TeleopPoints: score.teleopPoints,
			FoulPoints: score.foulPoints,
			TimeStamp: timestamp,
			EnergizedAchieved: score.energizedAchieved,
			SuperchargedAchieved: score.superchargedAchieved,
			TraversalAchieved: score.traversalAchieved,
			AdvantageAchieved: score.advantageAchieved,
			AutoFuelPoints: score.autoFuelPoints,
			CoopFuelPoints: score.coopFuelPoints,
			Shift1FuelPoints: score.shift1FuelPoints,
			Shift2FuelPoints: score.shift2FuelPoints,
			Shift3FuelPoints: score.shift3FuelPoints,
			Shift4FuelPoints: score.shift4FuelPoints,
			EndgameFuelPoints: score.endgameFuelPoints,
			TeleopFuelPoints: score.teleopFuelPoints,
			TotalFuelPoints: score.totalFuelPoints,
			TeleopFuelCount: score.teleopFuelCount,
			TotalFuelCount: score.totalFuelCount,
			AutoClimbPoints: score.autoClimbPoints,
			EndgameClimbPoints: score.endgameClimbPoints,
			TotalClimbPoints: score.totalClimbPoints,
			EnergizedThreshold: ENERGIZED_THRESHOLD,
			SuperchargedThreshold: SUPERCHARGED_THRESHOLD,
			TraversalThreshold: TRAVERSAL_THRESHOLD,
		};
	},

	toAllianceScoreDetails(
		score: Game2026Score,
		opts: { win: boolean; tie: boolean; isHighScore: boolean },
	): AllianceScoreDetails {
		return {
			win: opts.win,
			tie: opts.tie,
			totalScore: score.totalPoints,
			isHighScore: opts.isHighScore,
			autoFuelPoints: score.autoFuelPoints,
			autoClimbPoints: score.autoClimbPoints,
			teleopFuelPoints: score.teleopFuelPoints,
			teleopClimbPoints: score.endgameClimbPoints,
			penaltyPoints: score.foulPoints,
			energizedAchieved: score.energizedAchieved,
			superchargedAchieved: score.superchargedAchieved,
			traversalAchieved: score.traversalAchieved,
			rankingPoints: opts.win ? 3 : opts.tie ? 1 : 0,
		};
	},

	defaultGameConfig(): GameConfig {
		return {
			traversalThreshold: TRAVERSAL_THRESHOLD,
			energizedThreshold: ENERGIZED_THRESHOLD,
			superchargedThreshold: SUPERCHARGED_THRESHOLD,
			coopShiftLengthSeconds: 25,
			shift1LengthSeconds: 25,
			shift2LengthSeconds: 25,
			shift3LengthSeconds: 25,
			shift4LengthSeconds: 25,
			endgameLengthSeconds: 30,
			postMatchScoringDelayMilliseconds: 5000,
			spareCounterBox: "NotInUse",
		};
	},

	editorSchema: EDITOR_SCHEMA,
};
