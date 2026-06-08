import {
	listGameModules,
	type StationCycle,
	type StationKey,
	STATION_KEYS,
	type TournamentLevel,
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
	if (p === "/control/match/preview") {
		controller.setAudienceReady();
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
	if (p === "/control/match/abort") {
		controller.abort();
		return json({ ok: true });
	}
	if (p === "/control/match/next") {
		controller.advanceToNextMatch();
		return json({ ok: true });
	}
	if (p === "/control/autopilot") {
		controller.setAutopilot(Boolean(b.on));
		return json({ ok: true });
	}
	// #endregion

	// #region field monitor stations
	const stationMatch = p.match(/^\/control\/station\/(\w+)\/(\w+)$/);
	if (stationMatch) {
		const key = stationMatch[1] as string;
		const action = stationMatch[2] as string;
		if (!isStationKey(key)) return notFound();
		switch (action) {
			case "cycle":
				store.cycleStation(key);
				return json({ ok: true });
			case "set":
				store.setStationCycle(key, b.cycle as StationCycle);
				return json({ ok: true });
			case "bypass":
				store.setBypass(key, Boolean(b.on));
				return json({ ok: true });
			case "estop":
				store.setEstop(key, Boolean(b.on));
				return json({ ok: true });
			case "astop":
				store.setAstop(key, Boolean(b.on));
				return json({ ok: true });
			default:
				return notFound();
		}
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

	return notFound();
}
