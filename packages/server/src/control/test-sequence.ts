import type { FMSAllianceSelection, MatchPhase, MatchStateString, TournamentLevel } from "shared";
import type { MatchController } from "../match/controller";
import { emitGamePhase } from "../match/phase";
import type { FmsStore } from "../state/store";

/**
 * The audience-display test sequence: a scripted walk through every screen and scoring
 * configuration the emulator can drive, so a connected audience-display (or FTA-Buddy) can be
 * eyeballed against all of them. The runner drives the store + match controller directly (not
 * over HTTP). It can play the whole list back to back, pause, or jump straight to one step; the
 * control UI shows the list, highlights the current step, and lets the operator click any of them.
 *
 * NOTE: the emulator only drives FMS state/SignalR/REST; the audience-display app is what actually
 * renders the screens and plays the timer/buzzer sounds. The timer-tick steps below run the match
 * clock down so the audience-display fires whatever ticking/horn audio it has.
 */

/** Thrown out of a step's wait() when the run is superseded (pause / goto / new play). */
const CANCELLED = Symbol("test-sequence-cancelled");

interface StepCtx {
	store: FmsStore;
	controller: MatchController;
	/** True while this run is still the active one; false after pause/goto/another play. */
	valid(): boolean;
	/** Cancellable sleep. Throws CANCELLED if the run is superseded mid-wait. */
	wait(ms: number): Promise<void>;
}

interface TestStep {
	id: string;
	label: string;
	group: string;
	run(ctx: StepCtx): Promise<void>;
}

// #region timing

/** How long a static screen is held before the sequence advances. */
const HOLD_MS = 3500;
const PREVIEW_HOLD_MS = 3000;
const REVEAL_HOLD_MS = 5000;
const hold = (ctx: StepCtx, ms = HOLD_MS): Promise<void> => ctx.wait(ms);

// #endregion

// #region low-level drivers

/** Count the match clock down one second at a time, streaming the phase frame each tick. */
async function tickDown(
	ctx: StepCtx,
	opts: { from: number; to: number; phase: MatchPhase; red: boolean; blue: boolean; stepMs?: number },
): Promise<void> {
	ctx.store.setTimerRunning(true);
	for (let s = opts.from; s >= opts.to; s--) {
		if (!ctx.valid()) return;
		emitGamePhase(ctx.store, { phase: opts.phase, seconds: s, redGoal: opts.red, blueGoal: opts.blue });
		ctx.store.setTimerRemaining(s);
		await ctx.wait(opts.stepMs ?? 1000);
	}
}

/** Build eight 3- or 4-team alliances from the ranked field (real teams; synthetic only if short). */
function buildTestAlliances(store: FmsStore, perAlliance: 3 | 4): FMSAllianceSelection[] {
	const st = store.getState();
	const order = st.rankings.length ? st.rankings.map((r) => r.teamNumber) : st.teams.map((t) => t.number);
	const name = (n: number): string => st.teams.find((t) => t.number === n)?.name ?? `Team ${n}`;
	const at = (i: number, fallback: number): number => order[i] ?? fallback;
	// When the field is too small for 8 alliances of 4 (needs 32 teams), the tail
	// alliances borrow the lowest-ranked already-picked teams as their alternate,
	// so every alliance still shows 4 REAL teams (never invented numbers). A team
	// appearing on two alliances is an accepted test-harness artifact.
	const usedAlternates = new Set<number>();
	const alternateFor = (a: number, members: number[]): number | null => {
		const own = order[24 + a];
		if (own !== undefined) {
			usedAlternates.add(own);
			return own;
		}
		for (let i = order.length - 1; i >= 0; i--) {
			const t = order[i] as number;
			if (!usedAlternates.has(t) && !members.includes(t)) {
				usedAlternates.add(t);
				return t;
			}
		}
		return null;
	};
	const out: FMSAllianceSelection[] = [];
	for (let a = 0; a < 8; a++) {
		const captain = at(a, 9000 + a);
		const first = at(8 + a, 9100 + a);
		const second = at(16 + a, 9200 + a);
		const alternate = perAlliance === 4 ? alternateFor(a, [captain, first, second]) : null;
		out.push({
			allianceNumber: a + 1,
			allianceName: `Alliance ${a + 1}`,
			einsteinAlliance: "",
			isEinstein: false,
			captainTeamNumber: captain,
			captainTeamNameShort: name(captain),
			captainAvatar: "",
			firstRoundTeamNumber: first,
			firstRoundTeamNameShort: name(first),
			firstRoundAvatar: "",
			secondRoundTeamNumber: second,
			secondRoundTeamNameShort: name(second),
			secondRoundAvatar: "",
			alternateTeamNumber: alternate,
			alternateTeamNameShort: alternate ? name(alternate) : "",
			alternateAvatar: "",
			cardEffectiveStatus: "None",
		});
	}
	return out;
}

