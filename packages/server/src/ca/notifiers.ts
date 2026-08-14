/**
 * The Cheesy Arena websocket notifier hub. Reproduces CA's `HandleNotifiers` behaviour: each socket
 * subscribes to a fixed set of notifiers, receives one bootstrap message per subscribed notifier on
 * connect (to seed client state), then every subsequent `emit` for a subscribed notifier, plus a
 * `{"type":"ping","data":null}` every 10s. The subscription sets and bootstrap order are transcribed
 * from CA's per-display websocket handlers (see ca-docs §5.1).
 *
 * Interactive sockets (match_play) also read command frames and drive the match controller, so a
 * CA-side tool can operate the field exactly as CA's match_play page does.
 */
import type { ServerWebSocket } from "bun";
import type { MatchController } from "../match/controller";
import type { FmsStore } from "../state/store";
import { CA_STATIONS, type CaMessage } from "./types";
import {
	caArenaStatus,
	caEventStatus,
	caMatchLoad,
	caMatchTime,
	caMatchTiming,
	caMatchId,
	caRealtimeScore,
	caScorePosted,
	caAudienceMode,
} from "./projectors";
import { STATION_KEYS, type StationKey, type TournamentLevel } from "shared";

export type CaSocketType =
	| "field_monitor"
	| "audience"
	| "announcer"
	| "alliance_station"
	| "queueing"
	| "rankings"
	| "bracket"
	| "logo"
	| "twitch"
	| "wall"
	| "webpage"
	| "placeholder"
	| "match_play"
	| "scoring"
	| "referee"
	| "alliance_selection"
	| "setup_displays"
	| "setup_lower_thirds"
	| "setup_field_testing"
	| "api_arena";

export interface CaSocketData {
	kind: "ca";
	socketType: CaSocketType;
	/** The display's own path+query, echoed back in the displayConfiguration bootstrap. */
	path: string;
	position?: string; // scoring panel position (red/blue)
}

export type CaSocket = ServerWebSocket<CaSocketData>;

// Notifier names, in the order CA bootstraps them per socket. `displayConfiguration` is a per-display
// notifier; `resetLocalState` is a scoring-panel-only one-off. These lists match ca-docs §5.1.
const SUBS: Record<CaSocketType, string[]> = {
	field_monitor: [
		"matchTiming",
		"displayConfiguration",
		"arenaStatus",
		"eventStatus",
		"realtimeScore",
		"matchTime",
		"matchLoad",
	],
	audience: [
		"matchTiming",
		"displayConfiguration",
		"audienceDisplayMode",
		"matchLoad",
		"matchTime",
		"realtimeScore",
		"playSound",
		"scorePosted",
		"allianceSelection",
		"lowerThird",
	],
	announcer: [
		"matchTiming",
		"displayConfiguration",
		"audienceDisplayMode",
		"eventStatus",
		"matchLoad",
		"matchTime",
		"realtimeScore",
		"scorePosted",
	],
	alliance_station: [
		"matchTiming",
		"displayConfiguration",
		"allianceStationDisplayMode",
		"arenaStatus",
		"matchLoad",
		"matchTime",
		"realtimeScore",
	],
	queueing: ["matchTiming", "displayConfiguration", "matchLoad", "matchTime", "eventStatus"],
	rankings: ["displayConfiguration", "eventStatus"],
	bracket: ["displayConfiguration", "matchLoad"],
	logo: ["displayConfiguration"],
	twitch: ["displayConfiguration"],
	wall: ["displayConfiguration", "matchTiming", "audienceDisplayMode", "matchLoad", "matchTime", "realtimeScore"],
	webpage: ["displayConfiguration"],
	placeholder: ["displayConfiguration"],
	alliance_selection: ["allianceSelection", "audienceDisplayMode"],
	setup_displays: ["displayConfiguration"],
	setup_lower_thirds: ["audienceDisplayMode"],
	setup_field_testing: ["arenaStatus"],
	match_play: [
		"matchTiming",
		"allianceStationDisplayMode",
		"arenaStatus",
		"audienceDisplayMode",
		"eventStatus",
		"matchLoad",
		"matchTime",
		"realtimeScore",
		"scorePosted",
		"scoringStatus",
	],
	scoring: ["matchLoad", "matchTime", "realtimeScore", "resetLocalState"],
	referee: ["matchLoad", "matchTime", "realtimeScore", "scoringStatus"],
	api_arena: ["matchTiming", "matchLoad", "matchTime"],
};

