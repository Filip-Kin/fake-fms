/**
 * Cheesy Arena playoff-bracket rendering for the fake-fms emulator.
 *
 * Mirrors CA's `web/api.go` `generateBracketSvg` + `templates/bracket.svg`: it builds the same
 * `map[string]*allianceMatchup` keyed by matchup id (M1..M13, F), then lays it out as the
 * 8-alliance double-elimination bracket ("double" bracketType) with matchup boxes, alliance
 * numbers/team numbers, series status, active/winner highlighting, connectors and column labels.
 *
 * Self-contained on purpose: the bracket topology (positions, winner/loser source labels and the
 * connector geometry) is a fixed structure copied out of CA's template, so this file depends only on
 * "shared" and the FmsStore type. The per-matchup alliances/scores/winner come from the live store
 * (`playoffMatches`, `alliances`), exactly the data CA reads from its own tournament model.
 *
 * Fidelity notes:
 *  - Geometry (viewBox, box/connector/label coordinates, colours) is taken verbatim from CA's
 *    templates/bracket.svg, so the visual structure matches CA closely.
 *  - CA embeds the FuturaLT font as ~70KB of base64; that is omitted here and the SVG falls back to
 *    sans-serif to keep the file small and portable.
 *  - CA positions boxes via CSS `transform` on `<g>` and reuses the ids `background`/`series_status`/
 *    `match_title` across all 14 boxes. To keep this a valid standalone SVG those ids become classes
 *    and positions are applied as SVG `transform` attributes; the rendered result is identical.
 */

import type { FMSAllianceSelection, FmsState, PlayoffMatchState } from "shared";
import type { FmsStore } from "../state/store";

// #region fixed bracket topology (CA "double" bracketType, 8 alliances)

/** Matchup ids in the order CA draws them; "F" is the best-of-3 finals. */
const MATCHUP_IDS = ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10", "M11", "M12", "M13", "F"] as const;
type MatchupId = (typeof MATCHUP_IDS)[number];

/** The playoff match number that seeds each box's alliances (finals read the finalists off match 14). */
const MATCH_NUMBER: Record<MatchupId, number> = {
	M1: 1,
	M2: 2,
	M3: 3,
	M4: 4,
	M5: 5,
	M6: 6,
	M7: 7,
	M8: 8,
	M9: 9,
	M10: 10,
	M11: 11,
	M12: 12,
	M13: 13,
	F: 14,
};

/**
 * Human-readable source labels for each slot, matching CA's allianceSource.displayName():
 * "A n" = alliance seed n, "W Mx"/"L Mx" = winner/loser of an earlier matchup. Shown as the grey
 * placeholder in a box until that slot's alliance is decided.
 */
const SOURCES: Record<MatchupId, { red: string; blue: string }> = {
	M1: { red: "A 1", blue: "A 8" },
	M2: { red: "A 4", blue: "A 5" },
	M3: { red: "A 2", blue: "A 7" },
	M4: { red: "A 3", blue: "A 6" },
	M5: { red: "L M1", blue: "L M2" },
	M6: { red: "L M3", blue: "L M4" },
	M7: { red: "W M1", blue: "W M2" },
	M8: { red: "W M3", blue: "W M4" },
	M9: { red: "L M7", blue: "W M6" },
	M10: { red: "L M8", blue: "W M5" },
	M11: { red: "W M7", blue: "W M8" },
	M12: { red: "W M9", blue: "W M10" },
	M13: { red: "L M11", blue: "W M12" },
	F: { red: "W M11", blue: "W M13" },
};

/** Top-left corner each box is translated to (CA's `.bracket_double #match_* {transform}` rules). */
const POSITIONS: Record<MatchupId, [number, number]> = {
	M1: [114, 158],
	M2: [114, 348],
	M3: [114, 538],
	M4: [114, 728],
	M7: [412, 158],
	M8: [412, 348],
	M5: [412, 538],
	M6: [412, 728],
	M10: [709, 504],
	M9: [709, 694],
	M11: [1006, 301],
	M12: [1006, 599],
	M13: [1302, 567],
	F: [1598, 417],
};

