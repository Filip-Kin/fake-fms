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