/** Notifiers with no producer that are never bootstrapped (event-only). */
const NON_BOOTSTRAP = new Set(["playSound", "reload"]);

export class CaNotifierHub {
	private sockets = new Set<CaSocket>();
	/** Scoring-panel positions that have committed their score this match, + referee-ready flag. */
	private scoreCommitted = new Set<string>();
	private refereeReady = false;

	constructor(
		private store: FmsStore,
		private controller: MatchController,
	) {}

	/** Clear per-match scoring readiness (called on match load). */
	resetScoring(): void {
		this.scoreCommitted.clear();
		this.refereeReady = false;
	}

	/** Compute the current payload for a notifier type (null = do not send). */
	private payload(type: string, socket: CaSocket): unknown {
		switch (type) {
			case "arenaStatus":
				return caArenaStatus(this.store);
			case "matchLoad":
				return caMatchLoad(this.store);
			case "matchTime":
				return caMatchTime(this.store);
			case "matchTiming":
				return caMatchTiming(this.store);
			case "eventStatus":
				return caEventStatus(this.store);
			case "realtimeScore":
				return caRealtimeScore(this.store);
			case "scorePosted":
				return caScorePosted(this.store);
			case "displayConfiguration":
				// CA's display.Notifier sends the DISPLAY path (Display.ToUrl), i.e. the socket path with
				// the trailing "/websocket" segment removed, e.g. "/displays/field_monitor?displayId=X".
				return socket.data.path.replace("/websocket", "");
			case "audienceDisplayMode":
				return this.audienceDisplayMode();
			case "allianceStationDisplayMode":
				return "match";
			case "scoringStatus":
				return this.scoringStatus();
			case "allianceSelection":
				return this.allianceSelection();
			case "lowerThird":
				return {
					LowerThird: this.store.getState().caLowerThird,
					ShowLowerThird: this.store.getState().caLowerThirdShowing,
				};
			case "resetLocalState":
				return null;
			default:
				return null;
		}
	}

	private audienceDisplayMode(): string {
		return caAudienceMode(this.store);
	}

	private scoringStatus(): unknown {
		const panelCount = (pos: string): number =>
			[...this.sockets].filter((s) => s.data.socketType === "scoring" && s.data.position === pos).length;
		const posStatus = (pos: string) => {
			const num = panelCount(pos);
			const ready = this.scoreCommitted.has(pos);
			return { Ready: num > 0 && ready, NumPanels: num, NumPanelsReady: ready ? num : 0 };
		};
		return {
			RefereeScoreReady: this.refereeReady,
			PositionStatuses: { red: posStatus("red"), blue: posStatus("blue") },
		};
	}

	private allianceSelection(): unknown {
		const state = this.store.getState();
		return {
			Alliances: state.alliances
				.filter((a) => (a.captainTeamNumber ?? 0) > 0)
				.map((a) => ({
					Id: a.allianceNumber,
					TeamIds: [a.captainTeamNumber, a.firstRoundTeamNumber, a.secondRoundTeamNumber, a.alternateTeamNumber]
						.map((n) => n ?? 0)
						.filter((n) => n > 0),
					Lineup: [a.firstRoundTeamNumber ?? 0, a.captainTeamNumber ?? 0, a.secondRoundTeamNumber ?? 0],
				})),
			ShowTimer: false,
			TimeRemainingSec: 0,
			RankedTeams: state.rankings.map((r) => ({
				Rank: r.rank,
				TeamId: r.teamNumber,
				Picked: r.pickStatus !== "None",
			})),
		};
	}

	private send(socket: CaSocket, type: string, data: unknown): void {
		const msg: CaMessage = { type, data };
		try {
			socket.send(JSON.stringify(msg));
		} catch {
			/* socket closing */
		}
	}

	// #region lifecycle

	open(socket: CaSocket): void {
		this.sockets.add(socket);
		// Bootstrap: one message per subscribed notifier with a producer, in CA's order.
		for (const type of SUBS[socket.data.socketType]) {
			if (NON_BOOTSTRAP.has(type)) continue;
			this.send(socket, type === "resetLocalState" ? "resetLocalState" : type, this.payload(type, socket));
		}
	}

