import { hubs } from "./signalr/registry";
import type { FmsStore } from "./state/store";

/**
 * The single place that translates store domain events into SignalR broadcasts. Keeping
 * this mapping in one file means mutation sites never need to know which hub/event a change
 * fans out to. `stateChanged` is handled separately by the control websocket.
 */
export function wireFanout(store: FmsStore): void {
	// Match state goes to every hub a consumer listens on.
	store.on("matchStateChanged", (info) => {
		hubs.fieldMonitorHub.broadcast("MatchStatusInfoChanged", info);
		hubs.infrastructureHub.broadcast("MatchStatusInfoChanged", info);
		hubs.ftaAppHub.broadcast("MatchStatusInfoChanged", info);
	});

	// Real FMS emits field-monitor data on any robot/field change, capped at ~2/sec. Rate-limit
	// to <=2Hz, coalescing bursts (leading edge fires immediately, trailing edge sends the latest).
	const MIN_GAP_MS = 500;
	let lastEmit = 0;
	let pending: import("shared").SignalRMonitorFrame[] | null = null;
	let pendingTimer: ReturnType<typeof setTimeout> | null = null;
	store.on("stationsChanged", (frames) => {
		const now = Date.now();
		const since = now - lastEmit;
		if (since >= MIN_GAP_MS) {
			lastEmit = now;
			hubs.fieldMonitorHub.broadcast("FieldMonitorDataChanged", frames);
		} else {
			pending = frames;
			if (!pendingTimer) {
				pendingTimer = setTimeout(() => {
					lastEmit = Date.now();
					if (pending) hubs.fieldMonitorHub.broadcast("FieldMonitorDataChanged", pending);
					pending = null;
					pendingTimer = null;
				}, MIN_GAP_MS - since);
			}
		}
	});

	store.on("scoreChanged", (alliance, data) => {
		hubs.gameSpecificHub.broadcast(`${alliance}ScoreChanged`, data);
	});

	store.on("gameSpecificMessage", (msg) => {
		hubs.gameSpecificHub.broadcast("SendGameSpecificMessage", msg);
	});

	// audience-display reads the broadcast argument directly as the displayed timer value.
	store.on("timerChanged", (seconds) => {
		hubs.infrastructureHub.broadcast("MatchTimerChanged", seconds);
	});

	store.on("timerWarning", (which) => {
		if (which === 1) hubs.infrastructureHub.broadcast("MatchTimerWarning1", null);
		else if (which === 2) hubs.infrastructureHub.broadcast("MatchTimerWarning2", null);
		else hubs.infrastructureHub.broadcast("TimeOutWarning1", null);
	});

	store.on("showResults", (data) => {
		hubs.infrastructureHub.broadcast("AudienceShowMatchResult", data);
	});

	// Consumers re-fetch get_VideoswitchOption when SystemConfigValueChanged === "VideoSwitchOption".
	store.on("videoSwitchChanged", () => {
		hubs.infrastructureHub.broadcast("SystemConfigValueChanged", "VideoSwitchOption");
	});

	store.on("tournamentLevelChanged", (level) => {
		hubs.infrastructureHub.broadcast("ActiveTournamentLevelChanged", level);
	});

	store.on("plcMatchStatus", (data) => {
		hubs.infrastructureHub.broadcast("PLC_MATCH_STATUS_Changed", data);
	});

	// The extension listens for action-specific events (noteadded/noteupdated/...) each
	// carrying the note record; @microsoft/signalr lowercases targets for dispatch.
	store.on("noteChanged", (action, record) => {
		const target = `Note${action.charAt(0).toUpperCase()}${action.slice(1)}`;
		hubs.ftaAppHub.broadcast(target, record);
	});
}
