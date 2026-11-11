/**
 * Compile-time checks, run by `pnpm typecheck`. Nothing here executes.
 * Each `@ts-expect-error` fails the typecheck if the line below it starts to compile.
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { organisations, users } from "~/db/schema";
import { everyRow, type OrganisationScope, scopedAccessor } from "~/db/scope";

export function tablesWithoutAnOrganisationCannotBeScoped(db: DrizzleD1Database) {
	// @ts-expect-error users has no organisation_id column
	scopedAccessor(db, users, "organisation-id");
	// @ts-expect-error organisations has no organisation_id column
	scopedAccessor(db, organisations, "organisation-id");
}

export async function theOrganisationComesOnlyFromTheScope(scope: OrganisationScope) {
	// @ts-expect-error an insert cannot name an organisation
	await scope.memberships.insert({ userId: "user-id", organisationId: "another-organisation" });
	// @ts-expect-error an update cannot move a row to an organisation
	await scope.memberships.update({ organisationId: "another-organisation" }, everyRow);
}

export async function updatesAndDeletesNameTheirRows(scope: OrganisationScope) {
	// @ts-expect-error an update needs a filter, or everyRow
	await scope.memberships.update({ role: "admin" });
	// @ts-expect-error a delete needs a filter, or everyRow
	await scope.memberships.delete();
}
