import type { Role } from "./roles";

/**
 * Whose time a member of an organisation may see, change and decide on
 * (docs/security.md, "Whose time"). The destinations a person is shown are
 * `canSee` in `app/shell/destinations.ts`; these are the rules inside them.
 *
 * - A person sees, adds and changes their own entries, and submits and
 *   withdraws their own periods.
 * - An owner or admin sees everyone's time and decides everyone's periods,
 *   their own included, and alone reopens an approved period. They change
 *   nobody's entries but their own (decision 25).
 * - A manager sees the time of the members of the teams they manage, and
 *   decides those members' periods but never their own (TS-047). They change
 *   nobody's entries but their own (TS-038).
 *
 * Nothing here reads the database: `accessOf` in `access.server.ts` gathers
 * what these rules take, on every request.
 */

/** What decides whose time a person may reach in one organisation. */
export interface Access {
	userId: string;
	role: Role;
	/** The people in the teams they manage; empty for a person who manages none. */
	managed: ReadonlySet<string>;
}

/** Whether `role` is an owner or an admin: the people who look after the whole organisation. */
export function isAdministrator(role: Role): boolean {
	return role === "owner" || role === "admin";
}

/** Whether `access` may see the entries, totals and periods of `personId`. */
export function maySeeTimeOf(access: Access, personId: string): boolean {
	return personId === access.userId || isAdministrator(access.role) || access.managed.has(personId);
}

/** Whether `access` may add, change or delete entries of `personId`: their own alone. */
export function mayChangeTimeOf(access: Access, personId: string): boolean {
	return personId === access.userId;
}

/** Whether `access` may approve or return a period of `personId`. */
export function mayDecidePeriodOf(access: Access, personId: string): boolean {
	if (isAdministrator(access.role)) return true;
	return personId !== access.userId && access.managed.has(personId);
}

/** Whether `access` may reopen an approved period: an owner or admin alone (TS-047). */
export function mayReopenPeriods(access: Access): boolean {
	return isAdministrator(access.role);
}

/**
 * Whose time a list or a report for `access` may hold: everyone's, or the
 * people named. A query passes the people to SQL; it never filters afterwards.
 */
export type TimeScope = { everyone: true } | { everyone: false; people: string[] };

export function timeScopeOf(access: Access): TimeScope {
	if (isAdministrator(access.role)) return { everyone: true };
	return { everyone: false, people: [...new Set([access.userId, ...access.managed])] };
}