	close(socket: CaSocket): void {
		this.sockets.delete(socket);
	}

	get connectionCount(): number {
		return this.sockets.size;
	}

	/** Emit a notifier to every socket subscribed to it (recomputing per socket where needed). */
	emit(type: string): void {
		for (const socket of this.sockets) {
			if (!SUBS[socket.data.socketType].includes(type)) continue;
			this.send(socket, type, this.payload(type, socket));
		}
	}

	/** Emit a raw-bodied notifier (playSound / reload / triggers) to subscribers. */
	emitRaw(type: string, data: unknown): void {
		for (const socket of this.sockets) {
			if (!SUBS[socket.data.socketType].includes(type)) continue;
			this.send(socket, type, data);
		}
	}

	ping(): void {
		for (const socket of this.sockets) this.send(socket, "ping", null);
	}

	/** Close every CA socket (used when the CA toggle is turned off). */
	closeAll(): void {
		for (const socket of this.sockets) {
			try {
				socket.close();
			} catch {
				/* already closing */
			}
		}
		this.sockets.clear();
	}

	// #endregion

	// #region commands (client -> server), dispatched per socket type

	message(socket: CaSocket, raw: string): void {
		let msg: CaMessage;
		try {
			msg = JSON.parse(raw) as CaMessage;
		} catch {
			return;
		}
		switch (socket.data.socketType) {
			case "match_play":
				this.handleMatchPlayCommand(msg.type, msg.data);
				break;
			case "scoring":
				this.handleScoringCommand(socket, msg.type, msg.data);
				break;
			case "referee":
				this.handleRefereeCommand(msg.type, msg.data);
				break;
			case "alliance_selection":
				this.handleAllianceSelectionCommand(msg.type, msg.data);
				break;
			case "setup_lower_thirds":
				this.handleLowerThirdCommand(msg.type, msg.data);
				break;
			case "setup_displays":
				this.handleSetupDisplaysCommand(msg.type, msg.data);
				break;
			case "setup_field_testing":
				this.handleFieldTestingCommand(msg.type, msg.data);
				break;
			case "alliance_station":
			case "field_monitor":
				this.handleFieldMonitorCommand(socket, msg.type, msg.data);
				break;
			default:
				break;
		}
	}

	private handleAllianceSelectionCommand(type: string, data: unknown): void {
		if (type === "setAudienceDisplay") {
			this.setAudienceMode(String(data));
		}
		// setTimer/startTimer/stopTimer/restartTimer/hideTimer drive the audience selection clock;
		// re-broadcast the current selection state (the FMS store owns the ceremony state).
		this.emit("allianceSelection");
	}

	private handleLowerThirdCommand(type: string, data: unknown): void {
		const d = data as { Id?: number; TopText?: string; BottomText?: string; DisplayOrder?: number; AwardId?: number };
		const record = {
			Id: d.Id ?? 1,
			TopText: d.TopText ?? "",
			BottomText: d.BottomText ?? "",
			DisplayOrder: d.DisplayOrder ?? 0,
			AwardId: d.AwardId ?? 0,
		};
		switch (type) {
			case "saveLowerThird":
				this.store.setCaLowerThird(record, this.store.getState().caLowerThirdShowing);
				break;
			case "showLowerThird":
				this.store.setCaLowerThird(record, true);
				this.emit("lowerThird");
				break;
			case "hideLowerThird":
				this.store.setCaLowerThird(this.store.getState().caLowerThird, false);
				this.emit("lowerThird");
				break;
			case "deleteLowerThird":
				this.store.setCaLowerThird(null, false);
				this.emit("lowerThird");
				break;
			case "setAudienceDisplay":
				this.setAudienceMode(String(data));
				break;
			default:
				break;
		}
	}

	private handleSetupDisplaysCommand(type: string, data: unknown): void {
		if (type === "reloadAllDisplays") this.emitRaw("reload", null);
		else if (type === "reloadDisplay") this.emitRaw("reload", String(data));
		else if (type === "configureDisplay") this.emit("displayConfiguration");
	}

	private handleFieldTestingCommand(type: string, data: unknown): void {
		if (type === "playSound") this.emitRaw("playSound", String(data));
		// setPlcCoilOverride / setLedMode drive hardware we don't model; accept silently.
	}