/** Seed eight alliances and enter the playoffs (allianceSave wires the bracket + schedule). */
function enterPlayoffs(store: FmsStore, perAlliance: 3 | 4): void {
	store.setAlliances(buildTestAlliances(store, perAlliance));
	store.setAllianceSelectionType(perAlliance === 4 ? "FourTeam" : "ThreeTeam");
	store.allianceSave();
}

/** Make sure the playoffs are staged with the requested alliance size before a playoff step. */
function ensurePlayoffs(store: FmsStore, perAlliance: 3 | 4): void {
	const st = store.getState();
	const has4 = (st.alliances[0]?.alternateTeamNumber ?? null) !== null;
	// The seeded playoffMatches slots exist from boot, so they cannot tell whether the playoffs
	// were actually staged; require a real Playoff SCHEDULE (built by allianceSave) instead, or a
	// goto straight into a playoff step from a fresh boot finds no playoff matches to select.
	const staged = st.schedule.some((e) => e.level === "Playoff");
	if (staged && has4 === (perAlliance === 4)) {
		store.setTournamentLevel("Playoff");
		return;
	}
	enterPlayoffs(store, perAlliance);
}

/** Select a match and load its teams onto the six stations. */
function selectMatch(store: FmsStore, level: TournamentLevel, matchNumber: number): void {
	store.setCurrentMatch(matchNumber, 1, level);
	const entry = store.getState().schedule.find((e) => e.level === level && e.matchNumber === matchNumber);
	if (entry) store.loadStationsFromMatch(entry.red, entry.blue);
}

type ScoreFields = Record<string, number | boolean>;

function applyScore(store: FmsStore, alliance: "Red" | "Blue", fields: ScoreFields): void {
	for (const [key, value] of Object.entries(fields)) store.setScoreField(alliance, key, value);
}

/** Stage a finished match's scores and reveal them on the audience display (commit + post). */
async function reveal(
	ctx: StepCtx,
	level: TournamentLevel,
	matchNumber: number,
	red: ScoreFields,
	blue: ScoreFields,
	/** true = default one-card-each; a function = custom card staging; false = no cards. */
	cards: boolean | ((store: FmsStore) => void) = false,
): Promise<void> {
	const { store, controller } = ctx;
	selectMatch(store, level, matchNumber);
	store.clearCards(); // start clean so a prior step's cards don't leak in
	if (cards === true) stageCards(store, level, matchNumber);
	else if (typeof cards === "function") cards(store);
	store.resetScores();
	applyScore(store, "Red", red);
	applyScore(store, "Blue", blue);
	store.setMatchState("WaitingForCommit");
	controller.commitScores();
	controller.postResults();
	await hold(ctx, REVEAL_HOLD_MS);
}

// #endregion

// #region scoring profiles

/** Commit a match result without posting it to the audience display (used to backfill
 *  earlier finals games so a revealed finals match sits in a coherent series). */
function commitQuiet(
	ctx: StepCtx,
	level: TournamentLevel,
	matchNumber: number,
	red: ScoreFields,
	blue: ScoreFields,
): void {
	const { store, controller } = ctx;
	selectMatch(store, level, matchNumber);
	store.resetScores();
	applyScore(store, "Red", red);
	applyScore(store, "Blue", blue);
	store.setMatchState("WaitingForCommit");
	controller.commitScores();
}

const S_WIN: ScoreFields = {
	autoFuelPoints: 22,
	autoClimbPoints: 15,
	shift1FuelPoints: 30,
	shift2FuelPoints: 28,
	shift3FuelPoints: 18,
	endgameClimbPoints: 30,
};
const S_LOSE: ScoreFields = {
	autoFuelPoints: 8,
	autoClimbPoints: 5,
	shift1FuelPoints: 18,
	shift2FuelPoints: 14,
	endgameClimbPoints: 10,
};
/** Jumbo score that tops anything the other fixtures (or a manual session) post, so the
 *  results projector flags it as the event high score. */
