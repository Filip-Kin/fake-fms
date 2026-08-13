/**
 * Cheesy Arena HTTP surface: the /api/* JSON endpoints external tools consume, plus minimal display
 * HTML pages, mirroring CA's routes (ca-docs §2, §4). JSON is pretty-printed with 2-space indent and
 * PascalCase keys with integer enums, exactly like CA's MarshalIndent output. The websocket routes are
 * resolved to a socket type for the server to upgrade.
 */
import { CORS_HEADERS } from "../http";
import type { FmsStore } from "../state/store";
import type { CaSocketType } from "./notifiers";
import { caAlliances, caLevelForApiType, caMatchesForLevel, caRankings } from "./projectors";

// #region JSON helpers (CA MarshalIndent-style)

function caJson(body: unknown, cors = true): Response {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (cors) headers["Access-Control-Allow-Origin"] = "*";
	return new Response(JSON.stringify(body, null, 2), { status: 200, headers });
}

function caError500(detail: string): Response {
	// CA answers an unknown match type with a 500 plain-text body.
	return new Response(`Internal server error: ${detail}`, { status: 500, headers: { "Content-Type": "text/plain" } });
}

function caHtml(body: string): Response {
	return new Response(
		`<!DOCTYPE html><html><head><title>Cheesy Arena (fake-fms)</title></head><body>${body}</body></html>`,
		{
			status: 200,
			headers: { "Content-Type": "text/html" },
		},
	);
}

// #endregion

// #region websocket routing

const WS_ROUTES: Record<string, CaSocketType> = {
	"/displays/field_monitor/websocket": "field_monitor",
	"/displays/audience/websocket": "audience",
	"/displays/announcer/websocket": "announcer",
	"/displays/alliance_station/websocket": "alliance_station",
	"/displays/queueing/websocket": "queueing",
	"/displays/rankings/websocket": "rankings",
	"/displays/bracket/websocket": "bracket",
	"/displays/logo/websocket": "logo",
	"/match_play/websocket": "match_play",
	"/panels/referee/websocket": "referee",
	"/api/arena/websocket": "api_arena",
};

/** Resolve a CA websocket path to its socket type (+ scoring position), or null if not a CA ws path. */
export function caWsRoute(pathname: string): { socketType: CaSocketType; position?: string } | null {
	const scoring = pathname.match(/^\/panels\/scoring\/(red|blue)\/websocket$/);
	if (scoring) return { socketType: "scoring", position: scoring[1] };
	const t = WS_ROUTES[pathname];
	return t ? { socketType: t } : null;
}

/**
 * Reproduce gorilla/websocket's default same-origin check: allow when there is no Origin header, or
 * when the Origin host equals the request Host. A cross-origin browser page is rejected (like real CA);
 * a header-less client (websocat, native ws) passes.
 */
export function caCheckOrigin(req: Request): boolean {
	const origin = req.headers.get("origin");
	if (!origin) return true;
	try {
		return new URL(origin).host === (req.headers.get("host") ?? new URL(req.url).host);
	} catch {
		return false;
	}
}

// #endregion

// #region HTTP routes

/** Handle a CA HTTP (non-websocket) request. Returns null if the path is not a CA HTTP route. */
export function handleCaHttp(store: FmsStore, req: Request, url: URL): Response | null {
	const p = url.pathname;

	// /api/matches/{type}
	const matches = p.match(/^\/api\/matches\/([A-Za-z]+)$/);
	if (matches) {
		const level = caLevelForApiType(matches[1] as string);
		if (!level) return caError500(`invalid match type "${matches[1]}"`);
		return caJson(caMatchesForLevel(store, level));
	}

	if (p === "/api/rankings") return caJson(caRankings(store));
	if (p === "/api/alliances") return caJson(caAlliances(store));
	if (p === "/api/sponsor_slides") return caJson([]);

	const avatar = p.match(/^\/api\/teams\/(\d+)\/avatar$/);
	if (avatar) {
		const teamNumber = Number(avatar[1]);
		const team = store.getState().teams.find((t) => t.number === teamNumber);
		if (team?.avatar) {
			// CA serves a raw PNG (no CORS header on this route).
			return new Response(Buffer.from(team.avatar, "base64"), {
				status: 200,
				headers: { "Content-Type": "image/png" },
			});
		}
		return new Response("Not Found", { status: 404 });
	}

	if (p === "/api/bracket/svg") return bracketSvg(store);

	// Minimal display / control HTML pages (the endpoints exist; the websocket carries the data).
	if (
		p === "/" ||
		p === "/displays/field_monitor" ||
		p.startsWith("/displays/") ||
		p === "/match_play" ||
		p.startsWith("/panels/")
	) {
		return caHtml(`<h1>Cheesy Arena (fake-fms emulation)</h1><p>${p}</p>`);
	}

	return null;
}

/** A compact placeholder bracket SVG (real CA renders templates/bracket.svg from the live tournament). */
function bracketSvg(store: FmsStore): Response {
	const state = store.getState();
	const rows = state.schedule
		.filter((e) => e.level === "Playoff")
		.map(
			(e, i) =>
				`<text x="10" y="${20 + i * 18}" font-size="12">${e.description}: ${e.red.join(",")} vs ${e.blue.join(",")}</text>`,
		)
		.join("");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${40 + state.schedule.filter((e) => e.level === "Playoff").length * 18}"><text x="10" y="12" font-size="12" font-weight="bold">Playoff Bracket</text>${rows}</svg>`;
	return new Response(svg, {
		status: 200,
		headers: { "Content-Type": "image/svg+xml", "Access-Control-Allow-Origin": "*" },
	});
}

// #endregion

export { CORS_HEADERS };
