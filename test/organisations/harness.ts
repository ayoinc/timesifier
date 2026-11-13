import { env } from "cloudflare:workers";
import { expect } from "vitest";
import * as z from "zod";
import { uuidv7 } from "~/db";
import { get, type Mailbox, post, signIn } from "../auth/harness";

export type Role = "owner" | "admin" | "finance" | "member";

const DAY = 24 * 60 * 60 * 1000;
export const SEVEN_DAYS = 7 * DAY;

/** The one answer to a person who asks about an organisation that is not theirs, or not there. */
export const ORGANISATION_NOT_FOUND = {
	status: 404,
	body: { code: "ORGANIZATION_NOT_FOUND", message: "Organization not found" },
};

/** The one answer to a person who asks for an invitation that is not theirs to take. */
export const INVITATION_NOT_FOUND = {
	status: 404,
	body: { code: "INVITATION_NOT_FOUND", message: "Invitation not found" },
};

/** A response as a caller can tell it from another: its status and its body. */
export async function answer(response: Response): Promise<{ status: number; body: unknown }> {
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** One row straight from D1, to show what a request did or did not store. */
export function row<T = Record<string, unknown>>(sql: string, ...values: unknown[]) {
	return env.DB.prepare(sql)
		.bind(...values)
		.first<T>();
}

/** One value straight from D1, for example a count. */
export async function value<T = number>(sql: string, ...values: unknown[]): Promise<T | null> {
	const found = await row<Record<string, T>>(sql, ...values);
	return found ? (Object.values(found)[0] ?? null) : null;
}

const Created = z.object({ id: z.string(), name: z.string(), slug: z.string() });

/**
 * Creates an organisation the way a page will: a name, and nothing else. It
 * then gets seats for everyone the test invites: these tests are about other
 * rules, and the plan's seats (TS-099) have tests of their own, which call
 * `setSeats` with the number they need.
 */
export async function createOrganisation(cookie: string, name: string) {
	const response = await post("/organization/create", { name }, { cookie });
	expect(response.status).toBe(200);
	const created = Created.parse(await response.json());
	await setSeats(created.id, ROOM_FOR_EVERYONE);
	return created;
}

/** Seats enough for any test of a rule other than the seats. */
export const ROOM_FOR_EVERYONE = 1000;

/** Gives an organisation `seats` on its plan. */
export async function setSeats(organisationId: string, seats: number | null) {
	await env.DB.prepare("update organisations set seats = ? where id = ?")
		.bind(seats, organisationId)
		.run();
}

const Invited = z.object({ id: z.string(), email: z.string(), role: z.string() });

/** Invites an address the way a page will, and returns the invitation. */
export async function invite(
	cookie: string,
	organizationId: string,
	email: string,
	role: "admin" | "member" = "member",
) {
	const response = await post(
		"/organization/invite-member",
		{ organizationId, email, role },
		{ cookie },
	);
	expect(response.status).toBe(200);
	return Invited.parse(await response.json());
}

export function accept(cookie: string, invitationId: string): Promise<Response> {
	return post("/organization/accept-invitation", { invitationId }, { cookie });
}

export function fullOrganisation(cookie: string, organizationId: string): Promise<Response> {
	return get(`/organization/get-full-organization?organizationId=${organizationId}`, { cookie });
}

/**
 * The rows below are written straight to D1. They arrange a test: a person
 * who already holds a role, an invitation that already exists. What the test
 * is about always goes through the Worker.
 */

export async function seedOrganisation(name = "Acme", slug = "acme") {
	const id = uuidv7();
	const now = Date.now();
	// Without the plan's columns: some tests seed a database migrated only part way.
	await env.DB.prepare(
		"insert into organisations (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)",
	)
		.bind(id, name, slug, now, now)
		.run();
	return { id, name, slug };
}

/**
 * Takes away an organisation's expense categories, with their prices, as an
 * organisation made before TS-119 gave every new one the usual set has none.
 */
export async function seedNoCategories(organisationId: string) {
	await env.DB.prepare("delete from expense_categories where organisation_id = ?")
		.bind(organisationId)
		.run();
}

/** Makes an existing person a member, and returns the membership's id. */
export async function seedMembership(organisationId: string, userId: string, role: Role) {
	const id = uuidv7();
	const now = Date.now();
	await env.DB.prepare(
		"insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
	)
		.bind(id, organisationId, userId, role, now, now)
		.run();
	return id;
}

/**
 * A team of the organisation with these members, each already a member of
 * the organisation, and `managers` among them as its managers (TS-038).
 */
export async function seedTeam(
	organisationId: string,
	name: string,
	{ members = [], managers = [] }: { members?: string[]; managers?: string[] },
) {
	const id = uuidv7();
	const now = Date.now();
	const places = [
		...members.map((userId) => ({ userId, isManager: 0 })),
		...managers.map((userId) => ({ userId, isManager: 1 })),
	];
	await env.DB.batch([
		env.DB.prepare(
			"insert into teams (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
		).bind(id, organisationId, name, name.toLowerCase(), now, now),
		...places.map(({ userId, isManager }) =>
			env.DB.prepare(
				"insert into team_members (id, organisation_id, team_id, user_id, is_manager, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
			).bind(uuidv7(), organisationId, id, userId, isManager, now, now),
		),
	]);
	return id;
}

/** A person with a verified address who holds `role` and has never signed in. */
export async function seedMember(organisationId: string, role: Role, email: string) {
	const userId = uuidv7();
	const now = Date.now();
	await env.DB.prepare(
		"insert into users (id, name, email, email_verified, created_at, updated_at) values (?, '', ?, 1, ?, ?)",
	)
		.bind(userId, email, now, now)
		.run();
	return { userId, email, memberId: await seedMembership(organisationId, userId, role) };
}

/** A pending invitation with seven days left, sent by `inviterId`. */
export async function seedInvitation(
	organisationId: string,
	inviterId: string,
	email: string,
	role: "admin" | "member" = "member",
) {
	const id = uuidv7();
	const now = Date.now();
	await env.DB.prepare(
		"insert into invitations (id, organisation_id, email, role, status, expires_at, inviter_id, created_at, updated_at) values (?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
	)
		.bind(id, organisationId, email, role, now + SEVEN_DAYS, inviterId, now, now)
		.run();
	return id;
}

/** A person who signs in for real and already holds `role`, or no role at all. */
export async function signInAs(
	mailbox: Mailbox,
	organisationId: string,
	role: Role | null,
	email: string,
) {
	const { cookie, user } = await signIn(mailbox, email);
	const memberId = role ? await seedMembership(organisationId, user.id, role) : null;
	return { cookie, userId: user.id, email, memberId };
}

export function roleOf(memberId: string): Promise<Role | null> {
	return value<Role>("select role from memberships where id = ?", memberId);
}