/** Wins required to take a box: the finals are best-of-3, every other matchup is a single game. */
function winsToAdvance(id: MatchupId): number {
	return id === "F" ? 2 : 1;
}

/** Evergreen connector lines that are always drawn (CA's #connectors_evergreen). */
const EVERGREEN_CONNECTORS = `
      <polyline points="1211,390 1546,390 1546,656 1507,656"/>
      <line x1="1598" y1="506" x2="1545" y2="506"/>
      <line x1="1211" y1="688" x2="1302" y2="688"/>
      <polyline points="914,783 959,783 959,593 914,593"/>
      <line x1="1006" y1="688" x2="959" y2="688"/>
      <line x1="617" y1="627" x2="709" y2="627"/>
      <line x1="617" y1="817" x2="709" y2="817"/>
      <polyline points="617,247 703,247 703,437 617,437"/>
      <polyline points="1006,390 861,390 861,336 704,336"/>`;

/** Per-matchup connector fragments (CA's #connectors_temporary), shown only when the matchup is active. */
const TEMP_CONNECTORS: Record<MatchupId, string> = {
	M1: `<polyline class="loser" points="411,593 367,593 367,247"/><polyline points="319,247 367,247 367,214 411,214"/><text transform="translate(342.9489 228.3672)">W</text><text transform="translate(347.4327 269.9525)" class="loser">L</text>`,
	M2: `<polyline class="loser" points="411,662 367,662 367,437"/><polyline points="319,437 367,437 367,283 411,283"/><text transform="translate(342.9489 420.848)">W</text><text transform="translate(347.4327 462.4333)" class="loser">L</text>`,
	M3: `<polyline class="loser" points="411,786 367,786 367,627"/><polyline points="319,627 367,627 367,404 411,404"/><text transform="translate(342.9489 610.848)">W</text><text transform="translate(347.4327 652.4332)" class="loser">L</text>`,
	M4: `<polyline class="loser" points="411,853 367,853 367,817"/><polyline points="319,817 367,817 367,473 411,473"/><text transform="translate(342.9489 800.848)">W</text><text transform="translate(347.4327 842.4332)" class="loser">L</text>`,
	M5: `<text transform="translate(665.9388 616.8822)">W</text>`,
	M6: `<text transform="translate(667.1932 808.262)">W</text>`,
	M7: `<text transform="translate(668.4441 239.1465)">W</text><text transform="translate(644.3726 276.7044)" class="loser">L</text><polyline class="loser" points="660,636 660,748 728,748"/><line class="loser" x1="660" y1="447" x2="660" y2="618"/><line class="loser" x1="660" y1="248" x2="660" y2="427"/>`,
	M8: `<text transform="translate(668.566 429.1972)">W</text><text transform="translate(643.3726 469.2499)" class="loser">L</text><polyline class="loser" points="660,438 660,561 728,561"/>`,
	M9: `<text transform="translate(966.4487 773.8822)">W</text>`,
	M10: `<text transform="translate(941.2606 585.4622)">W</text>`,
	M11: `<text transform="translate(1263.0288 382.2166)">W</text><text transform="translate(1239.3726 418.7044)" class="loser">L</text><polyline class="loser" points="1256,391 1256,625 1323,625"/>`,
	M12: `<text transform="translate(1223.2803 681.0883)">W</text>`,
	M13: `<text transform="translate(1562.4487 647.8822)">W</text>`,
	F: ``,
};

/** Column labels along the bottom, plus the finals best-of-3 subtitle (CA's #labels). */
const LABELS = `
    <text x="219" y="975">Round 1</text>
    <text x="516" y="975">Round 2</text>
    <text x="813" y="975">Round 3</text>
    <text x="1109" y="975">Round 4</text>
    <text x="1405" y="975">Round 5</text>
    <text x="1702" y="975">Finals</text>
    <text class="finals_subtitle" x="1802" y="434">Best-of-3</text>`;

// #endregion

// #region computed matchup model

interface CaBracketAlliance {
	id: number;
	teamIds: number[];
}

