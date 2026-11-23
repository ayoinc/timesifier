import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, recordStatement } from "~/activity/activity.server";
import { organisationScope, organisations } from "~/db";

/** What `changeGeneral` may change. A field left out stays as it is. */
export interface GeneralSettings {
	timeZone?: string;
	weekStartsOn?: number;
	clientsEnabled?: boolean;
	/** The currency of money nobody gives another (TS-067). A rate keeps the one it was set in. */
	currency?: string;
	/** Whether non-billable time counts against hour budgets (TS-069). */
	budgetCountsNonBillable?: boolean;
}

/** The settings whose change moves people's days, and so is recorded (TR-11). */
const RECORDED = ["timeZone", "weekStartsOn"] as const;

/**
 * Changes the general settings of the organisation `organisationId` (TS-048).
 * The values are already checked; who may change them is the caller's to
 * decide. Turning Clients off deletes nothing: the clients and the projects'
 * clients stay, and come back when it is turned on. A change of the default
 * zone or of the day weeks start on is recorded as `actorId`'s, with before
 * and after, in the batch that makes it (TR-11).
 */
export async function changeGeneral(
	db: D1Database,
	organisationId: string,
	settings: GeneralSettings,
	actorId: string,
): Promise<void> {
	const orm = drizzle(db);
	const [before] = await orm
		.select({ timeZone: organisations.timeZone, weekStartsOn: organisations.weekStartsOn })
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	const update = orm
		.update(organisations)
		.set({ ...settings, updatedAt: new Date() })
		.where(eq(organisations.id, organisationId));
	const summary = changes(before ?? null, { ...before, ...settings }, RECORDED);
	if (!summary.after || Object.keys(summary.after).length === 0) {
		await update;
		return;
	}
	await orm.batch([
		update,
		recordStatement(
			organisationScope(db, organisationId),
			actorId,
			"organisation.settings_changed",
			{ type: "organisation", id: organisationId, ownerId: null },
			summary,
		).query,
	]);
}

let zones: string[] | undefined;

/** Every zone a person may choose, `UTC` first, then by name. */
export function timeZones(): string[] {
	zones ??= ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
	return zones;
}
