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

function makeTeams(count: number): Team[] {
	const names = [
		"The Cheesy Poofs",
		"Citrus Circuits",
		"Robowranglers",
		"Simbotics",
		"Wired Boars",
		"Bomb Squad",
		"Quixilver",
		"Robonauts",
	];
	const teams: Team[] = [];
	for (let i = 0; i < count; i++) {
		const number = 100 + i * 7;
		teams.push({
			number,
			name: names[i % names.length] ?? `Team ${number}`,
			wpaKey: genWpaKey(),
			avatar: null,
		});
	}
	return teams;
}

function makeSchedule(teams: Team[], fullCode: string): ScheduleEntry[] {
	const nums = teams.map((t) => t.number);
	const entries: ScheduleEntry[] = [];
	const base = Date.UTC(2026, 2, 14, 9, 0, 0); // 2026-03-14 09:00 UTC, fixed for determinism
	for (let m = 1; m <= 12; m++) {
		const pick = (offset: number) => nums[(m * 6 + offset) % nums.length] as number;
		entries.push({
			fmsMatchId: stableMatchId(`${fullCode}:Qualification:${m}:1`),
			matchNumber: m,
			playNumber: 1,
			level: "Qualification",
			description: `Qualification ${m}`,
			scheduledStartTime: new Date(base + (m - 1) * 8 * 60 * 1000).toISOString(),
			actualStartTime: null,
			red: [pick(0), pick(1), pick(2)],
			blue: [pick(3), pick(4), pick(5)],
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
		mac: "00:00:00:00:00:00",
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
	// event. Default to 2026mibat (FiM District Battle Creek) which never used FTA-Buddy, so its
	// real logs won't be overwritten when this emulator uploads generated ones.
	const eventCode = "mibat";
	const fullCode = `2026${eventCode}`;
	const eventName = "FiM District Battle Creek Event";
	const fmsEventId = stableMatchId(`event:${fullCode}`);
	const teams = makeTeams(24);
	const schedule = makeSchedule(teams, fullCode);
	const alliances = makeAlliances(teams);
	const rankings = makeRankings(teams);
	const first = schedule[0]!;

	return {
		event: {
			code: eventCode,
			name: eventName,
			location: "Filip's Basement",
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
