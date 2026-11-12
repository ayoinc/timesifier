import type { Mailbox } from "../auth/harness";
import { createOrganisation, seedMembership, seedTeam } from "../organisations/harness";
import { type Person, person } from "./harness";

// One person of each kind the navigation and the money rules tell apart
// (docs/navigation.md; docs/security.md, "Rates and money"), in Acme: the
// owner who made it, an admin, Finance, a manager (a member who manages
// Design) and a member (in Design).

export const KINDS = ["owner", "admin", "finance", "manager", "member"] as const;
export type Kind = (typeof KINDS)[number];

export interface Roles {
	acme: { id: string; slug: string };
	people: Record<Kind, Person>;
}

export async function seedRoles(mailbox: Mailbox): Promise<Roles> {
	const owner = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(owner.cookie, "Acme");
	const admin = await person(mailbox, "grace@example.com");
	const finance = await person(mailbox, "katherine@example.com");
	const manager = await person(mailbox, "hedy@example.com");
	const member = await person(mailbox, "linus@example.com");
	await seedMembership(acme.id, admin.user.id, "admin");
	await seedMembership(acme.id, finance.user.id, "finance");
	await seedMembership(acme.id, manager.user.id, "member");
	await seedMembership(acme.id, member.user.id, "member");
	await seedTeam(acme.id, "Design", { members: [member.user.id], managers: [manager.user.id] });
	return { acme, people: { owner, admin, finance, manager, member } };
}
