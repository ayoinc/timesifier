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

export const ROLE_LABELS: Record<Role, string> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
};

/** A role inside a sentence: "as an admin". */
export const AS_ROLE: Record<Role, string> = {
	owner: "an owner",
	admin: "an admin",
	member: "a member",
};

/** What each role may do, in a sentence, for the person choosing one. */
export const ROLE_MEANINGS: Record<Role, string> = {
	owner: "Owners can do everything, including deleting the organisation.",
	admin: "Admins can rename the organisation, invite people and manage members.",
	member: "Members can see the organisation and who is in it.",
};