/** One resolved bracket box, mirroring CA's allianceMatchup struct. */
interface CaBracketMatchup {
	id: MatchupId;
	redAllianceSource: string;
	blueAllianceSource: string;
	redAlliance: CaBracketAlliance | null;
	blueAlliance: CaBracketAlliance | null;
	isActive: boolean;
	isComplete: boolean;
	seriesLeader: "red" | "blue" | "";
	seriesStatus: string;
}

/** The CA matchup group id a playoff match number belongs to (1-13 -> Mx, 14-19 -> the finals "F"). */
function groupForMatchNumber(n: number): MatchupId | null {
	if (n >= 1 && n <= 13) return `M${n}` as MatchupId;
	if (n >= 14 && n <= 19) return "F";
	return null;
}

/** Resolve an alliance number to its id + team-number lineup ([captain, first, second, alternate]). */
function resolveAlliance(state: FmsState, allianceNumber: number | null): CaBracketAlliance | null {
	if (allianceNumber == null || allianceNumber <= 0) return null;
	const a: FMSAllianceSelection | undefined = state.alliances.find((x) => x.allianceNumber === allianceNumber);
	if (!a) {
		// CA still shows the seed number when the roster is not yet built (Alliance{Id: n}, no teams).
		return { id: allianceNumber, teamIds: [] };
	}
	const teamIds = [a.captainTeamNumber, a.firstRoundTeamNumber, a.secondRoundTeamNumber, a.alternateTeamNumber]
		.map((n) => n ?? 0)
		.filter((n) => n > 0);
	return { id: allianceNumber, teamIds };
}

/** CA's Matchup.StatusText(): the leading alliance and a readable series status. */
function statusText(
	redWins: number,
	blueWins: number,
	toAdvance: number,
	isFinal: boolean,
): { leader: "red" | "blue" | ""; status: string } {
	const winText = isFinal ? "Wins" : "Advances";
	if (redWins >= toAdvance) return { leader: "red", status: `Red ${winText} ${redWins}-${blueWins}` };
	if (blueWins >= toAdvance) return { leader: "blue", status: `Blue ${winText} ${blueWins}-${redWins}` };
	if (redWins > blueWins) return { leader: "red", status: `Red Leads ${redWins}-${blueWins}` };
	if (blueWins > redWins) return { leader: "blue", status: `Blue Leads ${blueWins}-${redWins}` };
	if (redWins > 0) return { leader: "", status: `Series Tied ${redWins}-${blueWins}` };
	return { leader: "", status: "" };
}

/** Wins for the finalists across the finals + overtime games (14-19), which share the same alliances. */
function finalsWins(state: FmsState): { red: number; blue: number } {
	let red = 0;
	let blue = 0;
	for (let n = 14; n <= 19; n++) {
		const m: PlayoffMatchState | undefined = state.playoffMatches[n];
		if (!m || !m.complete) continue;
		if (m.winner === "Red") red++;
		else if (m.winner === "Blue") blue++;
	}
	return { red, blue };
}

/** Which matchup box (if any) the requested active match maps to. */
function activeGroup(state: FmsState, activeMatch: "current" | "saved" | null): MatchupId | null {
	if (activeMatch === "current") {
		if (state.current.level !== "Playoff") return null;
		return groupForMatchNumber(state.current.matchNumber);
	}
	if (activeMatch === "saved") {
		// No dedicated "saved match" in the store; approximate it as the last completed playoff match.
		let last = -1;
		for (let n = 1; n <= 19; n++) {
			if (state.playoffMatches[n]?.complete && n > last) last = n;
		}
		return last > 0 ? groupForMatchNumber(last) : null;
	}
	return null;
}

