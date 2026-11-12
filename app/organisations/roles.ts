/**
 * The four roles a member of an organisation can hold, and what each may do.
 *
 * This is the permission table of `docs/security.md`, "Organisations and
 * roles", in the form Better Auth's organization plugin checks on every
 * request: a role may do exactly what is listed here and nothing else.
 *
 * Two rows of that table are not a list of actions but rules about owners, and
 * the plugin holds them itself for the role named in `creatorRole`: only an
 * owner makes another person an owner or changes or removes an owner, and the
 * last owner cannot leave, be removed or be demoted. `test/organisations/`
 * proves every cell, whichever of the two places decides it.
 */
import { createAccessControl } from "better-auth/plugins/access";
import * as z from "zod";

export const Role = z.enum(["owner", "admin", "finance", "member"]);
export type Role = z.infer<typeof Role>;

/** The roles an invitation can give. Ownership is given by an owner to a member, never by invitation. */
export const InvitedRole = z.enum(["admin", "finance", "member"]);

/** Every action a role can be allowed, by the resource it acts on. The names are the plugin's. */
const actions = {
	organization: ["update", "delete"],
	member: ["update", "delete"],
	invitation: ["create", "cancel"],
} as const;

export const accessControl = createAccessControl(actions);

export const roles = {
	owner: accessControl.newRole({
		organization: ["update", "delete"],
		member: ["update", "delete"],
		invitation: ["create", "cancel"],
	}),
	admin: accessControl.newRole({
		organization: ["update"],
		member: ["update", "delete"],
		invitation: ["create", "cancel"],
	}),
	// Finance (TS-064) administers no people: in the plugin it is a member. What
	// it may see beyond a member, Bill, rates and everyone's time and expenses,
	// is decided in `access.ts` and `app/shell/destinations.ts`.
	finance: accessControl.newRole({
		organization: [],
		member: [],
		invitation: [],
	}),
	// Seeing the organisation and its members, and leaving it, need no permission
	// beyond being a member.
	member: accessControl.newRole({
		organization: [],
		member: [],
		invitation: [],
	}),
} satisfies Record<Role, unknown>;

type Wanted = { [Resource in keyof typeof actions]?: (typeof actions)[Resource][number][] };

/**
 * Whether a role may do everything in `wanted`, by the table above. The pages
 * ask this to decide which controls to show. Showing a control is a courtesy:
 * the server asks the same table again when the control is used.
 */
export function allows(role: Role, wanted: Wanted): boolean {
	return roles[role].authorize(wanted).success;
}

/**
 * The roles `actor` may give a member who holds `target`: every role for an
 * owner, admin, Finance and member for an admin acting on anyone but an owner, and none
 * otherwise. Only an owner makes or changes an owner.
 */
export function rolesToGive(actor: Role, target: Role): Role[] {
	if (!allows(actor, { member: ["update"] })) return [];
	if (actor === "owner") return [...Role.options];
	return target === "owner" ? [] : ["admin", "finance", "member"];
}

/** Whether `actor` may remove a member who holds `target`. Only an owner removes an owner. */
export function mayRemove(actor: Role, target: Role): boolean {
	return allows(actor, { member: ["delete"] }) && (actor === "owner" || target !== "owner");
}
