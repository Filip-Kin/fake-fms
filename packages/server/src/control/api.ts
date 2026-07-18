import {
	FAULT_TYPES,
	listGameModules,
	STATION_KEYS,
	type StationKey,
	type StationPart,
	VIDEO_SWITCH_OPTIONS,
} from "shared";
import { z } from "zod";
import { json, notFound } from "../http";
import type { MatchController } from "../match/controller";
import { genWpaKey } from "../state/seed";
import type { FmsStore } from "../state/store";
import { fetchAvatar } from "../tba";
import type { TestSequenceRunner } from "./test-sequence";

function isStationKey(k: string): k is StationKey {
	return (STATION_KEYS as readonly string[]).includes(k);
}

// #region validation

const levelSchema = z.enum(["None", "Practice", "Qualification", "Playoff"]);
const videoSchema = z.enum(VIDEO_SWITCH_OPTIONS);
const allianceSchema = z.enum(["Red", "Blue"]);
const matchNumberSchema = z.number().int().finite();

const eventPatchSchema = z
	.object({
		code: z.string(),
		name: z.string(),
		location: z.string(),
		season: z.number().int().finite(),
		tournamentType: z.string(),
		level: levelSchema,
		videoSwitchOption: videoSchema,
		fmsEventId: z.string(),
		fmsEventPassword: z.string(),
		fmsVersion: z.string(),
	})
	.partial();

const teamTripleSchema = z.tuple([z.number().int(), z.number().int(), z.number().int()]);

const scheduleEntrySchema = z.object({
	fmsMatchId: z.string(),
	matchNumber: matchNumberSchema,
	playNumber: z.number().int().finite(),
	level: levelSchema,
	description: z.string(),
	scheduledStartTime: z.string(),
	actualStartTime: z.string().nullable(),
	red: teamTripleSchema,
	blue: teamTripleSchema,
	status: z.enum(["Pending", "Played"]),
	finalScoreRed: z.number().nullable(),
	finalScoreBlue: z.number().nullable(),
	redAllianceNumber: z.number().int().nullable(),
	blueAllianceNumber: z.number().int().nullable(),
});

const faultSpecSchema = z.object({
	type: z.enum(FAULT_TYPES),
	startSec: z.number().finite().optional(),
	durationSec: z.number().finite().optional(),
});

/** Read + parse the JSON body. `invalid` means the body was present but not valid JSON (-> 400). */
async function readBody(req: Request): Promise<{ invalid: boolean; value: unknown }> {
	const text = await req.text();
	if (text.trim().length === 0) return { invalid: false, value: {} };
	try {
		return { invalid: false, value: JSON.parse(text) };
	} catch {
		return { invalid: true, value: null };
	}
}

/** 400 with the validation problem, logged server-side and returned to the caller. */
function badRequest(path: string, detail: string): Response {
	console.error(`[control] ${path} rejected: ${detail}`);
	return json({ ok: false, error: detail }, 400);
}

