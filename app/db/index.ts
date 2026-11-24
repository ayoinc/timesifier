/**
 * The database's public surface. Code outside `app/db/` imports from here.
 *
 * Tables with an `organisation_id` are deliberately absent: they are reached
 * through `organisationScope`, which limits every statement to one organisation.
 * `biome.json` refuses an import of `~/db/schema` or `~/db/scope` anywhere else.
 */

// A list of any length as one bound parameter (decision 40); rows to insert likewise (TS-108).
export { among, jsonTable, latestAmong, notAmong } from "./among";
// Every table of an organisation, a page at a time, for the export of everything (TS-126).
export {
	EXPORTED_TABLES,
	type ExportedTable,
	exportedPage,
	exportedTable,
	WITHHELD_COLUMNS,
} from "./everything";
export {
	activityAfter,
	apiTokenByHash,
	calendarFeedByHash,
	organisationCountOf,
	organisationIdsOf,
	organisationsWithWebhooks,
} from "./lookups";
// The platform console's reads and writes across organisations: metadata only (TS-099).
export * as platformData from "./platform";
export {
	type ActivitySummary,
	type ActivityValue,
	accounts,
	organisations,
	platformBrand,
	rateLimits,
	sessions,
	users,
	verifications,
} from "./schema";
export {
	everyRow,
	type Filter,
	type OrganisationScope,
	organisationScope,
	type ScopedAccessor,
	type ScopedStatement,
	type SelectOptions,
	type TenantRow,
} from "./scope";
export {
	dueRecurringInvoices,
	estimateForLink,
	expiredExports,
	reminderOrganisations,
	runningExports,
} from "./unscoped";
export { uuidv7 } from "./uuidv7";
export { waitingFor } from "./waiting";