const S_HIGH: ScoreFields = {
	autoFuelPoints: 55,
	autoClimbPoints: 30,
	shift1FuelPoints: 60,
	shift2FuelPoints: 55,
	shift3FuelPoints: 50,
	shift4FuelPoints: 45,
	endgameClimbPoints: 45,
};
const S_TIE: ScoreFields = {
	autoFuelPoints: 15,
	autoClimbPoints: 10,
	shift1FuelPoints: 22,
	shift2FuelPoints: 18,
	endgameClimbPoints: 20,
};

/**
 * Overtime tiebreaker scenarios: the real 2026 REBUILT order (game manual Table 10-3). Each pair
 * ties on total points (80) and on every earlier criterion, so the named criterion decides. The
 * criteria only apply in OVERTIME (per 10.6.2.2 finals ties stand), so these stage overtime 1.
 * Order: (1) cumulative MAJOR FOUL points from opponent, (2) ALLIANCE AUTO FUEL points,
 * (3) ALLIANCE TOWER points (= total climb), (4) match is replayed.
 */
const TIEBREAKERS: { id: string; label: string; red: ScoreFields; blue: ScoreFields }[] = [
	{
		id: "tb-majorfoul",
		label: "Overtime tie - won on Major Foul points",
		red: { shift1FuelPoints: 70, foulPoints: 10, majorFoulPoints: 10 },
		blue: { shift1FuelPoints: 80 },
	},
	{
		id: "tb-autofuel",
		label: "Overtime tie - won on Auto Fuel points",
		red: { autoFuelPoints: 40, shift1FuelPoints: 40 },
		blue: { autoFuelPoints: 10, shift1FuelPoints: 70 },
	},
	{
		id: "tb-tower",
		label: "Overtime tie - won on Tower points",
		red: { autoFuelPoints: 20, endgameClimbPoints: 30, shift1FuelPoints: 30 },
		blue: { autoFuelPoints: 20, endgameClimbPoints: 10, shift1FuelPoints: 50 },
	},
	{
		id: "tb-replay",
		label: "Overtime tie - all criteria equal, match replayed",
		red: { autoFuelPoints: 20, endgameClimbPoints: 20, shift1FuelPoints: 40 },
		blue: { autoFuelPoints: 20, endgameClimbPoints: 20, shift1FuelPoints: 40 },
	},
];

/**
 * All playoff advancement-banner scenarios for a given alliance size. Each reveal shows BOTH
 * alliances, so one step exercises the winner's banner + the loser's banner. Match numbers follow
 * the standard 8-alliance double-elim bracket (game manual Table 10-2): 1-13 bracket, 14-16 finals.
 */
function advancementSteps(perAlliance: 3 | 4): TestStep[] {
	const sfx = perAlliance === 4 ? "-4" : "";
	const tag = perAlliance === 4 ? " (4-team)" : "";
	const group = perAlliance === 4 ? "Score Reveals (Advancement, 4-team)" : "Score Reveals (Advancement)";
	const mk = (id: string, label: string, match: number, red: number, blue: number, redWins: boolean): TestStep => ({
		id: `${id}${sfx}`,
		label: `${label}${tag}`,
		group,
		async run(ctx) {
			ensurePlayoffs(ctx.store, perAlliance);
			// Finals reveals must not inherit series wins piled up by earlier steps.
			if (match >= 14) ctx.store.resetFinalsSeries();
			ctx.store.seedPlayoffMatch(match, red, blue);
			await reveal(ctx, "Playoff", match, redWins ? S_WIN : S_LOSE, redWins ? S_LOSE : S_WIN);
		},
	});
	return [
		mk("adv-upper-round", "Advancement - upper round M1 (win->Upper M7 / lose->Lower M5)", 1, 1, 8, true),
		mk("adv-lower-round", "Advancement - lower round M5 (win->Lower M10 / lose->Eliminated)", 5, 8, 5, true),
		mk("adv-upper-final", "Advancement - upper final M11 (win->Finals / lose->Lower M13)", 11, 1, 2, true),
		mk("adv-lower-final", "Advancement - lower final M13 (win->Finals / lose->Eliminated)", 13, 3, 2, false),
		mk("adv-finals", "Advancement - finals M16 (no advancement banner)", 16, 1, 2, true),
	];
}

// #endregion

// #region the step list

function previewStep(id: string, label: string, setup: (ctx: StepCtx) => void): TestStep {
	return {
		id,
		label,
		group: "Match Preview",
		async run(ctx) {
			setup(ctx);
			ctx.store.setMatchState("WaitingForMatchPreview");
			ctx.store.setVideoSwitch("MatchPreview");
			await hold(ctx, PREVIEW_HOLD_MS);
		},
	};
}