	private levelForCaMatchId(id: number): { level: TournamentLevel; matchNumber: number } {
		if (id >= 3000) return { level: "Playoff", matchNumber: id - 3000 };
		if (id >= 2000) return { level: "Qualification", matchNumber: id - 2000 };
		if (id >= 1000) return { level: "Practice", matchNumber: id - 1000 };
		return { level: "None", matchNumber: id };
	}

	private fmsStationForCa(caKey: string): StationKey | null {
		const idx = CA_STATIONS.indexOf(caKey as (typeof CA_STATIONS)[number]);
		return idx >= 0 ? (STATION_KEYS[idx] as StationKey) : null;
	}

	private handleMatchPlayCommand(type: string, data: unknown): void {
		switch (type) {
			case "loadMatch": {
				const id = (data as { MatchId?: number })?.MatchId ?? 0;
				this.store.setCaTimeout(null);
				if (id > 0) {
					const { level, matchNumber } = this.levelForCaMatchId(id);
					this.store.setCurrentMatch(matchNumber, 1, level);
				}
				this.controller.prestart();
				break;
			}
			case "showResult": {
				// Re-post a previously scored match to the audience.
				const id = (data as { MatchId?: number })?.MatchId ?? 0;
				if (id > 0) {
					const { level, matchNumber } = this.levelForCaMatchId(id);
					this.store.setCurrentMatch(matchNumber, 1, level);
				}
				this.emit("scorePosted");
				break;
			}
			case "substituteTeams": {
				const d = data as Record<string, number>;
				const entry = this.store
					.getState()
					.schedule.find(
						(e) =>
							e.matchNumber === this.store.getState().current.matchNumber &&
							e.level === this.store.getState().current.level,
					);
				if (entry && this.store.getState().current.level !== "Qualification") {
					entry.red = [d.Red1 ?? entry.red[0], d.Red2 ?? entry.red[1], d.Red3 ?? entry.red[2]];
					entry.blue = [d.Blue1 ?? entry.blue[0], d.Blue2 ?? entry.blue[1], d.Blue3 ?? entry.blue[2]];
					this.store.loadStationsFromMatch(entry.red, entry.blue);
					this.emit("matchLoad");
				}
				break;
			}
			case "toggleBypass": {
				const fmsKey = this.fmsStationForCa(String(data));
				if (fmsKey) this.store.setBypass(fmsKey, !this.store.getState().stations[fmsKey].bypassed);
				break;
			}
			case "startMatch": {
				if (this.store.getState().current.matchState !== "WaitingForMatchStart") this.controller.armMatch();
				this.controller.startMatch();
				break;
			}
			case "abortMatch":
				this.controller.abort();
				break;
			case "commitAndPost":
				this.controller.commitScores();
				this.controller.postResults();
				break;
			case "discardResults":
				this.controller.abort();
				break;
			case "signalVolunteers":
				this.emitRaw("playSound", "field_reset");
				break;
			case "signalReset":
				this.emitRaw("playSound", "field_reset");
				break;
			case "setAudienceDisplay":
				this.setAudienceMode(String(data));
				break;
			case "setAllianceStationDisplay":
				this.emit("allianceStationDisplayMode");
				break;
			case "startTimeout": {
				const dur = typeof data === "number" ? data : ((data as { DurationSec?: number })?.DurationSec ?? 0);
				const desc =
					typeof data === "object" ? ((data as { Description?: string })?.Description ?? "Field Break") : "Field Break";
				const next = typeof data === "object" ? ((data as { NextMatchName?: string })?.NextMatchName ?? "") : "";
				this.startTimeout(desc, next, dur);
				break;
			}
			case "setTimeoutDisplay": {
				const t = this.store.getState().caTimeout;
				if (t) {
					const d = data as { Description?: string; NextMatchName?: string };
					this.store.setCaTimeout({
						...t,
						description: d.Description ?? t.description,
						nextMatchName: d.NextMatchName ?? t.nextMatchName,
					});
					this.emit("matchLoad");
				}
				break;
			}
			case "setTestMatchName":
				break; // Test-match naming is cosmetic; no store field.
			default:
				break;
		}
	}

