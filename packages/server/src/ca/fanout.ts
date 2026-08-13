/**
 * The single place that maps store domain events to Cheesy Arena notifier emissions — the CA analogue
 * of fanout.ts (which maps the same events to FMS SignalR). Both run off the same FmsStore, so the CA
 * feed and the FMS feed always agree. Emits reach only connected CA sockets, so when the CA toggle is
 * off (no sockets) this is a no-op.
 */
import type { CaNotifierHub } from "./notifiers";
import type { FmsStore } from "./../state/store";
import { dotnetTimeSpanToCycle } from "./util";

export function wireCaFanout(store: FmsStore, hub: CaNotifierHub): void {
	// Match lifecycle: a state change moves the CA MatchState + CanStartMatch and can load a match or
	// post a result.
	store.on("matchStateChanged", (info) => {
		hub.emit("arenaStatus");
		hub.emit("matchTime");
		if (info.MatchState === "Prestarting") {
			// A freshly loaded match: CA fires matchLoad + realtimeScore + display mode.
			hub.emit("matchLoad");
			hub.emit("realtimeScore");
			hub.emit("scoringStatus");
		}
		if (info.MatchState === "WaitingForPostResults") {
			// Scores committed: CA posts the result to the audience/announcer/match_play feeds.
			hub.emit("scorePosted");
		}
		hub.emit("audienceDisplayMode");
	});

	// Per-robot status: CA surfaces it through arenaStatus.
	store.on("stationsChanged", () => hub.emit("arenaStatus"));
	store.on("fieldMonitorPush", () => hub.emit("arenaStatus"));
	store.on("estopStatusChanged", () => hub.emit("arenaStatus"));

	// Score edits.
	store.on("scoreChanged", () => hub.emit("realtimeScore"));

	// Match clock. CA carries a single monotonic MatchTimeSec; both the auto/teleop timer and the
	// transition clock advance it.
	store.on("timerChanged", () => hub.emit("matchTime"));
	store.on("transitionTimerChanged", () => hub.emit("matchTime"));

	// Commit / post -> scorePosted (fires on both, dedup is fine for a display feed).
	store.on("matchCommitted", () => hub.emit("scorePosted"));
	store.on("matchPosted", () => {
		hub.emit("scorePosted");
		hub.emit("audienceDisplayMode");
	});

	// Cycle time -> CA eventStatus.CycleTime (the CA analogue of LastCycleTimeCalculated).
	store.on("lastCycleTime", (timeSpan) => {
		store.setCaCycleTime(dotnetTimeSpanToCycle(timeSpan));
		hub.emit("eventStatus");
	});

	// Alliance selection ceremony.
	store.on("allianceSelectionChanged", () => hub.emit("allianceSelection"));
	store.on("allianceTimer", () => hub.emit("allianceSelection"));
	store.on("allianceDecline", () => hub.emit("allianceSelection"));

	// Audience mode follows the video switch.
	store.on("videoSwitchChanged", () => hub.emit("audienceDisplayMode"));
	store.on("tournamentLevelChanged", () => hub.emit("matchLoad"));

	// Schedule regenerated: consumers re-fetch /api/matches (CA has no schedule notifier), but the
	// currently loaded match may have changed, so refresh matchLoad.
	store.on("scheduleChanged", () => hub.emit("matchLoad"));
}