function videoOnlyStep(id: string, group: string): TestStep {
	return {
		id,
		label: "Video only",
		group,
		async run(ctx) {
			ctx.store.setVideoSwitch("VideoOnly");
			await hold(ctx, 2000);
		},
	};
}

/** Put qual match 2 on the field in a given match state with the live video+score overlay. */
function liveScreen(store: FmsStore, matchState: MatchStateString): void {
	store.setTournamentLevel("Qualification");
	selectMatch(store, "Qualification", 2);
	store.connectStations();
	// Push the field-monitor lineup before the screen switch so the audience derives its scorebar
	// teams (from FieldMonitorDataChanged) before rendering match play.
	store.pushFieldMonitor();
	store.setVideoSwitch("VideoAndScore");
	store.setMatchState(matchState);
	store.broadcastStations();
}

/**
 * Put playoff match 1 on the field for a 4-team alliance with the alternate (backup) robot subbed
 * into the active lineup. Per FRC rules a 4-team alliance fields three robots per match; the backup
 * can replace one of the three. Here it takes the second-round pick's station (red3 / blue3) so the
 * field monitor and audience overlay show the alternate actually playing, not just listed in preview.
 */
function liveScreenPlayoffAlternate(store: FmsStore, matchState: MatchStateString): void {
	ensurePlayoffs(store, 4);
	store.setTournamentLevel("Playoff");
	selectMatch(store, "Playoff", 1);
	const st = store.getState();
	const entry = st.schedule.find((e) => e.level === "Playoff" && e.matchNumber === 1);
	const withBackup = (allianceNumber: number | null, teams: [number, number, number]): [number, number, number] => {
		const a = allianceNumber ? st.alliances.find((x) => x.allianceNumber === allianceNumber) : undefined;
		const alt = a?.alternateTeamNumber ?? null;
		return alt ? [teams[0], teams[1], alt] : teams;
	};
	if (entry) {
		store.loadStationsFromMatch(
			withBackup(entry.redAllianceNumber, entry.red),
			withBackup(entry.blueAllianceNumber, entry.blue),
		);
	}
	store.connectStations();
	// The backup is now in the station lineup; push the field-monitor frame so the audience scorebar
	// shows the alternate (it reads teams from FieldMonitorDataChanged) before switching to match play.
	store.pushFieldMonitor();
	store.setVideoSwitch("VideoAndScore");
	store.setMatchState(matchState);
	store.broadcastStations();
}

/** Give one team on each alliance of the given match a card: red-alliance lead = Yellow, blue lead = Red. */
function stageCards(store: FmsStore, level: TournamentLevel, matchNumber: number): void {
	const entry = store.getState().schedule.find((e) => e.level === level && e.matchNumber === matchNumber);
	if (!entry) return;
	if (entry.red[0]) store.setTeamCard(entry.red[0], "Yellow");
	if (entry.blue[0]) store.setTeamCard(entry.blue[0], "Red");
}

const PLAY_GROUP = "Match Play (Qual)";
const PLAYOFF_PLAY_GROUP = "Match Play (Playoff)";

