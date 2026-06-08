// FMS notes types, copied from FTA-Buddy shared/fmsApiTypes.ts so the /Notes/ REST
// surface and ftaAppHub payloads are byte-compatible with what the extension expects.

export type FTAEventNoteType =
	| "FTAEvent"
	| "FTAMatch"
	| "FTATeamIssue"
	| "FTAAppUsageData"
	| "FTATeam"
	| "FMSAllianceTimeout"
	| "FMSMatchMaker"
	| "Staff";

export const FTAEventNoteTypeNumeric: Record<FTAEventNoteType, number> = {
	FTAEvent: 1,
	FTAMatch: 2,
	FTATeamIssue: 5,
	FTAAppUsageData: 6,
	FTATeam: 5,
	FMSAllianceTimeout: 10,
	FMSMatchMaker: 11,
	Staff: 15,
};

export type FTAEventNoteIssueType =
	| "RoboRioIssue"
	| "DSIssue"
	| "NoRobot"
	| "RadioIssue"
	| "RobotPwrIssue"
	| "OtherRobotIssue"
	| "VenueIssue"
	| "ElectricalIssue"
	| "MechanicalIssue"
	| "VolunteerIssue"
	| "Other";

export const FTAEventNoteIssueTypeNumeric: Record<FTAEventNoteIssueType, number> = {
	RoboRioIssue: 1,
	DSIssue: 5,
	NoRobot: 10,
	RadioIssue: 15,
	RobotPwrIssue: 20,
	OtherRobotIssue: 25,
	VenueIssue: 26,
	ElectricalIssue: 27,
	MechanicalIssue: 28,
	VolunteerIssue: 29,
	Other: 30,
};

export type FTAEventNoteResolutionType = "Open" | "Resolved" | "NotApplicable" | "Refused";

export const FTAEventNoteResolutionTypeNumeric: Record<FTAEventNoteResolutionType, number> = {
	Open: 1,
	Resolved: 5,
	NotApplicable: 99,
	Refused: 6,
};

/** Reverse lookup: numeric issue value -> string name (for AddNote ingestion). */
export function issueTypeFromNumeric(value: number): FTAEventNoteIssueType {
	const entry = (Object.entries(FTAEventNoteIssueTypeNumeric) as [FTAEventNoteIssueType, number][]).find(
		([, v]) => v === value,
	);
	return entry ? entry[0] : "Other";
}

export function resolutionFromNumeric(value: number): FTAEventNoteResolutionType {
	const entry = (Object.entries(FTAEventNoteResolutionTypeNumeric) as [FTAEventNoteResolutionType, number][]).find(
		([, v]) => v === value,
	);
	return entry ? entry[0] : "Open";
}

export function noteTypeFromNumeric(value: number): FTAEventNoteType {
	const entry = (Object.entries(FTAEventNoteTypeNumeric) as [FTAEventNoteType, number][]).find(
		([, v]) => v === value,
	);
	return entry ? entry[0] : "FTATeamIssue";
}

/** A note record as returned by /Notes/ endpoints (NoteModel). */
export interface FTANoteRecord {
	fmsEventNoteId: string;
	noteType: FTAEventNoteType;
	tournamentLevel: string | null;
	alliance: string | null;
	station: string | null;
	fmsMatchId: string | null;
	fmsTeamId: string | null;
	teamNumber: number | null;
	matchDescription: string | null;
	matchNumber: number | null;
	playNumber: number | null;
	note: string;
	issueType: FTAEventNoteIssueType;
	resolutionStatus: FTAEventNoteResolutionType;
	isPrivate: boolean;
	isDeleted: boolean;
}

export interface FTATeamNotesModel {
	fmsTeamId: string;
	teamNumber: number;
	teamNotes: FTANoteRecord[];
}

export interface FTAMatchesModel {
	eventNotes: FTANoteRecord[];
	testMatches: unknown[];
	practiceMatches: unknown[];
	qualificationMatches: unknown[];
	playoffMatches: unknown[];
}

/** Body for POST /Notes/AddNote (numeric enum values). */
export interface FTAAddNoteBody {
	noteType: number;
	issueType: number;
	issueString: string;
	resolutionStatus: number;
	note: string;
	teamNumber: number;
	tournamentLevel: number;
	matchNumber: number;
	playNumber: number;
}

/** Server -> client ftaAppHub NoteChanged event payload. */
export interface FTANoteChangedEvent {
	NoteType: FTAEventNoteType;
	FMSNoteId: string;
	RecordVersion: number | null;
	Type: string;
	FMSDeviceIdentification: string;
	CurrentTimeStamp: string;
	PreviousTimeStamp: string;
}
