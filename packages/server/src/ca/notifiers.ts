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
	| "match_play"
	| "scoring"
	| "referee"
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

	constructor(
		private store: FmsStore,
		private controller: MatchController,
	) {}

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
				return socket.data.path;
			case "audienceDisplayMode":
				return this.audienceDisplayMode();
			case "allianceStationDisplayMode":
				return "match";
			case "scoringStatus":
				return this.scoringStatus();
			case "allianceSelection":
				return this.allianceSelection();
			case "lowerThird":
				return { LowerThird: null, ShowLowerThird: false };
			case "resetLocalState":
				return null;
			default:
				return null;
		}
	}

	private audienceDisplayMode(): string {
		const ms = this.store.getState().current.matchState;
		if (ms === "WaitingForPostResults" || ms === "WaitingForCommit") return "score";
		if (ms === "MatchAuto" || ms === "MatchTeleop" || ms === "MatchTransition") return "match";
		return "blank";
	}

	private scoringStatus(): unknown {
		return {
			RefereeScoreReady: false,
			PositionStatuses: {
				red: { Ready: false, NumPanels: 0, NumPanelsReady: 0 },
				blue: { Ready: false, NumPanels: 0, NumPanelsReady: 0 },
			},
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

	// #region commands (match_play)

	message(socket: CaSocket, raw: string): void {
		if (socket.data.socketType !== "match_play") return; // only match_play accepts commands
		let msg: CaMessage;
		try {
			msg = JSON.parse(raw) as CaMessage;
		} catch {
			return;
		}
		this.handleMatchPlayCommand(msg.type, msg.data);
	}

	private levelForCaMatchId(id: number): { level: TournamentLevel; matchNumber: number } {
		if (id >= 3000) return { level: "Playoff", matchNumber: id - 3000 };
		if (id >= 2000) return { level: "Qualification", matchNumber: id - 2000 };
		if (id >= 1000) return { level: "Practice", matchNumber: id - 1000 };
		return { level: "None", matchNumber: id };
	}

	private handleMatchPlayCommand(type: string, data: unknown): void {
		switch (type) {
			case "loadMatch": {
				const id = (data as { MatchId?: number })?.MatchId ?? 0;
				if (id > 0) {
					const { level, matchNumber } = this.levelForCaMatchId(id);
					this.store.setCurrentMatch(matchNumber, 1, level);
				}
				this.controller.prestart();
				break;
			}
			case "toggleBypass": {
				const caKey = String(data);
				const idx = CA_STATIONS.indexOf(caKey as (typeof CA_STATIONS)[number]);
				if (idx >= 0) {
					const fmsKey = STATION_KEYS[idx] as StationKey;
					const cur = this.store.getState().stations[fmsKey].bypassed;
					this.store.setBypass(fmsKey, !cur);
				}
				break;
			}
			case "startMatch": {
				const ms = this.store.getState().current.matchState;
				// CA start needs the field armed; arm it if the operator hasn't.
				if (ms !== "WaitingForMatchStart") this.controller.armMatch();
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
			default:
				break;
		}
	}

	// #endregion
}

// Re-export for the ca-fanout to reference match-id building without a projector import cycle.
export { caMatchId };
