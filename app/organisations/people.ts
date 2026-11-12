import type { Role } from "./roles";

// How people and their roles are put into words. Nothing here runs only on the
// server: the type above is erased, and the pages import this file freely.

/**
 * How a person is shown wherever they are named: by their name, or by their
 * email address when they have given none. An account made by signing in with
 * a code has no name until its owner sets one in Settings.
 */
export function nameOrEmail(person: { name?: string | null | undefined; email: string }): string {
	return person.name?.trim() || person.email;
}

/**
 * How a person is titled in a list of people (Team, Approvals, Reports): their
 * name, or, when they have given none, the part of their address before the
 * "@", with the whole address on the line under it (`addressLine`).
 */
export function shownName(person: { name?: string | null | undefined; email: string }): string {
	const name = person.name?.trim();
	if (name) return name;
	const at = person.email.lastIndexOf("@");
	return at > 0 ? person.email.slice(0, at) : person.email;
}

/** The line under a person's title in a list: their address when they have given no name, else nothing. */
export function addressLine(person: {
	name?: string | null | undefined;
	email: string;
}): string | null {
	return person.name?.trim() ? null : person.email;
}

export const ROLE_LABELS: Record<Role, string> = {
	owner: "Owner",
	admin: "Admin",
	finance: "Finance",
	member: "Member",
};

/** A role inside a sentence: "as an admin". */
export const AS_ROLE: Record<Role, string> = {
	owner: "an owner",
	admin: "an admin",
	finance: "a Finance member",
	member: "a member",
};

/** What each role may do, in a sentence, for the person choosing one. */
export const ROLE_MEANINGS: Record<Role, string> = {
	owner: "Owners can do everything, including deleting the organisation.",
	admin: "Admins can rename the organisation, invite people and manage members.",
	finance:
		"Finance can see everyone's time and expenses, every rate and report, and run invoices and estimates, but manages nobody.",
	member: "Tracks their own time and submits their timesheet.",
};
