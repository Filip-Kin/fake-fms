import { toWireNoteRecord, toWireVideoSwitch } from "shared";
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

		// Real FMS fires a set of empty "request update" companions plus the previous-MAC frame when
		// a match is prestarted; reproduce them so the prestart traffic matches a real field.
		if (info.MatchState === "Prestarting") {
			hubs.infrastructureHub.broadcast("PLC_ASTOP_STATUS_RequestUpdate");
			hubs.infrastructureHub.broadcast("PLC_CONNECTION_STATUS_RequestUpdate");
			hubs.infrastructureHub.broadcast("PLC_ESTOP_STATUS_RequestUpdate");
			hubs.gameSpecificHub.broadcast("HardwareErrors_RequestUpdate");
			hubs.fieldMonitorHub.broadcast("FieldMonitorPreviousMacAddressesChanged", {
				Red1MacAddress: "",
				Red2MacAddress: "",
				Red3MacAddress: "",
				Blue1MacAddress: "",
				Blue2MacAddress: "",
				Blue3MacAddress: "",
			});
		}
	});

	// FieldMonitorDataChanged is NOT emitted on change: real FMS streams the current frames at a
	// steady ~1 Hz in lockstep with GlobalTimerChanged (confirmed from capture - identical counts,
	// 1000ms median gap), picking up any change at the next tick. That heartbeat lives in index.ts;
	// store mutations only need to update state (the control UI gets them via the stateChanged push).

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

	// Real FMS announces the config key changed AND pushes the new value. Consumers may either
	// re-fetch get_VideoswitchOption (on the SystemConfigValueChanged signal) or read the value
	// directly off VideoSwitchOptionChanged.
	store.on("videoSwitchChanged", (option) => {
		hubs.infrastructureHub.broadcast("SystemConfigValueChanged", "VideoSwitchOption");
		hubs.infrastructureHub.broadcast("VideoSwitchOptionChanged", toWireVideoSwitch(option));
	});

	store.on("estopStatusChanged", (data) => {
		hubs.infrastructureHub.broadcast("PLC_ESTOP_STATUS_Changed", data);
	});

	// On commit FMS marks the match committed then posted (both carry the fmsMatchId).
	store.on("matchCommitted", (fmsMatchId) => {
		hubs.infrastructureHub.broadcast("MatchCommitted", fmsMatchId);
		hubs.infrastructureHub.broadcast("MatchPosted", fmsMatchId);
	});

	store.on("tournamentLevelChanged", (level) => {
		hubs.infrastructureHub.broadcast("ActiveTournamentLevelChanged", level);
	});

	store.on("plcMatchStatus", (data) => {
		hubs.infrastructureHub.broadcast("PLC_MATCH_STATUS_Changed", data);
	});

	// The extension listens for action-specific events (noteadded/noteupdated/...) each
	// carrying the note record; @microsoft/signalr lowercases targets for dispatch. Real FMS
	// sends the record with PascalCase keys (confirmed against a captured NoteAdded), so map the
	// internal camelCase record before broadcasting.
	store.on("noteChanged", (action, record) => {
		const target = `Note${action.charAt(0).toUpperCase()}${action.slice(1)}`;
		hubs.ftaAppHub.broadcast(target, toWireNoteRecord(record));
	});
}
