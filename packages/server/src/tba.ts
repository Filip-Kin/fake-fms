import type { ScheduleEntry, Team, TournamentLevel } from "shared";
import { genWpaKey, stableMatchId } from "./state/seed";

// #region TBA response shapes (only the fields we use)

interface TbaTeam {
	team_number: number;
	nickname: string | null;
}

interface TbaAlliance {
	team_keys: string[];
	score: number;
}

interface TbaMatch {
	comp_level: string; // "qm" | "ef" | "qf" | "sf" | "f"
	match_number: number;
	set_number: number;
	time: number | null;
	predicted_time: number | null;
	actual_time: number | null;
	alliances: { red: TbaAlliance; blue: TbaAlliance };
}

// #endregion

const BASE = "https://www.thebluealliance.com/api/v3";

async function tbaGet<T>(path: string, key: string): Promise<T | null> {
	try {
		const res = await fetch(`${BASE}${path}`, { headers: { "X-TBA-Auth-Key": key } });
		if (!res.ok) {
			console.warn(`[tba] ${path} -> ${res.status}`);
			return null;
		}
		return (await res.json()) as T;
	} catch (e) {
		console.warn(`[tba] ${path} failed:`, e);
		return null;
	}
}

function teamNum(key: string): number {
	return Number(key.replace("frc", ""));
}

function triple(keys: string[]): [number, number, number] {
	return [teamNum(keys[0] ?? "frc0"), teamNum(keys[1] ?? "frc0"), teamNum(keys[2] ?? "frc0")];
}

function levelFor(compLevel: string): TournamentLevel {
	return compLevel === "qm" ? "Qualification" : "Playoff";
}

function describe(m: TbaMatch): string {
	if (m.comp_level === "qm") return `Qualification ${m.match_number}`;
	if (m.comp_level === "f") return `Final ${m.match_number}`;
	return `Playoff ${m.set_number}-${m.match_number}`;
}

/**
 * Fetch real teams and schedule for a TBA event (e.g. "2026mitry"). Returns null if the key is
 * missing or the event has no data, so the caller can fall back to generated seed data.
 */
export async function fetchEventData(
	eventKey: string,
	apiKey: string,
): Promise<{ teams: Team[]; schedule: ScheduleEntry[] } | null> {
	const [tbaTeams, tbaMatches] = await Promise.all([
		tbaGet<TbaTeam[]>(`/event/${eventKey}/teams/simple`, apiKey),
		tbaGet<TbaMatch[]>(`/event/${eventKey}/matches/simple`, apiKey),
	]);
	if (!Array.isArray(tbaTeams) || tbaTeams.length === 0) return null;

	const teams: Team[] = tbaTeams
		.map((t) => ({ number: t.team_number, name: t.nickname ?? `Team ${t.team_number}`, wpaKey: genWpaKey() }))
		.sort((a, b) => a.number - b.number);

	const matches = Array.isArray(tbaMatches) ? tbaMatches : [];
	// Qualifications first (by match number), then playoff matches (by set then match).
	const order = (m: TbaMatch) => (m.comp_level === "qm" ? 0 : 1) * 100000 + m.set_number * 1000 + m.match_number;
	const schedule: ScheduleEntry[] = matches
		.filter((m) => ["qm", "sf", "f", "qf", "ef"].includes(m.comp_level))
		.sort((a, b) => order(a) - order(b))
		.map((m) => {
			const t = m.predicted_time ?? m.time ?? null;
			const played = m.alliances.red.score >= 0 && m.alliances.blue.score >= 0 && m.actual_time != null;
			return {
				fmsMatchId: stableMatchId(`${eventKey}:${m.comp_level}:${m.set_number}:${m.match_number}`),
				matchNumber: m.match_number,
				playNumber: 1,
				level: levelFor(m.comp_level),
				description: describe(m),
				scheduledStartTime: t ? new Date(t * 1000).toISOString() : new Date(0).toISOString(),
				actualStartTime: played && m.actual_time ? new Date(m.actual_time * 1000).toISOString() : null,
				red: triple(m.alliances.red.team_keys),
				blue: triple(m.alliances.blue.team_keys),
				status: played ? "Played" : "Pending",
				finalScoreRed: played ? m.alliances.red.score : null,
				finalScoreBlue: played ? m.alliances.blue.score : null,
				redAllianceNumber: null,
				blueAllianceNumber: null,
			};
		});

	return { teams, schedule };
}
