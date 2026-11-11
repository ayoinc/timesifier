/**
 * The database's public surface. Code outside `app/db/` imports from here.
 *
 * Tables with an `organisation_id` are deliberately absent: they are reached
 * through `organisationScope`, which limits every statement to one organisation.
 */
export { organisations, users } from "./schema";
export { type OrganisationScope, organisationScope, type ScopedAccessor } from "./scope";
export { uuidv7 } from "./uuidv7";