/** Build the full matchup map (CA's `matchups map[string]*allianceMatchup`) from live store state. */
function computeMatchups(
	state: FmsState,
	activeMatch: "current" | "saved" | null,
): Record<MatchupId, CaBracketMatchup> {
	const active = activeGroup(state, activeMatch);
	const out = {} as Record<MatchupId, CaBracketMatchup>;
	for (const id of MATCHUP_IDS) {
		const toAdvance = winsToAdvance(id);
		const isFinal = id === "F";
		const source = SOURCES[id];
		const seed = state.playoffMatches[MATCH_NUMBER[id]];

		const redWins = isFinal ? finalsWins(state).red : seed?.winner === "Red" ? 1 : 0;
		const blueWins = isFinal ? finalsWins(state).blue : seed?.winner === "Blue" ? 1 : 0;
		const { leader, status } = statusText(redWins, blueWins, toAdvance, isFinal);

		out[id] = {
			id,
			redAllianceSource: source.red,
			blueAllianceSource: source.blue,
			redAlliance: resolveAlliance(state, seed?.red ?? null),
			blueAlliance: resolveAlliance(state, seed?.blue ?? null),
			isActive: active === id,
			isComplete: redWins >= toAdvance || blueWins >= toAdvance,
			seriesLeader: leader,
			seriesStatus: status,
		};
	}
	return out;
}

// #endregion

// #region SVG rendering

const STYLE = `
    .bgrect { fill:#FFFFFF; stroke:#444444; stroke-width:2; stroke-miterlimit:10; }
    .separator { fill:none; stroke:#444444; stroke-width:3; }
    .bracket_name { fill:#444444; font-family:sans-serif; font-size:20px; }

    #connectors line, #connectors polyline { fill:none; stroke:#444444; stroke-width:2; stroke-miterlimit:10; }
    #connectors line.loser, #connectors polyline.loser { stroke:#999999; }
    #connectors text { fill:#444444; font-family:sans-serif; font-weight:bold; font-size:14.4179px; }
    #connectors text.loser { fill:#999999; }
    #connectors_temporary g { display:none; }
    #connectors_temporary g.active { display:inline; }

    #labels text { fill:#444444; font-family:sans-serif; font-size:30px; text-anchor:middle; }
    #labels .finals_subtitle { font-size:13.189px; text-anchor:end; }

    .matchblock text { font-family:sans-serif; }
    .matchblock .structure { fill:none; stroke:#444444; stroke-width:2; stroke-miterlimit:10; }
    .matchblock .matchbg { fill:none; }
    .matchblock.complete .matchbg { fill:#e8e8e8; }
    .matchblock.active .matchbg { fill:#444444; }
    .red { fill:#FF2222; }
    .blue { fill:#2080FF; }
    .matchblock .series_status { font-size:13.189px; text-anchor:end; }
    .matchblock .match_title { font-size:19.8053px; fill:#444444; }
    .matchblock .alliancenum { fill:#ffffff; font-size:34px; text-anchor:middle; }
    .matchblock .teamnum { font-size:25px; text-anchor:middle; fill:#444444; }
    .matchblock.active .teamnum { fill:#ffffff; }
    .matchblock .placeholder { fill:#aaaaaa; font-family:sans-serif; font-weight:bold; font-size:25.9715px; font-style:italic; text-anchor:middle; }
    .matchblock.complete.red-win .teamnum.b, .matchblock.complete.blue-win .teamnum.r { fill:#888888; }
    .matchblock.complete.red-win.active .teamnum.b, .matchblock.complete.blue-win.active .teamnum.r { fill:#cccccc; }
    .matchblock.complete.blue-win .alliancenum.r { fill:#ffc8c8; }
    .matchblock.complete.red-win .alliancenum.b { fill:#A9D6FF; }`;

/** One side (red/blue) of a box: the alliance number + team numbers, or the grey source placeholder. */
function allianceSideSvg(
	alliance: CaBracketAlliance | null,
	source: string,
	side: "r" | "b",
	numY: number,
	rows: [number, number],
	placeholderY: number,
): string {
	if (!alliance) {
		return `<text class="placeholder" x="101.1501" y="${placeholderY}">${source}</text>`;
	}
	const [rowTop, rowBottom] = rows;
	let out = `<text x="22" y="${numY}" class="alliancenum ${side}">${alliance.id}</text>`;
	const t = alliance.teamIds;
	if (t.length >= 3) {
		out += `<text x="85" y="${rowTop}" class="teamnum ${side}">${t[0]}</text>`;
		out += `<text x="165" y="${rowTop}" class="teamnum ${side}">${t[1]}</text>`;
		out += `<text x="85" y="${rowBottom}" class="teamnum ${side}">${t[2]}</text>`;
	}
	if (t.length >= 4) {
		out += `<text x="165" y="${rowBottom}" class="teamnum ${side}">${t[3]}</text>`;
	}
	return out;
}