function zodDetail(error: z.ZodError): string {
	return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

// #endregion

/** Handle a control-plane request (everything under /control). Returns null if unmatched. */
export async function handleControl(
	store: FmsStore,
	controller: MatchController,
	testSequence: TestSequenceRunner,
	req: Request,
	url: URL,
): Promise<Response | null> {
	const p = url.pathname;
	if (!p.startsWith("/control") && p !== "/games") return null;

	// #region reads
	if (p === "/control/state") return json(store.getState());
	if (p === "/control/test") return json(testSequence.status());
	if (p === "/games") return json(listGameModules().map((m) => ({ id: m.id, season: m.season })));
	// #endregion

	if (req.method !== "POST") return notFound();
	const body = await readBody(req);
	if (body.invalid) return badRequest(p, "request body is not valid JSON");
	const b = body.value;

	/** Validate the body against a schema; on failure the caller gets a 400 with the issues. */
	const parse = <T>(schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; response: Response } => {
		const result = schema.safeParse(b);
		if (result.success) return { ok: true, data: result.data };
		return { ok: false, response: badRequest(p, zodDetail(result.error)) };
	};

	// #region event / teams / schedule / game
	if (p === "/control/event") {
		const r = parse(eventPatchSchema);
		if (!r.ok) return r.response;
		store.updateEvent(r.data);
		return json({ ok: true });
	}
	if (p === "/control/game") {
		const r = parse(z.object({ id: z.string().min(1) }));
		if (!r.ok) return r.response;
		store.setGameModule(r.data.id);
		return json({ ok: true });
	}
	if (p === "/control/level") {
		const r = parse(z.object({ level: levelSchema }));
		if (!r.ok) return r.response;
		store.setTournamentLevel(r.data.level);
		return json({ ok: true });
	}
	if (p === "/control/video") {
		const r = parse(z.object({ option: videoSchema }));
		if (!r.ok) return r.response;
		store.setVideoSwitch(r.data.option);
		return json({ ok: true });
	}
	if (p === "/control/team/add") {
		const r = parse(z.object({ number: z.number().int().positive(), name: z.string().optional() }));
		if (!r.ok) return r.response;
		const avatar = await fetchAvatar(r.data.number, store.getState().event.season);
		store.addTeam({ number: r.data.number, name: r.data.name ?? `Team ${r.data.number}`, wpaKey: genWpaKey(), avatar });
		return json({ ok: true });
	}
	if (p === "/control/team/remove") {
		const r = parse(z.object({ number: z.number().int() }));
		if (!r.ok) return r.response;
		store.removeTeam(r.data.number);
		return json({ ok: true });
	}
	if (p === "/control/wpa/generate") {
		const r = parse(z.object({ number: z.number().int().optional() }));
		if (!r.ok) return r.response;
		const teams = store.getState().teams;
		if (r.data.number != null) {
			const t = teams.find((x) => x.number === r.data.number);
			if (t) t.wpaKey = genWpaKey();
		} else {
			for (const t of teams) t.wpaKey = genWpaKey();
		}
		store.setTeams([...teams]);
		return json({ ok: true });
	}
	if (p === "/control/schedule") {
		const r = parse(z.object({ schedule: z.array(scheduleEntrySchema) }));
		if (!r.ok) return r.response;
		store.setSchedule(r.data.schedule);
		return json({ ok: true });
	}
	// #endregion

	// #region match lifecycle
	if (p === "/control/match/select") {
		const r = parse(
			z.object({
				matchNumber: matchNumberSchema,
				playNumber: z.number().int().positive().optional(),
				level: levelSchema.optional(),
			}),
		);
		if (!r.ok) return r.response;
		store.setCurrentMatch(r.data.matchNumber, r.data.playNumber ?? 1, r.data.level ?? store.getState().current.level);
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
		const r = parse(
			z.object({
				matchId: z.string().min(1),
				robot: z.enum(STATION_KEYS),
				faults: z.array(faultSpecSchema).optional(),
			}),
		);
		if (!r.ok) return r.response;
		store.setLogFaults(r.data.matchId, r.data.robot, r.data.faults ?? []);
		return json({ ok: true });
	}
	if (p === "/control/faults/clear") {
		const r = parse(z.object({ matchId: z.string().optional() }));
		if (!r.ok) return r.response;
		store.clearLogFaults(r.data.matchId);
		return json({ ok: true });
	}
	if (p === "/control/autoplay") {
		const r = parse(z.object({ replayLogs: z.boolean().optional(), autoFaults: z.boolean().optional() }));
		if (!r.ok) return r.response;
		const patch: Partial<ReturnType<FmsStore["getState"]>["autoplay"]> = {};
		if (r.data.replayLogs !== undefined) patch.replayLogs = r.data.replayLogs;
		if (r.data.autoFaults !== undefined) patch.autoFaults = r.data.autoFaults;
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
		const r = parse(z.object({ on: z.boolean().optional() }));
		if (!r.ok) return r.response;
		const on = r.data.on ?? false;
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
		const r = parse(
			z.object({
				alliance: allianceSchema,
				key: z.string().min(1),
				value: z.union([z.number().finite(), z.boolean()]),
			}),
		);
		if (!r.ok) return r.response;
		store.setScoreField(r.data.alliance, r.data.key, r.data.value);
		return json({ ok: true });
	}
	if (p === "/control/score/reset") {
		store.resetScores();
		return json({ ok: true });
	}
	// #endregion

	// #region alliance selection
	if (p === "/control/alliance/type") {
		const r = parse(z.object({ type: z.enum(["TwoTeam", "ThreeTeam", "FourTeam"]) }));
		if (!r.ok) return r.response;
		store.setAllianceSelectionType(r.data.type);
		return json({ ok: true });
	}
	if (p === "/control/alliance/start") {
		store.allianceStart();
		return json({ ok: true });
	}
	if (p === "/control/alliance/pick") {
		const r = parse(z.object({ teamNumber: z.number().int().positive() }));
		if (!r.ok) return r.response;
		return json({ ok: store.alliancePick(r.data.teamNumber) });
	}
	if (p === "/control/alliance/decline") {
		const r = parse(z.object({ teamNumber: z.number().int().positive(), on: z.boolean().optional() }));
		if (!r.ok) return r.response;
		store.allianceDecline(r.data.teamNumber, r.data.on ?? true);
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
	if (p === "/control/alliance/reset") {
		store.allianceReset();
		return json({ ok: true });
	}
	// #endregion

	// #region audience-display test sequence
	if (p === "/control/test/play") {
		const r = parse(z.object({ from: z.number().int().min(0).optional() }));
		if (!r.ok) return r.response;
		testSequence.play(r.data.from);
		return json({ ok: true });
	}
	if (p === "/control/test/goto") {
		const r = parse(z.object({ index: z.number().int().min(0) }));
		if (!r.ok) return r.response;
		testSequence.goto(r.data.index);
		return json({ ok: true });
	}
	if (p === "/control/test/pause") {
		testSequence.pause();
		return json({ ok: true });
	}
	// #endregion

	return notFound();
}
