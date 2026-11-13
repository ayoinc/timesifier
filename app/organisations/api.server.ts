/**
 * What the pages ask of the server about organisations, members and
 * invitations.
 *
 * Every call here is a request to the handler mounted at `/api/auth`, made
 * inside the Worker with the cookie of the request the page is answering. That
 * is the one door: the list of endpoints that exist, the gate that checks
 * membership and input, the role checks and the rate limit all stand at it
 * (docs/security.md, "Organisations and roles"), and none of them acts on a
 * call that goes round it. A page's loader or action therefore can do nothing
 * the person could not do by calling the endpoint themselves.
 *
 * The organisation's id in every call comes from the caller, which takes it
 * from the membership the layout read for the address, never from a form.
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as z from "zod";
import { handleAuthRequest } from "~/auth/auth.server";
import { users } from "~/db";
import { InvitedRole, type Role } from "./roles";

/** The server said no: its status, and the code that says why when it gave one. */
export type Refusal = { ok: false; status: number; code: string | null };
export type Answer<Data> = { ok: true; data: Data } | Refusal;

/**
 * What the server needs to know about who is asking: their session, where the
 * page they are on came from, and the client the rate limit counts them by.
 */
const CARRIED = ["Cookie", "Origin", "CF-Connecting-IP", "User-Agent"];

const Failure = z.object({ code: z.string() });

async function ask<Schema extends z.ZodType>(
	request: Request,
	path: string,
	schema: Schema,
	input: { query: Record<string, string> } | { body: Record<string, unknown> },
): Promise<Answer<z.output<Schema>>> {
	const url = new URL(`/api/auth/organization/${path}`, request.url);
	const headers = new Headers();
	for (const name of CARRIED) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}

	let init: RequestInit = { headers };
	if ("query" in input) {
		url.search = new URLSearchParams(input.query).toString();
	} else {
		headers.set("Content-Type", "application/json");
		init = { method: "POST", headers, body: JSON.stringify(input.body) };
	}

	const response = await handleAuthRequest(new Request(url, init));
	const answer: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const failure = Failure.safeParse(answer);
		return { ok: false, status: response.status, code: failure.success ? failure.data.code : null };
	}
	const parsed = schema.safeParse(answer);
	// An answer in a shape this file does not know is a fault of ours, not a refusal.
	return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 502, code: null };
}

const Organisation = z.object({ name: z.string(), slug: z.string() });
export type OrganisationSummary = z.output<typeof Organisation>;

/** The organisations the person belongs to, oldest first. */
export function listOrganisations(request: Request) {
	return ask(request, "list", z.array(Organisation), { query: {} });
}

/** Creates an organisation called `name`, with the person as its owner. The server chooses the slug. */
export function createOrganisation(request: Request, name: string) {
	return ask(request, "create", Organisation, { body: { name } });
}

export function renameOrganisation(request: Request, organizationId: string, name: string) {
	return ask(request, "update", Organisation, { body: { organizationId, data: { name } } });
}

/** Deletes the organisation, with its memberships and invitations. */
export function deleteOrganisation(request: Request, organizationId: string) {
	return ask(request, "delete", z.unknown(), { body: { organizationId } });
}

const Invitation = z.object({
	id: z.string(),
	email: z.string(),
	role: InvitedRole,
	status: z.string(),
	expiresAt: z.iso.datetime(),
});
export type Invitation = z.output<typeof Invitation>;

/**
 * The invitations that can still be accepted: pending, and not yet expired.
 * The server keeps every invitation it ever stored and lists them all.
 */
export async function listOpenInvitations(
	request: Request,
	organizationId: string,
): Promise<Answer<Invitation[]>> {
	const answer = await ask(request, "list-invitations", z.array(Invitation), {
		query: { organizationId },
	});
	if (!answer.ok) return answer;
	const now = new Date().toISOString();
	const open = answer.data.filter(
		({ status, expiresAt }) => status === "pending" && expiresAt > now,
	);
	return { ok: true, data: open };
}

/** Sends an invitation, and returns the invitation's id. */
export function inviteMember(
	request: Request,
	organizationId: string,
	invitation: { email: string; role: z.output<typeof InvitedRole> },
) {
	return ask(request, "invite-member", z.object({ id: z.string() }), {
		body: { organizationId, ...invitation },
	});
}

export function cancelInvitation(request: Request, organizationId: string, invitationId: string) {
	return ask(request, "cancel-invitation", z.unknown(), {
		body: { organizationId, invitationId },
	});
}

export function changeRole(
	request: Request,
	organizationId: string,
	change: { memberId: string; role: Role },
) {
	return ask(request, "update-member-role", z.unknown(), { body: { organizationId, ...change } });
}

export function removeMember(request: Request, organizationId: string, memberId: string) {
	return ask(request, "remove-member", z.unknown(), {
		body: { organizationId, memberIdOrEmail: memberId },
	});
}

/** Takes the person out of the organisation. */
export function leaveOrganisation(request: Request, organizationId: string) {
	return ask(request, "leave", z.unknown(), { body: { organizationId } });
}

const ReceivedInvitation = z.object({
	role: InvitedRole,
	inviterId: z.string(),
	inviterEmail: z.string(),
	organizationName: z.string(),
	organizationSlug: z.string(),
});

/** An invitation as the person it was sent to sees it. */
export type ReceivedInvitation = {
	organisation: { name: string; slug: string };
	role: z.output<typeof InvitedRole>;
	inviter: { name: string | null; email: string };
};

/**
 * The invitation with this id, when it is there for the person asking to take.
 * The server gives one refusal for every other case and so does this.
 */
export async function findInvitation(
	request: Request,
	id: string,
): Promise<Answer<ReceivedInvitation>> {
	const answer = await ask(request, "get-invitation", ReceivedInvitation, { query: { id } });
	if (!answer.ok) return answer;

	const { role, inviterId, inviterEmail, organizationName, organizationSlug } = answer.data;
	// The server names the sender by their address alone. Their name is read
	// only now, for a person the server has just said the invitation is for.
	const [inviter] = await drizzle(env.DB)
		.select({ name: users.name })
		.from(users)
		.where(eq(users.id, inviterId))
		.limit(1);
	return {
		ok: true,
		data: {
			organisation: { name: organizationName, slug: organizationSlug },
			role,
			inviter: { name: inviter?.name ?? null, email: inviterEmail },
		},
	};
}

export function acceptInvitation(request: Request, invitationId: string) {
	return ask(request, "accept-invitation", z.unknown(), { body: { invitationId } });
}

export function declineInvitation(request: Request, invitationId: string) {
	return ask(request, "reject-invitation", z.unknown(), { body: { invitationId } });
}