/** Render one matchup box (CA's "matchup" template) translated to its bracket position. */
function matchupSvg(m: CaBracketMatchup): string {
	const [x, y] = POSITIONS[m.id];
	const classes = ["matchblock"];
	if (m.isActive) classes.push("active");
	if (m.isComplete) classes.push("complete", `${m.seriesLeader}-win`);
	const red = allianceSideSvg(m.redAlliance, m.redAllianceSource, "r", 70, [51, 81], 66.5769);
	const blue = allianceSideSvg(m.blueAlliance, m.blueAllianceSource, "b", 135, [116, 146], 130.4177);
	return `
    <g id="match_${m.id}" class="${classes.join(" ")}" transform="translate(${x} ${y})">
      <rect class="matchbg" y="23" width="205" height="130.452"/>
      <rect class="red" y="23" width="45.567" height="66.319"/>
      <rect class="blue" y="89.133" width="45.567" height="64.319"/>
      <line class="structure" x1="0" y1="89" x2="205" y2="89"/>
      <rect class="structure" y="23" width="205" height="130.452"/>
      <text class="series_status ${m.seriesLeader}" x="203.9999" y="170.5669">${m.seriesStatus}</text>
      <text class="match_title" x="0" y="17.3691">${m.id}</text>
      ${red}
      ${blue}
    </g>`;
}

function connectorsSvg(matchups: Record<MatchupId, CaBracketMatchup>): string {
	const temp = MATCHUP_IDS.filter((id) => TEMP_CONNECTORS[id] !== "")
		.map((id) => `<g class="${matchups[id].isActive ? "active" : ""}">${TEMP_CONNECTORS[id]}</g>`)
		.join("\n        ");
	return `
    <g id="connectors">
      <g id="connectors_evergreen">${EVERGREEN_CONNECTORS}
      </g>
      <g id="connectors_temporary">
        ${temp}
      </g>
    </g>`;
}

function renderSvg(matchups: Record<MatchupId, CaBracketMatchup>): string {
	const boxes = MATCHUP_IDS.map((id) => matchupSvg(matchups[id])).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
  <style type="text/css">${STYLE}
  </style>
  <g id="bracket">
    <g id="background">
      <rect class="bgrect" x="70" y="115" width="1780" height="900"/>
      <polyline class="separator" points="390,530 650,530 650,490 1520,490" stroke-dasharray="10,5"/>
      <text class="bracket_name" transform="translate(1285 475)">Upper Bracket</text>
      <text class="bracket_name" transform="translate(1285 520)">Lower Bracket</text>
    </g>${connectorsSvg(matchups)}
    <g id="matchups">${boxes}
    </g>
    <g id="labels">${LABELS}
    </g>
  </g>
</svg>`;
}

// #endregion

// #region public API

/**
 * Render the playoff bracket as an SVG, mirroring CA's `GET /api/bracket/svg?activeMatch=...`.
 * `activeMatch` highlights the matchup for the current/saved match; null highlights nothing.
 */
export function caBracketSvg(store: FmsStore, activeMatch: "current" | "saved" | null): Response {
	const matchups = computeMatchups(store.getState(), activeMatch);
	return new Response(renderSvg(matchups), {
		status: 200,
		headers: { "Content-Type": "image/svg+xml", "Access-Control-Allow-Origin": "*" },
	});
}

/**
 * Structured bracket data behind the SVG, mirroring the internal shape CA assembles in
 * `generateBracketSvg` (bracketType + the matchup map keyed by id). CA has no separate
 * `GetBracketData` JSON endpoint (its bracket display just reloads the SVG on match load), so this
 * exposes that same `allianceMatchup` model for websocket/consumers that want the data rather than
 * the picture. The store only ever seeds an 8-alliance double-elim bracket, so bracketType is
 * always "double".
 */
export function caBracketData(store: FmsStore): unknown {
	const matchups = computeMatchups(store.getState(), null);
	return { bracketType: "double", matchups };
}

// #endregion
