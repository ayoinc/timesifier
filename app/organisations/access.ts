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
 * Whether `access` may approve or refuse a request for leave of `personId`
 * (TS-061): an owner or admin, or a manager of a team the person is in, and
 * never the person themselves, whatever their role.
 */
export function mayDecideLeaveOf(access: Access, personId: string): boolean {
	if (personId === access.userId) return false;
	return isAdministrator(access.role) || access.managed.has(personId);
}

/**
 * Whether `access` may cancel an approved request of `personId` that has not
 * started: an owner or admin alone, and never on their own leave.
 */
export function mayCancelLeaveOf(access: Access, personId: string): boolean {
	return personId !== access.userId && isAdministrator(access.role);
}

/**
 * Whether `access` may see which kind of leave `personId` is on. Everyone in
 * the organisation sees that a colleague is on leave; the person, the
 * managers of their teams, owners and admins also see the kind.
 */
export function maySeeLeaveKindOf(access: Access, personId: string): boolean {
	return maySeeTimeOf(access, personId);
}

/** Whether `access` may set the working week, the kinds of leave and the public holidays. */
export function mayManageLeavePolicy(access: Access): boolean {
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
