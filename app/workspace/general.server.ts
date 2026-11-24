import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, recordStatement } from "~/activity/activity.server";
import { organisationScope, organisations } from "~/db";
import { parsePattern } from "~/lib/codes";

import { hasClients, type WorkModel } from "./work-model";

/** What `changeGeneral` may change. A field left out stays as it is. */
export interface GeneralSettings {
	timeZone?: string;
	weekStartsOn?: number;
	/** How the organisation works (TS-115a, decision 67). */
	workModel?: WorkModel;
	/** What it calls internal work, in the plural. */
	internalTerm?: string;
	/** Whether every project must have a code (TS-115a); under Both, every client project. */
	projectCodeRequired?: boolean;
	/** Under Both, whether every work code must have a code. */
	workCodeRequired?: boolean;
	/** The pattern new projects are numbered by, already checked by `parsePattern`; null for none. */
	projectCodePattern?: string | null;
	/** The currency of money nobody gives another (TS-067). A rate keeps the one it was set in. */
	currency?: string;
	/** Whether non-billable time counts against hour budgets (TS-069). */
	budgetCountsNonBillable?: boolean;
}

/**
 * The settings whose change is recorded: those that move people's days (TR-11),
 * and How you work and the project codes' rules (TS-115a).
 */
const RECORDED = [
	"timeZone",
	"weekStartsOn",
	"workModel",
	"internalTerm",
	"projectCodeRequired",
	"workCodeRequired",
	"projectCodePattern",
] as const;

/**
 * Changes the general settings of the organisation `organisationId` (TS-048).
 * The values are already checked; who may change them is the caller's to
 * decide. Changing How you work deletes nothing: under Internal work the
 * clients and the projects' clients stay, and come back with clients. A new
 * pattern numbers from its own number. A change of a recorded setting is
 * recorded as `actorId`'s, with before and after, in the batch that makes it.
 */
export async function changeGeneral(
	db: D1Database,
	organisationId: string,
	settings: GeneralSettings,
	actorId: string,
): Promise<void> {
	const orm = drizzle(db);
	const [before] = await orm
		.select({
			timeZone: organisations.timeZone,
			weekStartsOn: organisations.weekStartsOn,
			workModel: organisations.workModel,
			internalTerm: organisations.internalTerm,
			projectCodeRequired: organisations.projectCodeRequired,
			workCodeRequired: organisations.workCodeRequired,
			projectCodePattern: organisations.projectCodePattern,
		})
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	const patternChanged =
		settings.projectCodePattern !== undefined &&
		settings.projectCodePattern !== before?.projectCodePattern;
	const update = orm
		.update(organisations)
		.set({
			...settings,
			// Kept beside `work_model` until a later migration takes it away (decision 67).
			...(settings.workModel ? { clientsEnabled: hasClients(settings.workModel) } : {}),
			...(patternChanged
				? {
						projectCodeNext: settings.projectCodePattern
							? (parsePattern(settings.projectCodePattern)?.start ?? null)
							: null,
					}
				: {}),
			updatedAt: new Date(),
		})
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

/**
 * Gives a new organisation, at `slug`, the answer its creator gave to How you
 * work (TS-115a), as part of creating it: nothing is recorded, as nothing
 * else of its creation is by a person.
 */
export async function startWorkModel(db: D1Database, slug: string, workModel: WorkModel) {
	await drizzle(db)
		.update(organisations)
		.set({ workModel, clientsEnabled: hasClients(workModel) })
		.where(eq(organisations.slug, slug));
}

let zones: string[] | undefined;

/** Every zone a person may choose, `UTC` first, then by name. */
export function timeZones(): string[] {
	zones ??= ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
	return zones;
}