	private handleScoringCommand(socket: CaSocket, type: string, data: unknown): void {
		const pos = socket.data.position === "blue" ? "Blue" : "Red";
		switch (type) {
			case "commitMatch":
				if (caEffectiveMatchStateIsPost(this.store)) {
					this.scoreCommitted.add(socket.data.position ?? "red");
					this.emit("scoringStatus");
				}
				break;
			case "autoTower": {
				const d = data as { TeamPosition?: number; AutoTowerStatus?: number };
				this.store.setScoreField(pos, "autoClimbPoints", (d.AutoTowerStatus ?? 0) * 5);
				this.emit("realtimeScore");
				break;
			}
			case "endgame": {
				const d = data as { TeamPosition?: number; EndgameTowerStatus?: number };
				this.store.setScoreField(pos, "endgameClimbPoints", (d.EndgameTowerStatus ?? 0) * 10);
				this.emit("realtimeScore");
				break;
			}
			case "addFoul": {
				const d = data as { Alliance?: string; IsMajor?: boolean };
				const foulPos = d.Alliance === "blue" ? "Blue" : "Red";
				const cur = Number(this.store.getState().score[foulPos.toLowerCase() as "red" | "blue"].foulPoints) || 0;
				this.store.setScoreField(foulPos, "foulPoints", cur + (d.IsMajor ? 6 : 2));
				this.emit("realtimeScore");
				break;
			}
			default:
				break;
		}
	}

	private handleRefereeCommand(type: string, data: unknown): void {
		switch (type) {
			case "addFoul": {
				const d = data as { Alliance?: string; IsMajor?: boolean };
				const pos = d.Alliance === "blue" ? "Blue" : "Red";
				const cur = Number(this.store.getState().score[pos.toLowerCase() as "red" | "blue"].foulPoints) || 0;
				this.store.setScoreField(pos, "foulPoints", cur + (d.IsMajor ? 6 : 2));
				this.emit("realtimeScore");
				break;
			}
			case "card": {
				const d = data as { TeamId?: number; Card?: string };
				if (d.TeamId && d.Card === "yellow") this.store.setTeamCard(d.TeamId, "Yellow");
				else if (d.TeamId && (d.Card === "red" || d.Card === "dq")) this.store.setTeamCard(d.TeamId, "Red");
				break;
			}
			case "commitAndPost":
				this.refereeReady = true;
				this.emit("scoringStatus");
				this.controller.commitScores();
				this.controller.postResults();
				break;
			case "signalVolunteers":
			case "signalReset":
				this.emitRaw("playSound", "field_reset");
				break;
			default:
				break;
		}
	}

	private handleFieldMonitorCommand(socket: CaSocket, type: string, data: unknown): void {
		// field_monitor?fta=true supports updateTeamNotes; CA has no note store here beyond FtaNotes,
		// which fake-fms doesn't model for CA, so accept-and-ack (no-op) to avoid errors.
		if (type === "updateTeamNotes") return;
	}

	private setAudienceMode(mode: string): void {
		// Map a CA audience mode string back onto the FMS video switch so the store reflects it.
		const map: Record<string, string> = {
			intro: "MatchPreview",
			match: "VideoAndScore",
			score: "MatchResult",
			allianceSelection: "Alliance",
			bracket: "Bracket",
			timeout: "Timeout",
			blank: "Background",
			logo: "Message",
		};
		const opt = map[mode];
		if (opt) this.store.setVideoSwitch(opt as never);
		this.emit("audienceDisplayMode");
	}

	private startTimeout(description: string, nextMatchName: string, durationSec: number): void {
		this.store.setCaTimeout({
			description,
			nextMatchName,
			durationSec,
			startedAtMs: Date.now(),
			phase: "active",
		});
		this.emit("matchTiming");
		this.emit("matchLoad");
		this.emit("arenaStatus");
		this.emit("matchTime");
		this.emit("audienceDisplayMode");
	}

	// #endregion
}

/** Whether the CA field is in a post-match state (for scoring commits). */
function caEffectiveMatchStateIsPost(store: FmsStore): boolean {
	const ms = store.getState().current.matchState;
	return ms === "WaitingForCommit" || ms === "WaitingForPostResults";
}

// Re-export for the ca-fanout to reference match-id building without a projector import cycle.
export { caMatchId };
