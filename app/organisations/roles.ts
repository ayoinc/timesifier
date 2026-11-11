/**
 * The three roles a member of an organisation can hold, and what each may do.
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

export const ROLES = ["owner", "admin", "member"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/** The roles an invitation can give. Ownership is given by an owner to a member, never by invitation. */
export const InvitedRole = z.enum(["admin", "member"]);

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
	// Seeing the organisation and its members, and leaving it, need no permission
	// beyond being a member.
	member: accessControl.newRole({
		organization: [],
		member: [],
		invitation: [],
	}),
} satisfies Record<Role, unknown>;