const STEPS: TestStep[] = [
	// #region Match previews
	previewStep("preview-qual", "Qual match preview", (ctx) => {
		ctx.store.setTournamentLevel("Qualification");
		selectMatch(ctx.store, "Qualification", 1);
	}),
	videoOnlyStep("preview-video-1", "Match Preview"),
	previewStep("preview-playoff", "Playoff match preview", (ctx) => {
		ensurePlayoffs(ctx.store, 3);
		selectMatch(ctx.store, "Playoff", 1);
	}),
	videoOnlyStep("preview-video-2", "Match Preview"),
	previewStep("preview-playoff-4", "Playoff (4-team) match preview", (ctx) => {
		ensurePlayoffs(ctx.store, 4);
		selectMatch(ctx.store, "Playoff", 1);
	}),
	videoOnlyStep("preview-video-3", "Match Preview"),
	previewStep("preview-cards", "Qual match preview (yellow + red cards)", (ctx) => {
		ctx.store.setTournamentLevel("Qualification");
		selectMatch(ctx.store, "Qualification", 1);
		stageCards(ctx.store, "Qualification", 1);
	}),
	// #endregion

	// #region Match ready
	{
		id: "ready-qual",
		label: "Qual match ready",
		group: "Match Ready",
		async run(ctx) {
			ctx.store.setTournamentLevel("Qualification");
			selectMatch(ctx.store, "Qualification", 2);
			ctx.store.connectStations();
			ctx.store.setVideoSwitch("VideoAndScore");
			ctx.store.setMatchState("WaitingForMatchStart");
			ctx.store.setTimerRemaining(20);
			await hold(ctx);
		},
	},
	{
		id: "ready-playoff-4",
		label: "Playoff (4-team) match ready",
		group: "Match Ready",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 4);
			selectMatch(ctx.store, "Playoff", 1);
			ctx.store.connectStations();
			ctx.store.setVideoSwitch("VideoAndScore");
			ctx.store.setMatchState("WaitingForMatchStart");
			ctx.store.setTimerRemaining(20);
			await hold(ctx);
		},
	},
	// #endregion

	// #region Match play (qual phases)
	{
		id: "play-auto",
		label: "Qual auto",
		group: PLAY_GROUP,
		async run(ctx) {
			liveScreen(ctx.store, "MatchAuto");
			await tickDown(ctx, { from: 20, to: 14, phase: "Auto", red: true, blue: true });
		},
	},
	{
		id: "play-transition",
		label: "Qual transition phase",
		group: PLAY_GROUP,
		async run(ctx) {
			liveScreen(ctx.store, "MatchTeleop");
			await tickDown(ctx, { from: 10, to: 5, phase: "Coop", red: true, blue: true });
		},
	},
	{
		id: "play-shift-red",
		label: "Qual shift (red active)",
		group: PLAY_GROUP,
		async run(ctx) {
			liveScreen(ctx.store, "MatchTeleop");
			await tickDown(ctx, { from: 25, to: 19, phase: "Shift1", red: true, blue: false });
		},
	},
	{
		id: "play-shift-blue",
		label: "Qual shift (blue active)",
		group: PLAY_GROUP,
		async run(ctx) {
			liveScreen(ctx.store, "MatchTeleop");
			await tickDown(ctx, { from: 25, to: 19, phase: "Shift2", red: false, blue: true });
		},
	},
	{
		id: "play-endgame",
		label: "Qual endgame",
		group: PLAY_GROUP,
		async run(ctx) {
			liveScreen(ctx.store, "MatchTeleop");
			await tickDown(ctx, { from: 30, to: 24, phase: "Endgame", red: true, blue: true });
		},
	},
	{
		id: "play-ticking",
		label: "Timer ticking (final seconds sound)",
		group: PLAY_GROUP,
		async run(ctx) {
			liveScreen(ctx.store, "MatchTeleop");
			await tickDown(ctx, { from: 10, to: 4, phase: "Endgame", red: true, blue: true });
		},
	},
	{
		id: "play-buzzer",
		label: "Buzzer / time runs out",
		group: PLAY_GROUP,
		async run(ctx) {
			liveScreen(ctx.store, "MatchTeleop");
			await tickDown(ctx, { from: 3, to: 0, phase: "Endgame", red: true, blue: true });
			ctx.store.setMatchState("WaitingForCommit");
			emitGamePhase(ctx.store, { phase: "None", seconds: 0, redGoal: false, blueGoal: false });
			await hold(ctx, 1500);
		},
	},
	{
		id: "play-commit",
		label: "Commit scores",
		group: PLAY_GROUP,
		async run(ctx) {
			ctx.store.setTournamentLevel("Qualification");
			// Always pin the commit to qual match 2: setTournamentLevel above also rewrites
			// current.level, so checking it can never detect a leftover playoff/finals selection
			// (a goto into this step used to commit e.g. finals 16 as qual 16).
			selectMatch(ctx.store, "Qualification", 2);
			ctx.store.resetScores();
			applyScore(ctx.store, "Red", S_WIN);
			applyScore(ctx.store, "Blue", S_LOSE);
			ctx.store.setMatchState("WaitingForCommit");
			ctx.controller.commitScores();
			await hold(ctx);
		},
	},
	// #endregion

	// #region Match play (4-team playoff, backup robot in lineup)
	{
		id: "play-playoff-4-backup",
		label: "Playoff (4-team) play - backup robot in lineup",
		group: PLAYOFF_PLAY_GROUP,
		async run(ctx) {
			liveScreenPlayoffAlternate(ctx.store, "MatchTeleop");
			await tickDown(ctx, { from: 25, to: 18, phase: "Shift1", red: true, blue: true });
		},
	},
	{
		id: "play-cards",
		label: "Qual play (teams carrying cards)",
		group: PLAYOFF_PLAY_GROUP,
		async run(ctx) {
			liveScreen(ctx.store, "MatchTeleop");
			stageCards(ctx.store, "Qualification", 2);
			ctx.store.broadcastStations();
			await tickDown(ctx, { from: 25, to: 18, phase: "Shift1", red: true, blue: true });
		},
	},
	// #endregion

	// #region Score reveals (qual)
	{
		id: "reveal-qual-red",
		label: "Qual results - red wins",
		group: "Score Reveals (Qual)",
		run: (ctx) => reveal(ctx, "Qualification", 2, S_WIN, S_LOSE),
	},
	{
		id: "reveal-qual-blue",
		label: "Qual results - blue wins",
		group: "Score Reveals (Qual)",
		run: (ctx) => reveal(ctx, "Qualification", 3, S_LOSE, S_WIN),
	},
	{
		id: "reveal-qual-tie",
		label: "Qual results - tie",
		group: "Score Reveals (Qual)",
		run: (ctx) => reveal(ctx, "Qualification", 4, S_TIE, S_TIE),
	},
	{
		id: "reveal-qual-cards",
		label: "Qual results - yellow + red cards",
		group: "Score Reveals (Qual)",
		run: (ctx) => reveal(ctx, "Qualification", 2, S_WIN, S_LOSE, true),
	},
	{
		id: "reveal-qual-highscore",
		label: "Qual results - new event high score (banner)",
		group: "Score Reveals (Qual)",
		run: (ctx) => reveal(ctx, "Qualification", 5, S_HIGH, S_LOSE),
	},
	// #endregion

	// #region Score reveals (playoff)
	{
		id: "reveal-playoff-red",
		label: "Playoff results - red wins",
		group: "Score Reveals (Playoff)",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 3);
			await reveal(ctx, "Playoff", 1, S_WIN, S_LOSE);
		},
	},
	{
		id: "reveal-playoff-blue",
		label: "Playoff results - blue wins",
		group: "Score Reveals (Playoff)",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 3);
			await reveal(ctx, "Playoff", 2, S_LOSE, S_WIN);
		},
	},
	{
		id: "reveal-playoff-4",
		label: "Playoff (4-team) results",
		group: "Score Reveals (Playoff)",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 4);
			await reveal(ctx, "Playoff", 1, S_WIN, S_LOSE);
		},
	},
	{
		id: "reveal-finals-blue",
		label: "Playoff finals - blue wins",
		group: "Score Reveals (Playoff)",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 3);
			ctx.store.resetFinalsSeries();
			ctx.store.seedPlayoffMatch(16, 1, 2);
			await reveal(ctx, "Playoff", 16, S_LOSE, S_WIN);
		},
	},
	{
		id: "reveal-finals-champion",
		label: "Playoff finals - blue clinches series 2-0 (champion confetti)",
		group: "Score Reveals (Playoff)",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 3);
			ctx.store.resetFinalsSeries();
			ctx.store.seedPlayoffMatch(14, 1, 2);
			ctx.store.seedPlayoffMatch(15, 1, 2);
			// Blue quietly takes finals 1 so the revealed finals 2 is the series clincher.
			commitQuiet(ctx, "Playoff", 14, S_LOSE, S_WIN);
			await reveal(ctx, "Playoff", 15, S_LOSE, S_WIN);
		},
	},
	{
		id: "reveal-finals-red-2-1",
		label: "Playoff finals - red clinches series 2-1 in finals 3 (champion confetti)",
		group: "Score Reveals (Playoff)",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 3);
			ctx.store.resetFinalsSeries();
			for (const m of [14, 15, 16]) ctx.store.seedPlayoffMatch(m, 1, 2);
			// Split the first two games so the revealed finals 3 decides it for red.
			commitQuiet(ctx, "Playoff", 14, S_WIN, S_LOSE);
			commitQuiet(ctx, "Playoff", 15, S_LOSE, S_WIN);
			await reveal(ctx, "Playoff", 16, S_WIN, S_LOSE);
		},
	},
	{
		id: "reveal-playoff-alliance-yellow",
		label: "Playoff results - whole alliance yellow-carded",
		group: "Score Reveals (Playoff)",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 3);
			ctx.store.seedPlayoffMatch(1, 1, 8);
			// Yellow-card every team on the red alliance (they also lose the match).
			await reveal(ctx, "Playoff", 1, S_LOSE, S_WIN, (store) => {
				const entry = store.getState().schedule.find((e) => e.level === "Playoff" && e.matchNumber === 1);
				for (const team of entry?.red ?? []) if (team) store.setTeamCard(team, "Yellow");
			});
		},
	},
	// #endregion

	// #region Score reveals (playoff advancement banners)
	// Full advancement-banner coverage (Upper / Lower / Finals / Eliminated / Champion /
	// Finalist), for both 3-team and 4-team alliances.
	...advancementSteps(3),
	...advancementSteps(4),
	// #endregion

	// #region Finals tiebreakers
	...TIEBREAKERS.map(
		(tb): TestStep => ({
			id: tb.id,
			label: tb.label,
			group: "Finals Tiebreakers",
			async run(ctx) {
				ensurePlayoffs(ctx.store, 3);
				ctx.store.resetFinalsSeries();
				for (const m of [14, 15, 16, 17]) ctx.store.seedPlayoffMatch(m, 1, 2);
				// 1-1 plus a tied finals 3 (finals ties stand, per 10.6.2.2) forces overtime,
				// where the named criterion decides the series.
				commitQuiet(ctx, "Playoff", 14, S_WIN, S_LOSE);
				commitQuiet(ctx, "Playoff", 15, S_LOSE, S_WIN);
				commitQuiet(ctx, "Playoff", 16, S_TIE, S_TIE);
				await reveal(ctx, "Playoff", 17, tb.red, tb.blue);
			},
		}),
	),
	{
		id: "tb-finals-4",
		label: "Overtime (4-team) tiebreaker",
		group: "Finals Tiebreakers",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 4);
			ctx.store.resetFinalsSeries();
			for (const m of [14, 15, 16, 17]) ctx.store.seedPlayoffMatch(m, 1, 2);
			commitQuiet(ctx, "Playoff", 14, S_WIN, S_LOSE);
			commitQuiet(ctx, "Playoff", 15, S_LOSE, S_WIN);
			commitQuiet(ctx, "Playoff", 16, S_TIE, S_TIE);
			await reveal(ctx, "Playoff", 17, TIEBREAKERS[0]!.red, TIEBREAKERS[0]!.blue);
		},
	},
	{
		// Finals match 4 = Overtime 1 (match 17). Per game manual 10.6.2.2, finals ties (M14-16)
		// stay ties, but overtime ties ARE broken by the Table 10-3 criteria.
		id: "reveal-overtime-1",
		label: "Finals 4 / Overtime 1 - tie broken by tiebreaker",
		group: "Finals Tiebreakers",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 3);
			ctx.store.resetFinalsSeries();
			for (const m of [14, 15, 16, 17]) ctx.store.seedPlayoffMatch(m, 1, 2);
			// 1-1 plus a tied finals 3 (finals ties stand, per 10.6.2.2) forces overtime;
			// the tiebroken overtime win is then the series clincher.
			commitQuiet(ctx, "Playoff", 14, S_WIN, S_LOSE);
			commitQuiet(ctx, "Playoff", 15, S_LOSE, S_WIN);
			commitQuiet(ctx, "Playoff", 16, S_TIE, S_TIE);
			await reveal(ctx, "Playoff", 17, TIEBREAKERS[1]!.red, TIEBREAKERS[1]!.blue);
		},
	},
	// #endregion

	// #region Alliance selection
	{
		id: "alliance-selection",
		label: "Alliance selection (pick the field, with clock)",
		group: "Alliance Selection",
		async run(ctx) {
			const { store } = ctx;
			store.setTournamentLevel("Qualification");
			store.setAllianceSelectionType("ThreeTeam");
			// One switch for the whole ceremony, like a real event. The store runs the pick/break
			// clocks itself (allianceStart/alliancePick arm them and emit the FMS timer triggers).
			store.setVideoSwitch("AllianceHybrid");
			store.allianceStart();
			await ctx.wait(2500);
			for (let guard = 0; guard < 64; guard++) {
				if (!ctx.valid()) return;
				if (!store.currentAllianceSlot()) break;
				await ctx.wait(2500);
				// Third pick gets skipped to exercise the retry flow: the next alliance picks,
				// then the skipped alliance comes straight back on the clock.
				const pick =
					guard === 2 ? undefined : store.getState().rankings.find((r) => r.pickStatus === "None" && !r.isDeclined);
				if (pick) store.alliancePick(pick.teamNumber);
				else store.allianceSkip();
				await ctx.wait(500);
			}
			await hold(ctx, 3000);
			store.allianceSave();
		},
	},
	// #endregion

	// #region Standalone screens
	{
		id: "screen-rankings",
		label: "Rankings",
		group: "Standalone Screens",
		async run(ctx) {
			ctx.store.setVideoSwitch("Rankings");
			await hold(ctx);
		},
	},
	{
		id: "screen-bracket",
		label: "Playoff bracket",
		group: "Standalone Screens",
		async run(ctx) {
			ensurePlayoffs(ctx.store, 3);
			ctx.store.setVideoSwitch("Bracket");
			await hold(ctx);
		},
	},
	{
		id: "screen-schedule",
		label: "Schedule",
		group: "Standalone Screens",
		async run(ctx) {
			ctx.store.setVideoSwitch("Schedule");
			await hold(ctx);
		},
	},
	{
		id: "screen-timeout",
		label: "Match break / timeout timer",
		group: "Standalone Screens",
		async run(ctx) {
			ctx.store.setVideoSwitch("Timeout");
			ctx.store.emit("timerWarning", "timeout");
			ctx.store.setTimerRunning(true);
			for (let s = 15; s >= 0; s--) {
				if (!ctx.valid()) return;
				ctx.store.setTimerRemaining(s);
				await ctx.wait(700);
			}
		},
	},
	{
		id: "screen-reset",
		label: "Back to video only",
		group: "Standalone Screens",
		async run(ctx) {
			ctx.store.setTimerRunning(false);
			ctx.store.setVideoSwitch("VideoOnly");
			await hold(ctx, 1500);
		},
	},
	// #endregion
];

