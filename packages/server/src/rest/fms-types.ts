// #region Json.NET $type discriminators

/**
 * Real FMS serializes REST payloads with Newtonsoft.Json `TypeNameHandling.Objects`, so every
 * object (and array element of a declared type) carries a `$type` discriminator as its FIRST
 * property, e.g. `"$type": "FMS.Common.Contract.AudienceAlliance, FMS.Common.Contract"`. The
 * JS consumers (FTA-Buddy, audience-display) ignore it, but the real Angular UI and any strict
 * .NET consumer rely on it. The exact type strings here are taken verbatim from the capture.
 */
export const FMS_TYPE = {
	GameConfig: "FMS.GameSpecific.Api.Config.GameConfig, FMS.GameSpecific.Api",
	AudienceAlliance: "FMS.Common.Contract.AudienceAlliance, FMS.Common.Contract",
	QualRankingTeam: "FMS.Common.Contract.AllianceSelectionRankingEventWizard, FMS.Common.Contract",
	ScheduleViewItem: "FMS.Common.Contract.ViewItems.MatchModuleScheduleViewItem, FMS.Common.Contract",
	AudienceBracket: "FMS.GameSpecific.Api.AudienceBracket, FMS.GameSpecific.Api",
	RegionalAdvancers: "FMS.Common.Contract.AudienceShowRegionalAdvancers, FMS.Common.Contract",
	RegionalPool: "FMS.Common.Contract.AudienceRegionalPoolData, FMS.Common.Contract",
	EventBreakData: "FMS.Common.Contract.AudienceBreakData, FMS.Common.Contract",
	CurrentResult: "FMS.Common.Contract.ViewItems.MatchModuleMatchViewItem, FMS.Common.Contract",
	// GetResults/{level} array elements (distinct from GetCurrentResults' MatchModuleMatchViewItem).
	WebMatchViewItem: "FMS.Common.Contract.ViewItems.FieldServerWebMatchViewItem, FMS.Common.Contract",
	// Match preview (GetQualMatchPreviewData / GetTestMatchPreviewData both serialize as the Qual types).
	MatchPreviewData: "FMS.Common.Contract.MatchPreviewQualData, FMS.Common.Contract",
	MatchPreviewAlliance: "FMS.Common.Contract.MatchPreviewQualAllianceData, FMS.Common.Contract",
	MatchPreviewTeam: "FMS.Common.Contract.QualMatchTeamData, FMS.Common.Contract",
	// Match results (GetMatchResults*Data).
	MatchResultsData: "FMS.GameSpecific.Api.MatchResultsQualData, FMS.GameSpecific.Api",
	MatchResultsAlliance: "FMS.GameSpecific.Api.MatchResultsQualAllianceData, FMS.GameSpecific.Api",
	AllianceScoreDetails: "FMS.GameSpecific.Api.AllianceScoreDetails, FMS.GameSpecific.Api",
	MatchResultsTeam: "FMS.GameSpecific.Api.MatchResultsQualTeamData, FMS.GameSpecific.Api",
	ByteArray: "System.Byte[], System.Private.CoreLib",
	TeamRanking: "FMS.Contract.TeamRankingForSort, FMS.Contract",
	// Alliance selection + playoff endpoints.
	AllianceSelectionWizard: "FMS.Common.Contract.AllianceSelectionEventWizard, FMS.Common.Contract",
	AllianceSelectionData: "FMS.Common.Contract.AudienceAllianceSelectionData, FMS.Common.Contract",
	QualRankData: "FMS.Common.Contract.AudienceQualRankingData, FMS.Common.Contract",
	QualRankTeamData: "FMS.Common.Contract.AudienceQualRankingTeamData, FMS.Common.Contract",
	PlayoffMatchSpec: "FMS.Common.Contract.Playoff.PlayoffMatchSpec, FMS.Common.Contract",
	MatchGroupView: "FMS.Common.Contract.Playoff.MatchGroupView, FMS.Common.Contract",
	DoubleElimMatch: "FMS.GameSpecific.Api.AudienceDoubleElimMatch, FMS.GameSpecific.Api",
	// Immutable collection wrappers (the `$type` of the dictionary object itself).
	PlayoffMatchesDict:
		"System.Collections.Immutable.ImmutableSortedDictionary`2[[System.Int32, System.Private.CoreLib],[FMS.Common.Contract.Playoff.PlayoffMatchSpec, FMS.Common.Contract]], System.Collections.Immutable",
	PlayoffMatchGroupsDict:
		"System.Collections.Immutable.ImmutableDictionary`2[[System.String, System.Private.CoreLib],[FMS.Common.Contract.Playoff.MatchGroupView, FMS.Common.Contract]], System.Collections.Immutable",
	// The keyed doubleElimMatches map inside GetBracketData (plain Dictionary, not Immutable).
	BracketMatchesDict:
		"System.Collections.Generic.Dictionary`2[[System.Int32, System.Private.CoreLib],[FMS.GameSpecific.Api.AudienceDoubleElimMatch, FMS.GameSpecific.Api]], System.Private.CoreLib",
	// GetCurrentMatchAndPlayNumber returns a (TournamentLevel, int, int) ValueTuple.
	CurrentMatchTuple:
		"System.ValueTuple`3[[FMS.Common.Base.Enums.TournamentLevel, FMS.Common.Base],[System.Int32, System.Private.CoreLib],[System.Int32, System.Private.CoreLib]], System.Private.CoreLib",
} as const;

/** Prepend a Json.NET `$type` discriminator as the first key of an object. */
export function withType<T extends object>(typeName: string, obj: T): { $type: string } & T {
	return { $type: typeName, ...obj };
}

/** Tag every element of an array with its `$type` discriminator (first key). */
export function arrayOfType<T extends object>(typeName: string, arr: readonly T[]): ({ $type: string } & T)[] {
	return arr.map((o) => ({ $type: typeName, ...o }));
}

// #endregion
