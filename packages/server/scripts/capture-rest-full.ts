// One-shot capture of EVERY documented read-only FMS REST endpoint (from FMS-API-Doc), not just
// the ones the emulator implements. Parses the doc markdown for `Base route` + `### GET` entries,
// fills path params from live FMS state, and records status+body. Safe to run against real FMS:
// it ONLY calls read endpoints (Get*/get_*/Count*); FMS's mutating GETs (Update*/Set*/Reload*/
// Recalculate*/Create*/Modify*/Delete*/GetOrMake*) are excluded so the live match isn't altered.
//
//   bun run scripts/capture-rest-full.ts <host> <docsDir> <outDir>
//   e.g. bun run scripts/capture-rest-full.ts 192.168.0.129 /tmp/fms-api-doc ./fms-capture

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOST = process.argv[2] ?? "192.168.0.129";
const DOCS = process.argv[3] ?? "/tmp/fms-api-doc";
const OUT = process.argv[4] ?? "./fms-capture";
const dir = join(OUT, "rest-full");
mkdirSync(dir, { recursive: true });

// #region parse docs

interface Doc {
	base: string;
	gets: string[]; // subpaths after base, e.g. "/get/GetAlliances"
	extendsEventBase: boolean;
}

function parseFile(path: string): Doc {
	const txt = readFileSync(path, "utf8");
	const base = txt.match(/Base route:\s*`([^`]+)`/)?.[1] ?? "";
	const gets: string[] = [];
	for (const m of txt.matchAll(/^###\s+GET\s+`([^`]+)`/gm)) gets.push(m[1] as string);
	return { base, gets, extendsEventBase: /Event Base API/.test(txt) };
}

function isReadOnly(sub: string): boolean {
	if (/\.ToString\(\)|\+/.test(sub)) return false; // skip literal C# expressions in docs
	const fn = sub.split("/").filter(Boolean).pop() ?? "";
	const name = fn.split("?")[0] ?? "";
	if (/^(Update|Set|Reload|Recalculate|Create|Modify|Delete|Post|GetOrMake)/.test(name)) return false;
	return /^(Get|get_|Count|CurrentlyActive|TournamentLevelHas|TimeoutStatus|Api_Get)/.test(name);
}

// #endregion

// #region live context for path params

async function getJson(path: string): Promise<unknown> {
	try {
		const r = await fetch(`http://${HOST}${path}`);
		return await r.json();
	} catch {
		return null;
	}
}

interface Ctx {
	matchNumber: number;
	level: string;
	teamNumber: number;
	matchId: string;
	eventId: string;
	scheduleDetailId: string;
}

function fill(path: string, c: Ctx): string {
	return path
		.replace(/\{matchNumber\}/gi, String(c.matchNumber))
		.replace(/\{(tourney|tournament)?level\}/gi, c.level)
		.replace(/\{teamNumber\}/gi, String(c.teamNumber))
		.replace(/\{(fms)?matchId\}/gi, c.matchId)
		.replace(/\{guid\}/gi, c.matchId)
		.replace(/\{(fms)?eventId\}/gi, c.eventId)
		.replace(/\{fmsScheduleDetailId\}/gi, c.scheduleDetailId)
		.replace(/\{playoffSize\}/gi, "EightAlliance")
		.replace(/\{sublevel\}/gi, "1")
		.replace(/\{alliance\}/gi, "Red")
		.replace(/\{station\}/gi, "Station1")
		.replace(/\{playoffLevel\}/gi, "Final")
		.replace(/\{series\}/gi, "0")
		.replace(/\{[^}]+\}/g, "0"); // any remaining param -> 0
}

// #endregion

async function main(): Promise<void> {
	// Build endpoint list from docs.
	const files = readdirSync(join(DOCS, "api"))
		.filter((f) => f.endsWith(".md"))
		.map((f) => join(DOCS, "api", f))
		.concat(
			readdirSync(join(DOCS, "gamespecific-api"))
				.filter((f) => /^2026.*\.md$/.test(f))
				.map((f) => join(DOCS, "gamespecific-api", f)),
		);

	const eventBase = parseFile(join(DOCS, "api", "eventbase.md"));
	const urls = new Set<string>();
	for (const file of files) {
		const d = parseFile(file);
		if (!d.base) continue;
		for (const sub of d.gets) if (isReadOnly(sub)) urls.add(d.base + sub);
		// Services that extend Event Base inherit its endpoints under their own base.
		if (d.extendsEventBase) for (const sub of eventBase.gets) if (isReadOnly(sub)) urls.add(d.base + sub);
	}

	// Live context for path params.
	const cur = (await getJson("/api/v1.0/audience/get/GetCurrentMatchAndPlayNumber")) as
		| { item1?: string; item2?: number }
		| null;
	const sched = (await getJson("/api/v1.0/match/get/GetCurrentSchedule")) as
		| Array<{ matchNumber: number; fmsMatchId?: string; scheduleDetailId?: string; teamNumberRed1?: number }>
		| null;
	const teams = (await getJson("/api/v1.0/match/get/GetAllTeamNumbers")) as number[] | null;
	const first = sched?.[0];
	const ctx: Ctx = {
		matchNumber: cur?.item2 ?? 1,
		level: cur?.item1 ?? "Qualification",
		teamNumber: teams?.[0] ?? first?.teamNumberRed1 ?? 1,
		matchId: first?.fmsMatchId ?? "00000000-0000-0000-0000-000000000000",
		eventId: "00000000-0000-0000-0000-000000000000",
		scheduleDetailId: first?.scheduleDetailId ?? first?.fmsMatchId ?? "0",
	};

	console.log(`Capturing ${urls.size} documented read-only endpoints from ${HOST}...`);
	const index: { path: string; status: number; bytes: number }[] = [];
	for (const raw of [...urls].sort()) {
		const path = fill(raw, ctx);
		let status = 0;
		let body = "";
		try {
			const r = await fetch(`http://${HOST}${path}`);
			status = r.status;
			body = await r.text();
		} catch (e) {
			body = String(e);
		}
		const name = path.replace(/^\//, "").replace(/[/?=&:]/g, "_").slice(0, 180);
		writeFileSync(join(dir, `${name}.json`), `// ${raw}\n// -> ${path}  [HTTP ${status}]\n${body}`);
		index.push({ path, status, bytes: body.length });
	}
	writeFileSync(join(dir, "_index.json"), JSON.stringify(index, null, 2));
	const ok = index.filter((i) => i.status === 200 && i.bytes > 0).length;
	console.log(`Done. ${ok}/${index.length} returned 200 with data. Index: ${join(dir, "_index.json")}`);
}

void main();
