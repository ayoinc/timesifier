import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organisations } from "~/db";

/** What `changeGeneral` may change. A field left out stays as it is. */
export interface GeneralSettings {
	timeZone?: string;
	weekStartsOn?: number;
	clientsEnabled?: boolean;
}

/**
 * Changes the general settings of the organisation `organisationId` (TS-048).
 * The values are already checked; who may change them is the caller's to
 * decide. Turning Clients off deletes nothing: the clients and the projects'
 * clients stay, and come back when it is turned on.
 */
export async function changeGeneral(
	db: D1Database,
	organisationId: string,
	settings: GeneralSettings,
): Promise<void> {
	await drizzle(db)
		.update(organisations)
		.set({ ...settings, updatedAt: new Date() })
		.where(eq(organisations.id, organisationId));
}

let zones: string[] | undefined;

/** Every zone a person may choose, `UTC` first, then by name. */
export function timeZones(): string[] {
	zones ??= ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
	return zones;
}
