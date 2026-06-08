import {
	listGameModules,
	type LogFaultSpec,
	type StationKey,
	type StationPart,
	STATION_KEYS,
	type TournamentLevel,
	type VideoSwitchOption,
} from "shared";
import { json, notFound } from "../http";
import type { MatchController } from "../match/controller";
import { genWpaKey } from "../state/seed";
import type { FmsStore } from "../state/store";

function isStationKey(k: string): k is StationKey {
	return (STATION_KEYS as readonly string[]).includes(k);
}

async function body(req: Request): Promise<Record<string, unknown>> {
	try {
		return (await req.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Handle a control-plane request (everything under /control). Returns null if unmatched. */
export async function handleControl(
	store: FmsStore,
	controller: MatchController,
	req: Request,
	url: URL,
): Promise<Response | null> {
	const p = url.pathname;
	if (!p.startsWith("/control") && p !== "/games") return null;

	// #region reads
	if (p === "/control/state") return json(store.getState());
	if (p === "/games") return json(listGameModules().map((m) => ({ id: m.id, season: m.season })));
	// #endregion

	if (req.method !== "POST") return notFound();
	const b = await body(req);

	// #region event / teams / schedule / game
	if (p === "/control/event") {
		store.updateEvent(b as Partial<ReturnType<FmsStore["getState"]>["event"]>);
		return json({ ok: true });
	}
	if (p === "/control/game") {
		store.setGameModule(String(b.id));
		return json({ ok: true });
	}
	if (p === "/control/level") {
		store.setTournamentLevel(b.level as TournamentLevel);
		return json({ ok: true });
	}
	if (p === "/control/video") {
		store.setVideoSwitch(b.option as VideoSwitchOption);
		return json({ ok: true });
	}
	if (p === "/control/team/add") {
		store.addTeam({ number: Number(b.number), name: String(b.name ?? `Team ${b.number}`), wpaKey: genWpaKey() });
		return json({ ok: true });
	}
	if (p === "/control/team/remove") {
		store.removeTeam(Number(b.number));
		return json({ ok: true });
	}
	if (p === "/control/wpa/generate") {
		const teams = store.getState().teams;
		if (b.number != null) {
			const t = teams.find((x) => x.number === Number(b.number));
			if (t) t.wpaKey = genWpaKey();
		} else {
			for (const t of teams) t.wpaKey = genWpaKey();
		}
		store.setTeams([...teams]);
		return json({ ok: true });
	}
	if (p === "/control/schedule") {
		store.setSchedule(b.schedule as ReturnType<FmsStore["getState"]>["schedule"]);
		return json({ ok: true });
	}
	// #endregion

	// #region match lifecycle
	if (p === "/control/match/select") {
		store.setCurrentMatch(Number(b.matchNumber), Number(b.playNumber ?? 1), b.level as TournamentLevel);
		return json({ ok: true });
	}
	if (p === "/control/match/prestart") {
		controller.prestart();
		return json({ ok: true });
	}
	if (p === "/control/match/show-preview") {
		controller.showMatchPreview();
		return json({ ok: true });
	}
	if (p === "/control/match/preview") {
		controller.setAudience();
		return json({ ok: true });
	}
	if (p === "/control/match/arm") {
		controller.armMatch();
		return json({ ok: true });
	}
	if (p === "/control/match/start") {
		controller.startMatch();
		return json({ ok: true });
	}
	if (p === "/control/match/commit") {
		controller.commitScores();
		return json({ ok: true });
	}
	if (p === "/control/match/post") {
		controller.postResults();
		return json({ ok: true });
	}
	if (p === "/control/match/abort") {
		controller.abort();
		return json({ ok: true });
	}
	// #endregion

	// #region log faults
	if (p === "/control/faults/set") {
		// { matchId, robot, faults: LogFaultSpec[] }
		store.setLogFaults(String(b.matchId), String(b.robot), (b.faults as LogFaultSpec[]) ?? []);
		return json({ ok: true });
	}
	if (p === "/control/faults/clear") {
		store.clearLogFaults(b.matchId ? String(b.matchId) : undefined);
		return json({ ok: true });
	}
	if (p === "/control/autoplay") {
		// { replayLogs?: boolean, autoFaults?: boolean }
		const patch: Partial<ReturnType<FmsStore["getState"]>["autoplay"]> = {};
		if (b.replayLogs !== undefined) patch.replayLogs = Boolean(b.replayLogs);
		if (b.autoFaults !== undefined) patch.autoFaults = Boolean(b.autoFaults);
		store.setAutoplay(patch);
		return json({ ok: true });
	}
	// #endregion

	// #region field monitor stations
	// Cycle one indicator: /control/station/:key/cycle/:part  (part = ds|radio|rio|code)
	const partMatch = p.match(/^\/control\/station\/(\w+)\/cycle\/(ds|radio|rio|code)$/);
	if (partMatch) {
		const key = partMatch[1] as string;
		if (!isStationKey(key)) return notFound();
		store.cycleStationPart(key, partMatch[2] as StationPart);
		return json({ ok: true });
	}
	// Toggle overlays: /control/station/:key/(bypass|estop|astop)
	const toggleMatch = p.match(/^\/control\/station\/(\w+)\/(bypass|estop|astop)$/);
	if (toggleMatch) {
		const key = toggleMatch[1] as string;
		if (!isStationKey(key)) return notFound();
		const on = Boolean(b.on);
		if (toggleMatch[2] === "bypass") store.setBypass(key, on);
		else if (toggleMatch[2] === "estop") store.setEstop(key, on);
		else store.setAstop(key, on);
		return json({ ok: true });
	}
	if (p === "/control/stations/reset") {
		store.resetStations();
		return json({ ok: true });
	}
	// #endregion

	// #region scoring
	if (p === "/control/score") {
		store.setScoreField(b.alliance as "Red" | "Blue", String(b.key), b.value as number | boolean);
		return json({ ok: true });
	}
	if (p === "/control/score/reset") {
		store.resetScores();
		return json({ ok: true });
	}
	// #endregion

	// #region alliance selection
	if (p === "/control/alliance/type") {
		store.setAllianceSelectionType(b.type as "TwoTeam" | "ThreeTeam" | "FourTeam");
		return json({ ok: true });
	}
	if (p === "/control/alliance/start") {
		store.allianceStart();
		return json({ ok: true });
	}
	if (p === "/control/alliance/pick") {
		const ok = store.alliancePick(Number(b.teamNumber));
		return json({ ok });
	}
	if (p === "/control/alliance/decline") {
		store.allianceDecline(Number(b.teamNumber), b.on === undefined ? true : Boolean(b.on));
		return json({ ok: true });
	}
	if (p === "/control/alliance/skip") {
		return json({ ok: store.allianceSkip() });
	}
	if (p === "/control/alliance/undo") {
		return json({ ok: store.allianceUndoPick() });
	}
	if (p === "/control/alliance/save") {
		store.allianceSave();
		return json({ ok: true });
	}
	// #endregion

	return notFound();
}
