import { toWireNoteRecord } from "shared";
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

		// Distinct from MatchStatusInfoChanged: real FMS also fires MatchStatusChanged carrying the
		// schedule row's status. Captured values: NotStarted (at prestart), InProgress (at match
		// start, FinalScore* null), then Played at commit with the final totals. Audience display + FTA
		// subscribe to it. Commit sets WaitingForPostResults, at which point the ref scores are live.
		const matchStatus =
			info.MatchState === "WaitingForPrestart"
				? "NotStarted"
				: info.MatchState === "MatchAuto"
					? "InProgress"
					: info.MatchState === "WaitingForPostResults"
						? "Played"
						: null;
		if (matchStatus) {
			const s = store.getState();
			const entry = s.schedule.find((e) => e.matchNumber === s.current.matchNumber && e.level === s.current.level);
			if (entry) {
				let finalRed: number | null = null;
				let finalBlue: number | null = null;
				if (matchStatus === "Played") {
					const module = store.getGameModule();
					finalRed = Number(module.recompute(s.score.red).totalPoints ?? 0);
					finalBlue = Number(module.recompute(s.score.blue).totalPoints ?? 0);
				}
				hubs.infrastructureHub.broadcast("MatchStatusChanged", {
					ScheduleDetailId: entry.fmsMatchId,
					MatchStatus: matchStatus,
					FinalScoreBlue: finalBlue,
					FinalScoreRed: finalRed,
				});
			}
		}

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

	// FieldMonitorDataChanged is NOT emitted on every change: real FMS streams the current frames at a
	// steady ~1 Hz in lockstep with GlobalTimerChanged (confirmed from capture - identical counts,
	// 1000ms median gap), picking up any change at the next tick. That heartbeat lives in index.ts;
	// store mutations only need to update state (the control UI gets them via the stateChanged push).
	// pushFieldMonitor() lets a caller force one frame out of cadence when a consumer needs the lineup
	// before a screen switch (the test sequence compresses the prestart gap the heartbeat relies on).
	store.on("fieldMonitorPush", (frames) => {
		hubs.fieldMonitorHub.broadcast("FieldMonitorDataChanged", frames);
	});

	store.on("scoreChanged", (alliance, data) => {
		hubs.gameSpecificHub.broadcast(`${alliance}ScoreChanged`, data);
	});

	store.on("gameSpecificMessage", (msg) => {
		hubs.gameSpecificHub.broadcast("SendGameSpecificMessage", msg);
	});

	// Real 2026 FMS (2026-07-19 ground-truth log) folds every countdown into one
	// TimerChanged event with a named timer; there is no bare MatchTimerChanged.
	store.on("timerChanged", (seconds) => {
		hubs.infrastructureHub.broadcast("TimerChanged", { Timer: "MatchTimer", TimeLeft: seconds });
	});
	store.on("transitionTimerChanged", (seconds) => {
		hubs.infrastructureHub.broadcast("TimerChanged", { Timer: "MatchTransitionTimer", TimeLeft: seconds });
	});
	// Only the selection BREAK clocks tick here; the pick clock is trigger-only.
	store.on("allianceSelectionTimerChanged", (seconds) => {
		hubs.infrastructureHub.broadcast("TimerChanged", { Timer: "AllianceSelectionTimer", TimeLeft: seconds });
	});

	// Real FMS fires these warnings with NO arguments (arguments:[]); don't pass a null payload.
	store.on("timerWarning", (which) => {
		if (which === 1) hubs.infrastructureHub.broadcast("MatchTimerWarning1");
		else if (which === 2) hubs.infrastructureHub.broadcast("MatchTimerWarning2");
		else hubs.infrastructureHub.broadcast("TimeOutWarning1");
	});

	store.on("showResults", (data) => {
		hubs.infrastructureHub.broadcast("AudienceShowMatchResult", data);
	});

	// Real FMS announces the config key changed AND pushes the new value. Consumers may either
	// re-fetch get_VideoswitchOption (on the SystemConfigValueChanged signal) or read the value
	// directly off VideoSwitchOptionChanged. The internal option IS the real wire value (the
	// VideoSwitchOption union holds only real FMS strings), so it is broadcast raw.
	store.on("videoSwitchChanged", (option) => {
		hubs.infrastructureHub.broadcast("SystemConfigValueChanged", "VideoSwitchOption");
		hubs.infrastructureHub.broadcast("VideoSwitchOptionChanged", option);
	});

	store.on("estopStatusChanged", (data) => {
		hubs.infrastructureHub.broadcast("PLC_ESTOP_STATUS_Changed", data);
	});

	// Committing locks the result; posting publishes it to the audience. Real FMS fires these as
	// two separate events (both carry the fmsMatchId); MatchPosted/AudienceShowMatchResult is what
	// FTA-Buddy keys off to pull match logs.
	store.on("matchCommitted", (fmsMatchId) => {
		hubs.infrastructureHub.broadcast("MatchCommitted", fmsMatchId);
	});
	store.on("matchPosted", (fmsMatchId) => {
		hubs.infrastructureHub.broadcast("MatchPosted", fmsMatchId);
	});

	store.on("tournamentLevelChanged", (level) => {
		hubs.infrastructureHub.broadcast("ActiveTournamentLevelChanged", level);
	});

	// Alliance selection: real FMS fires one AllianceSelectionChanged per slot that changes (the
	// payload names the alliance + Captain/Round1/Round2 slot), AllianceSelectionDecline as
	// [teamNumber, declined], and an empty ScheduleChanged when the playoff schedule is generated.
	store.on("allianceSelectionChanged", (data) => {
		hubs.infrastructureHub.broadcast("AllianceSelectionChanged", data);
	});
	// AudienceAllianceTimer is a trigger event ({Round, TimerType}) that labels pick vs break time;
	// the seconds themselves ride TimerChanged/AllianceSelectionTimer (see allianceSelectionTimerChanged).
	store.on("allianceTimer", (data) => {
		hubs.infrastructureHub.broadcast("AudienceAllianceTimer", data);
	});
	// Momentary alliance-selection console button feedback (StartButton before each pick, Break2/Break8).
	store.on("allianceSelectionButton", (data) => {
		hubs.infrastructureHub.broadcast("PLC_ALLIANCESELECTION_STATUS_Changed", data);
	});
	store.on("allianceDecline", (teamNumber, declined) => {
		hubs.infrastructureHub.broadcast("AllianceSelectionDecline", teamNumber, declined);
	});
	store.on("scheduleChanged", () => {
		hubs.infrastructureHub.broadcast("ScheduleChanged");
	});
	// Match cycle time as a .NET TimeSpan string, emitted once per posted match (FTA-Buddy cycle stats).
	store.on("lastCycleTime", (timeSpan) => {
		hubs.infrastructureHub.broadcast("LastCycleTimeCalculated", timeSpan);
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
