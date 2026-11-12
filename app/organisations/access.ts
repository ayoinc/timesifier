import type { Role } from "./roles";

/**
 * Whose time a member of an organisation may see, change and decide on
 * (docs/security.md, "Whose time"), and who may see money (docs/security.md,
 * "Rates and money"). The destinations a person is shown are `canSee` in
 * `app/shell/destinations.ts`; these are the rules inside them.
 *
 * - A person sees, adds and changes their own entries and expenses, and
 *   submits and withdraws their own periods.
 * - An owner or admin sees everyone's time and decides everyone's periods,
 *   their own included, and alone reopens an approved period. They change
 *   nobody's entries but their own (decision 25).
 * - Finance (TS-064) sees everyone's time and expenses, every rate and every
 *   amount, and runs Bill. It decides no period unless it manages a team, and
 *   administers no people.
 * - A manager sees the time of the members of the teams they manage, and
 *   decides those members' periods but never their own (TS-047). They change
 *   nobody's entries but their own (TS-038). A manager sees no rate.
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

/** Whether `role` is Finance. */
export function isFinance(role: Role): boolean {
	return role === "finance";
}

/**
 * Whether `role` sees money: rates, costs, amounts, invoices, estimates and
 * profitability. Owners, admins and Finance, never a manager as such (owner's
 * decision, TS-064). A page leaves the amounts out of what it sends to anyone
 * else; it does not hide them in the browser.
 */
export function maySeeRates(role: Role): boolean {
	return isAdministrator(role) || isFinance(role);
}

/** Whether `role` may set billable and cost rates, the organisation's currency and the taxes. */
export function mayManageRates(role: Role): boolean {
	return maySeeRates(role);
}

/** Whether `role` may make, send and record payments on invoices and estimates. */
export function mayInvoice(role: Role): boolean {
	return maySeeRates(role);
}

/** Whether `role` may create, change and archive tasks and tags. */
export function mayManageTasks(role: Role): boolean {
	return isAdministrator(role);
}

/** Whether `role` may make API tokens, webhooks and imports, and move the lock date. */
export function mayManageIntegrations(role: Role): boolean {
	return isAdministrator(role);
}

/** Whether `access` may see the entries, totals and periods of `personId`. */
export function maySeeTimeOf(access: Access, personId: string): boolean {
	return personId === access.userId || maySeeRates(access.role) || access.managed.has(personId);
}

/** Whether `access` may see the expenses of `personId`: whoever may see their time. */
export function maySeeExpensesOf(access: Access, personId: string): boolean {
	return maySeeTimeOf(access, personId);
}

/** Whether `access` may add, change or delete expenses of `personId`: their own alone, as with time. */
export function mayChangeExpensesOf(access: Access, personId: string): boolean {
	return personId === access.userId;
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
 * managers of their teams, owners and admins also see the kind. Finance does
 * not: it sees everyone's time for billing, and a kind such as sick leave is
 * none of its business.
 */
export function maySeeLeaveKindOf(access: Access, personId: string): boolean {
	return personId === access.userId || isAdministrator(access.role) || access.managed.has(personId);
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
	if (maySeeRates(access.role)) return { everyone: true };
	return { everyone: false, people: [...new Set([access.userId, ...access.managed])] };
}

/**
 * Whose records in the activity log `access` may read: everyone's for an
 * owner, admin or Finance; their own and their managed people's for a
 * manager; their own for anyone else. Organisation-level records, which are
 * about nobody's time, are read by owners, admins and Finance alone.
 */
export function activityScopeOf(access: Access): TimeScope {
	return timeScopeOf(access);
}
