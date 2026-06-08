import type { FmsStore } from "../state/store";
import { hubs } from "./registry";

/**
 * Register the client->server hub methods both consumers invoke. Each returns a value that
 * is sent back as a completion so the client's `invoke(...)` promise resolves. We do not
 * need to act on most of them; acking is what keeps the clients happy.
 */
export function registerHubHandlers(_store: FmsStore): void {
	// infrastructureHub: audience-display replies to PingAudienceScreen with this.
	hubs.infrastructureHub.onInvoke("AudienceScreenPingResponse", () => null);
	hubs.infrastructureHub.onInvoke("SettingsObjectValueChanged", () => null);
	hubs.infrastructureHub.onInvoke("AudienceShowMessage", () => null);

	// ftaAppHub: FTA-Buddy fetches the previous timestamp before note operations.
	hubs.ftaAppHub.onInvoke("GetPreviousTimeStamp", () => new Date().toISOString());
	for (const method of ["NoteAdded", "NoteUpdated", "NoteResolved", "NoteReopened", "NoteDeleted"]) {
		hubs.ftaAppHub.onInvoke(method, () => null);
	}
}