// #endregion

// #region the runner

/** Drives the test sequence and mirrors its status into the FmsState for the control UI. */
export class TestSequenceRunner {
	private store: FmsStore;
	private controller: MatchController;
	private steps: TestStep[];
	private index = -1;
	private playing = false;
	/** Bumped on every play/goto/pause; a run whose token no longer matches has been superseded. */
	private token = 0;

	constructor(store: FmsStore, controller: MatchController) {
		this.store = store;
		this.controller = controller;
		this.steps = STEPS;
		this.publish();
	}

	status(): { running: boolean; currentIndex: number; steps: { id: string; label: string; group: string }[] } {
		return {
			running: this.playing,
			currentIndex: this.index,
			steps: this.steps.map((s) => ({ id: s.id, label: s.label, group: s.group })),
		};
	}

	/** Play from the given index (or resume from the current step) through to the end. */
	play(from?: number): void {
		const start = from ?? (this.index < 0 ? 0 : this.index);
		this.start(Math.max(0, Math.min(start, this.steps.length - 1)), true);
	}

	/** Jump to a single step, show it, and stop. */
	goto(index: number): void {
		if (index < 0 || index >= this.steps.length) return;
		this.start(index, false);
	}

	/** Stop the current run, leaving the last screen up. */
	pause(): void {
		this.token++;
		this.playing = false;
		this.store.setTimerRunning(false);
		this.publish();
	}

