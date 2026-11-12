/**
 * The database's public surface. Code outside `app/db/` imports from here.
 *
 * Tables with an `organisation_id` are deliberately absent: they are reached
 * through `organisationScope`, which limits every statement to one organisation.
 * `biome.json` refuses an import of `~/db/schema` or `~/db/scope` anywhere else.
 */
export {
	type ActivitySummary,
	type ActivityValue,
	accounts,
	organisations,
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
} from "./scope";
export { uuidv7 } from "./uuidv7";
