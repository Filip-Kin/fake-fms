import {
	type BracketData,
	type FMSAllianceSelection,
	type FmsState,
	getGameModule,
	type RankingRecord,
	type ScheduleEntry,
	type StationKey,
	StationType,
	type StationState,
	type Team,
} from "shared";

import { createHash } from "node:crypto";
import { initialPlayoffMatches } from "../match/playoff";

const HEX = "0123456789abcdef";

/** Generate a 32-char hex WPA key (matches the length FMS uses for radio keys). */
export function genWpaKey(): string {
	let out = "";
	for (let i = 0; i < 32; i++) out += HEX[Math.floor(Math.random() * 16)];
	return out;
}

/**
 * Deterministic UUID derived from a stable key (event+level+match+play or a TBA match key).
 * Real FMS keeps fmsMatchId stable, so deriving it deterministically means re-uploads dedupe
 * correctly on the FTA-Buddy server (keyed on fmsMatchId) instead of piling up on every restart.
 */
export function stableMatchId(key: string): string {
	const h = createHash("sha1").update(key).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Small deterministic PRNG (mulberry32). Seeded from a string so the schedule is well-mixed but
 * stable across restarts, which keeps re-uploads updating the same match instead of churning. */
function seededRng(seedStr: string): () => number {
	let a = 0;
	for (const ch of seedStr) a = (Math.imul(a, 31) + ch.charCodeAt(0)) | 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(arr: readonly T[], rng: () => number): T[] {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[a[i], a[j]] = [a[j] as T, a[i] as T];
	}
	return a;
}

// Rainbow Rumble 2026 (2026mirr) field. TBA has the event but no team list, so
// the roster lives here; avatars still hydrate per-team from TBA at boot.
const ROSTER: [number, string][] = [
	[33, "Killer Bees"],
	[51, "Wings of Fire"],
	[201, "The FEDS"],
	[226, "Hammerheads"],
	[247, "Da Bears"],
	[1076, "PiHi Samurai"],
	[1189, "Gearheads"],
	[1506, "Metal Muscle"],
	[1596, "The Instigators"],
	[2611, "Jacktown Vectors"],
	[2834, "Bionic Black Hawks"],
	[3175, "Knight Vision"],
	[3357, "COMETS"],
	[3655, "Tractor Technicians"],
	[3656, "Dexter Dreadbots"],
	[4327, "Q Branch"],
	[4381, "Twisted Devils"],
	[4422, "Twisted Angels"],
	[4926, "GalacTech"],
	[5152, "Alotobots"],
	[5460, "Strike Zone"],
	[5577, "Kinematic Wolves"],
	[5704, "Weird & Wired"],
	[6078, "RoboRams"],
	[6120, "CyberStangs"],
	[6548, "Perry RAMBOTS"],
	[7197, "Mountie Megabots"],
	[8424, "Tractor Technicians Next Gen"],
	[10349, "Pontiac Firebirds"],
	[11386, "Climax-Scotts PantherBots"],
];

function makeTeams(): Team[] {
	return ROSTER.map(([number, name]) => ({
		number,
		name,
		wpaKey: genWpaKey(),
		avatar: null,
	}));
}

function makeSchedule(teams: Team[], fullCode: string): ScheduleEntry[] {
	const nums = teams.map((t) => t.number);
	const entries: ScheduleEntry[] = [];
	const base = Date.UTC(2026, 2, 14, 9, 0, 0); // 2026-03-14 09:00 UTC, fixed for determinism
	const SLOTS = 6;
	// ~6 appearances per team for a full field, min 12 matches for a tiny one.
	const matchCount = Math.max(12, nums.length);
	const rng = seededRng(`${fullCode}:schedule`);

	// A shuffled pool where every team appears an equal number of times. Chunked into matches
	// below, so the field is spread out instead of running in numerical order.
	const pool: number[] = [];
	while (pool.length < matchCount * SLOTS) pool.push(...shuffled(nums, rng));
	pool.length = matchCount * SLOTS;

	let idx = 0;
	for (let m = 1; m <= matchCount; m++) {
		// Pull 6 distinct teams: if the next team already plays this match, swap in the nearest
		// later one that doesn't (avoids a team facing itself).
		const picks: number[] = [];
		while (picks.length < SLOTS) {
			let j = idx;
			while (j < pool.length && picks.includes(pool[j] as number)) j++;
			if (j >= pool.length) j = idx; // ran out of distinct teams (won't happen for a real field)
			[pool[idx], pool[j]] = [pool[j] as number, pool[idx] as number];
			picks.push(pool[idx] as number);
			idx++;
		}
		entries.push({
			fmsMatchId: stableMatchId(`${fullCode}:Qualification:${m}:1`),
			matchNumber: m,
			playNumber: 1,
			level: "Qualification",
			description: `Qualification ${m}`,
			scheduledStartTime: new Date(base + (m - 1) * 8 * 60 * 1000).toISOString(),
			actualStartTime: null,
			red: [picks[0] as number, picks[1] as number, picks[2] as number],
			blue: [picks[3] as number, picks[4] as number, picks[5] as number],
			status: "Pending",
			finalScoreRed: null,
			finalScoreBlue: null,
			redAllianceNumber: null,
			blueAllianceNumber: null,
		});
	}
	return entries;
}

function makeAlliances(teams: Team[]): FMSAllianceSelection[] {
	const out: FMSAllianceSelection[] = [];
	for (let a = 0; a < 8; a++) {
		const captain = teams[a * 3];
		const first = teams[a * 3 + 1];
		const second = teams[a * 3 + 2];
		out.push({
			allianceNumber: a + 1,
			allianceName: `Alliance ${a + 1}`,
			einsteinAlliance: "",
			isEinstein: false,
			captainTeamNumber: captain?.number ?? null,
			captainTeamNameShort: captain?.name ?? "",
			captainAvatar: "",
			firstRoundTeamNumber: first?.number ?? null,
			firstRoundTeamNameShort: first?.name ?? "",
			firstRoundAvatar: "",
			secondRoundTeamNumber: second?.number ?? null,
			secondRoundTeamNameShort: second?.name ?? "",
			secondRoundAvatar: "",
			alternateTeamNumber: null,
			alternateTeamNameShort: "",
			alternateAvatar: "",
			cardEffectiveStatus: "None",
		});
	}
	return out;
}

function makeRankings(teams: Team[]): RankingRecord[] {
	return teams.map((t, i) => ({
		rank: i + 1,
		teamNumber: t.number,
		isDeclined: false,
		pickStatus: "None" as const,
		inPotentialCaptainPosition: i < 8,
		wins: 0,
		losses: 0,
		ties: 0,
		matchesPlayed: 0,
		rankingScore: 0,
		sort2: 0,
		sort3: 0,
		sort4: 0,
		sort5: 0,
		sort6: 0,
		rankChange: "NoChange" as const,
	}));
}

function makeBracket(alliances: FMSAllianceSelection[], eventCode: string, eventName: string): BracketData {
	const bAlliances = alliances.map((a) => ({
		allianceNumber: a.allianceNumber,
		allianceName: a.allianceName,
		einsteinAlliance: "",
		captainTeamNumber: a.captainTeamNumber ?? 0,
		captainTeamNameShort: a.captainTeamNameShort,
		captainAvatar: "",
		firstRoundTeamNumber: a.firstRoundTeamNumber ?? 0,
		firstRoundTeamNameShort: a.firstRoundTeamNameShort,
		firstRoundAvatar: "",
		secondRoundTeamNumber: a.secondRoundTeamNumber ?? 0,
		secondRoundTeamNameShort: a.secondRoundTeamNameShort,
		secondRoundAvatar: "",
		alternateTeamNumber: 0,
		alternateTeamNameShort: "",
		alternateAvatar: "",
		cardEffectiveStatus: "None" as const,
	}));
	// Standard 8-alliance double-elim match list (matches 1-13), all pending.
	const pairs: [number, number][] = [
		[1, 8],
		[4, 5],
		[2, 7],
		[3, 6],
	];
	const matches = pairs.map((p, i) => ({
		matchNumber: i + 1,
		shortName: `M${i + 1}`,
		longName: `Match ${i + 1}`,
		isComplete: false,
		winningAllianceType: "None" as const,
		winningAllianceNumber: 0,
		redAllianceNumber: p[0],
		redAllianceScore: 0,
		blueAllianceNumber: p[1],
		blueAllianceScore: 0,
		isNextMatch: i === 0,
	}));
	return {
		alliances: bAlliances,
		doubleElimMatchesList: matches,
		finals: null,
		// Level6 is double-elim round 1 (levels count down to the Final), i.e. a fresh playoff bracket.
		currentLevel: "Level6",
		allianceCount: "EightAlliance",
		tournamentType: "OffSeason",
		season: 2026,
		eventCode,
		eventName,
		eventLocation: "Filip's Basement",
	};
}

function makeStations(first: ScheduleEntry): Record<StationKey, StationState> {
	const mk = (alliance: "Red" | "Blue", station: StationType, teamNumber: number): StationState => ({
		alliance,
		station,
		teamNumber,
		ds: "red",
		radio: "red",
		rio: "red",
		code: "red",
		bypassed: false,
		estop: false,
		astop: false,
		battery: 12.5,
		ping: 10,
		// Real FMS reports MACAddress null until a robot radio is actually seen (every disconnected
		// frame in signalr.jsonl carries null, never an all-zero MAC).
		mac: null,
	});
	return {
		red1: mk("Red", StationType.Station1, first.red[0]),
		red2: mk("Red", StationType.Station2, first.red[1]),
		red3: mk("Red", StationType.Station3, first.red[2]),
		blue1: mk("Blue", StationType.Station1, first.blue[0]),
		blue2: mk("Blue", StationType.Station2, first.blue[1]),
		blue3: mk("Blue", StationType.Station3, first.blue[2]),
	};
}

/** Build a fully-populated default FmsState for first boot. */
export function makeSeedState(gameModuleId: string): FmsState {
	const module = getGameModule(gameModuleId);
	// Bare event code (no season prefix); FTA-Buddy prepends the year itself. Must be a real TBA
	// event.
	const eventCode = "mirr";
	const fullCode = `2026${eventCode}`;
	const eventName = "Rainbow Rumble";
	const fmsEventId = stableMatchId(`event:${fullCode}`);
	const teams = makeTeams();
	const schedule = makeSchedule(teams, fullCode);
	const alliances = makeAlliances(teams);
	const rankings = makeRankings(teams);
	const first = schedule[0]!;

	return {
		event: {
			code: eventCode,
			name: eventName,
			location: "Mason, MI",
			season: 2026,
			// Real FMS reports OffSeason for an event like this (confirmed from the REST capture).
			tournamentType: "OffSeason",
			level: "Qualification",
			videoSwitchOption: "VideoOnly",
			fmsEventId,
			fmsEventPassword: "fakefms",
			fmsVersion: "13.0.2602.1902",
		},
		gameModuleId: module.id,
		teams,
		cards: {},
		schedule,
		alliances,
		rankings,
		allianceSelectionType: "ThreeTeam",
		bracket: makeBracket(alliances, fullCode, eventName),
		playoffMatches: initialPlayoffMatches(),
		allianceSelection: null,
		current: {
			matchNumber: 1,
			playNumber: 1,
			level: "Qualification",
			matchState: "WaitingForPrestart",
		},
		stations: makeStations(first),
		score: { red: module.emptyScore(), blue: module.emptyScore() },
		timer: { phase: "None", secondsRemaining: 0, running: false },
		gameConfig: module.defaultGameConfig(),
		plc: {
			MatchStatusChanged: "",
			RefReady: false,
			ScoreReady: false,
			FieldCleanup: false,
			ArenaClear: false,
			RefDone: false,
			RefUnderReview: false,
			BlueFouls: 0,
			BlueFoulsTech: 0,
			RedFouls: 0,
			RedFoulsTech: 0,
			Blue1CardNew: "None",
			Blue2CardNew: "None",
			Blue3CardNew: "None",
			Red1CardNew: "None",
			Red2CardNew: "None",
			Red3CardNew: "None",
		},
		results: {},
		autoplay: { replayLogs: true, autoFaults: true },
		notes: [],
		logFaults: {},
		clients: { fieldMonitorHub: 0, infrastructureHub: 0, gameSpecificHub: 0, ftaAppHub: 0 },
		testSequence: { running: false, currentIndex: -1, steps: [] },
	};
}
