// Capture real FMS report output (Bold Reports) using the exact PostReportAction flow observed in
// the browser: ReportLoad -> reportViewerToken -> GetPageModel{pageindex} -> ClearObjects.
// Saves each report's load + page models as fixtures so the emulator can replay them.
//
//   bun run scripts/capture-reports.ts <host> <outDir> [maxPages]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOST = process.argv[2] ?? "192.168.0.129";
const OUT = join(process.argv[3] ?? "./fms-capture", "reports");
const MAX_PAGES = Number(process.argv[4] ?? 3);
mkdirSync(OUT, { recursive: true });

const REPORTS = [
	"AnnouncerReportPlayoff", "AnnouncerReportQualification", "BackupRobotsReport", "BracketReport",
	"BypassReportPlayoff", "BypassReportPractice", "BypassReportQualification", "CardsReportPlayoff",
	"CardsReportQualification", "ConnectionTestSignsReport", "CouponReport", "CycleTimeReportPlayoff",
	"CycleTimeReportPractice", "CycleTimeReportQualification", "DistrictRankingEventReport", "EventListReport",
	"FtaNotesByMatchReport", "FtaNotesByTeamReport", "HeadRefTrackingReport", "LineupCardsReport",
	"MatchResultsReportPlayoff", "MatchResultsReportQualification", "RankingPlayoffsReport", "RankingReport",
	"RegionalRankingEventReport", "ScheduleReportByTeam", "ScheduleReportPlayoff", "ScheduleReportPractice",
	"ScheduleReportQualification", "TeamListReport", "TeamListWPAReportNoKeys",
];

const ACTION_URL = `http://${HOST}/Reports/PostReportAction`;

function reportParams(rt: string) {
	return [{ name: "reportType", labels: [rt], values: [rt] }];
}

async function post(body: unknown, referer: string): Promise<{ status: number; text: string }> {
	const res = await fetch(ACTION_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=UTF-8", Referer: referer, Origin: `http://${HOST}` },
		body: JSON.stringify(body),
	});
	return { status: res.status, text: await res.text() };
}

function findToken(text: string): string | null {
	try {
		const j = JSON.parse(text) as Record<string, unknown>;
		for (const k of ["reportViewerToken", "token", "reportViewerId"]) {
			if (typeof j[k] === "string" && j[k]) return j[k] as string;
		}
	} catch {
		/* fall through to regex */
	}
	return text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
}

async function captureReport(rt: string): Promise<{ rt: string; ok: boolean; pages: number; bytes: number }> {
	const referer = `http://${HOST}/ReportViewer/${rt}`;
	const load = await post(
		{
			reportAction: "ReportLoad",
			parameters: reportParams(rt),
			isReloadReport: false,
			controlId: "reportViewer_Control",
			reportPath: "",
			enableVirtualEvaluation: false,
			smartRendering: false,
			reportServerUrl: "",
			processingMode: "Local",
			locale: "en-US",
			enableSearchText: false,
		},
		referer,
	);
	writeFileSync(join(OUT, `${rt}.load.json`), `// [HTTP ${load.status}]\n${load.text}`);
	const token = findToken(load.text);
	if (!token) return { rt, ok: false, pages: 0, bytes: load.text.length };

	let pages = 0;
	let bytes = 0;
	for (let p = 1; p <= MAX_PAGES; p++) {
		const page = await post(
			{
				reportAction: "GetPageModel",
				refresh: false,
				dataRefresh: false,
				pageindex: p,
				pageInit: false,
				isPrint: false,
				dataSources: null,
				parameters: reportParams(rt),
				reportViewerToken: token,
				reportViewerClientId: token,
			},
			referer,
		);
		writeFileSync(join(OUT, `${rt}.page${p}.json`), `// [HTTP ${page.status}]\n${page.text}`);
		bytes += page.text.length;
		if (page.status === 200 && page.text.length > 50) pages = p;
		// If the report has fewer pages, the server typically returns an error/empty page; stop early.
		if (page.text.includes("errorInfo") || page.text.length < 50) break;
	}
	// Clean up the server-side viewer session.
	await post(
		{ reportAction: "ClearObjects", reportViewerToken: token, previousAction: "GetPageModel", isPrint: false, reportViewerClientId: token },
		referer,
	).catch(() => undefined);

	return { rt, ok: true, pages, bytes };
}

async function main(): Promise<void> {
	console.log(`Capturing ${REPORTS.length} reports from ${HOST}...`);
	const index: Array<{ rt: string; ok: boolean; pages: number; bytes: number }> = [];
	for (const rt of REPORTS) {
		const r = await captureReport(rt).catch((e) => ({ rt, ok: false, pages: 0, bytes: 0, err: String(e) }));
		index.push(r);
		console.log(`  ${r.ok ? "ok " : "FAIL"} ${rt}  pages=${r.pages} bytes=${r.bytes}`);
	}
	writeFileSync(join(OUT, "_index.json"), JSON.stringify(index, null, 2));
	const ok = index.filter((i) => i.ok && i.pages > 0).length;
	console.log(`Done. ${ok}/${index.length} reports captured with page data -> ${OUT}`);
}

void main();
