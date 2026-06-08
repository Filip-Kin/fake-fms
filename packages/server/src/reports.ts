// #region Bold Reports PostReportAction emulation

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { json } from "./http";

// Real FMS renders RDL reports with Bold Reports; the Angular viewer drives everything through
// POST /Reports/PostReportAction with a `reportAction` discriminator. We replay the exact captured
// responses (committed under reports-fixtures/, one <ReportType>.load.json + <ReportType>.page1.json
// per type; the three Practice variants carry the real RV000034 "no schedule" error inline).
const FIXTURE_DIR = join(import.meta.dir, "..", "reports-fixtures");

interface ReportParameter {
	name?: string;
	values?: string[];
}

interface ReportActionBody {
	reportAction?: string;
	pageindex?: number;
	parameters?: ReportParameter[];
}

/** Pull the report type from the request parameters (the viewer sends it as a named parameter). */
function reportTypeOf(body: ReportActionBody): string | null {
	const params = body.parameters ?? [];
	const named = params.find((p) => p.name === "reportType");
	return named?.values?.[0] ?? params[0]?.values?.[0] ?? null;
}

/** Serve a fixture file verbatim if it exists, else null. */
function fixture(name: string): Response | null {
	const path = join(FIXTURE_DIR, name);
	if (!existsSync(path)) return null;
	return new Response(readFileSync(path, "utf8"), {
		headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
	});
}

/** Handle POST /Reports/PostReportAction. Returns null if not a reports request. */
export async function handleReports(req: Request, pathname: string): Promise<Response | null> {
	if (pathname !== "/Reports/PostReportAction") return null;
	if (req.method !== "POST") return json({ errorInfo: { Code: "RV000000", Message: "POST required" } });

	let body: ReportActionBody;
	try {
		body = (await req.json()) as ReportActionBody;
	} catch {
		return json({ errorInfo: { Code: "RV000000", Message: "Invalid request body" } });
	}

	const action = body.reportAction;
	const rt = reportTypeOf(body);

	if (action === "ReportLoad") {
		const res = rt && fixture(`${rt}.load.json`);
		if (res) return res;
		return json({
			isReportLoad: true,
			errorInfo: { Code: "RV000001", Message: `No fixture for report type ${rt ?? "(none)"}` },
		});
	}

	if (action === "GetPageModel") {
		const page = (body.pageindex ?? 0) + 1; // viewer pageindex is 0-based; fixtures are page1..n
		const res = (rt && (fixture(`${rt}.page${page}.json`) ?? fixture(`${rt}.page1.json`))) || null;
		if (res) return res;
		return json({ errorInfo: { Code: "RV000001", Message: `No page fixture for ${rt ?? "(none)"}` } });
	}

	if (action === "ClearObjects") return json({ isClearObject: true });

	// exporting / export and any other action: acknowledge without a captured fixture.
	return json({ inProgress: "completed" });
}

// #endregion