	private start(startIndex: number, chain: boolean): void {
		const myToken = ++this.token;
		this.playing = chain;
		void this.loop(startIndex, chain, myToken);
	}

	private async loop(startIndex: number, chain: boolean, myToken: number): Promise<void> {
		for (let i = startIndex; i < this.steps.length; i++) {
			if (myToken !== this.token) return;
			this.index = i;
			this.publish();
			const step = this.steps[i]!;
			const ctx: StepCtx = {
				store: this.store,
				controller: this.controller,
				valid: () => myToken === this.token,
				wait: (ms) => this.wait(ms, myToken),
			};
			// Each step starts with a clean slate of cards; steps that want cards set them in run().
			this.store.clearCards();
			try {
				await step.run(ctx);
			} catch (err) {
				if (err === CANCELLED) return;
				console.error(`[test-sequence] step "${step.id}" failed`, err);
			}
			if (myToken !== this.token) return;
			if (!chain) {
				this.playing = false;
				this.publish();
				return;
			}
		}
		this.playing = false;
		this.publish();
	}

	private async wait(ms: number, myToken: number): Promise<void> {
		const STEP = 100;
		for (let t = 0; t < ms; t += STEP) {
			if (myToken !== this.token) throw CANCELLED;
			await new Promise((resolve) => setTimeout(resolve, Math.min(STEP, ms - t)));
		}
		if (myToken !== this.token) throw CANCELLED;
	}

	private publish(): void {
		this.store.setTestSequence(this.status());
	}
}

// #endregion
