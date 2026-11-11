/**
 * Organisations, memberships and invitations: Better Auth's organization
 * plugin on our tables, and the rules of ours that it does not hold itself.
 *
 * The plugin decides what a role may do, from `app/organisations/roles.ts`,
 * keeps the last owner in place, and makes an invitation work once. In front
 * of it stands one gate, which every request to `/organization/*` passes
 * before the plugin sees it. The gate
 *
 * - answers 404 for every endpoint of the plugin that is not listed in
 *   `ENDPOINTS`, so an upgrade cannot add one unseen;
 * - accepts exactly the input listed there and refuses anything else with 400;
 * - takes the organisation from the request, never from the session, and
 *   answers the same 404 whether that organisation does not exist or the
 *   person asking is not a member of it;
 * - answers the same 404 for every invitation that is not there for the
 *   person asking to take;
 * - derives a new organisation's slug from its name.
 *
 * See docs/security.md, "Organisations and roles".
 */
import { env, waitUntil } from "cloudflare:workers";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import type { BetterAuthPlugin, DBAdapter } from "better-auth/types";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as z from "zod";
import { organisationScope, organisations } from "~/db";
import { accessControl, InvitedRole, Role, roles } from "~/organisations/roles";
import { availableSlug, slugFromName, slugSearchPrefix } from "~/organisations/slug";
import { sendEmail } from "./email.server";
import { isOurHost } from "./hosts";
import { INVITATION_LIFETIME_SECONDS, invitationEmail } from "./invitation-email";

/** Requests one client may make on one of these paths in `window` seconds; the next is answered 429. */
const LIMIT = { window: 60, max: 10 };

/**
 * The two requests that create rows or send email for the asking. Merged into
 * Better Auth's `rateLimit.customRules`.
 */
export const ORGANISATION_RATE_LIMITS = {
	"/organization/create": LIMIT,
	"/organization/invite-member": LIMIT,
};

// The plugin's own codes and wording, so a page reads one vocabulary. The
// plugin sends them with status 400, and something else to a person who is
// not a member or not the recipient.
const organisationNotFound = () =>
	new APIError("NOT_FOUND", { code: "ORGANIZATION_NOT_FOUND", message: "Organization not found" });
const invitationNotFound = () =>
	new APIError("NOT_FOUND", { code: "INVITATION_NOT_FOUND", message: "Invitation not found" });

/** The slug for a new organisation called `name`: the name's own, or the next one free. */
async function slugFor(name: string): Promise<string> {
	const wanted = slugFromName(name);
	const taken = await drizzle(env.DB)
		.select({ slug: organisations.slug })
		.from(organisations)
		// A slug holds no character that `like` treats as a wildcard.
		.where(like(organisations.slug, `${slugSearchPrefix(wanted)}%`));
	return availableSlug(wanted, new Set(taken.map(({ slug }) => slug)));
}

const Id = z.string().min(1).max(64);
/**
 * Shown in pages and in the subject of an email, so it holds no line break, no
 * other control character and none that reverses the direction of text.
 */
const Name = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.regex(/^[^\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+$/u);
const organisation = { organizationId: Id };
const nothing = z.strictObject({});

/** Who is asking, and Better Auth's own access to its tables. */
type Asking = {
	user: { id: string; email: string; emailVerified: boolean };
	adapter: Pick<DBAdapter, "findOne">;
};

/**
 * One endpoint of the plugin: where its input is, and `admit`, which returns
 * that input as validated or throws the response the caller gets instead. For
 * a POST, what `admit` returns is the body the plugin receives.
 */
type Endpoint = {
	from: "body" | "query";
	admit(raw: unknown, asking: Asking): Promise<Record<string, unknown>>;
};

/** `raw` as `schema` allows it, or a 400 that says what is wrong with it. */
async function valid<Input>(schema: z.ZodType<Input>, raw: unknown): Promise<Input> {
	const parsed = await schema.safeParseAsync(raw ?? {});
	if (parsed.success) return parsed.data;
	throw new APIError("BAD_REQUEST", {
		code: "VALIDATION_ERROR",
		message: z.prettifyError(parsed.error),
	});
}

/** An endpoint for any signed-in person. */
function anyone(from: Endpoint["from"], schema: z.ZodType<Record<string, unknown>>): Endpoint {
	return { from, admit: (raw) => valid(schema, raw) };
}

/**
 * An endpoint for the members of the organisation named in the request,
 * whatever their role: what a role may do is the plugin's to decide. An
 * organisation that does not exist and one the person does not belong to get
 * the same answer.
 */
function member(
	from: Endpoint["from"],
	schema: z.ZodType<{ organizationId: string; invitationId?: string }>,
): Endpoint {
	return {
		from,
		async admit(raw, { user }) {
			const input = await valid(schema, raw);
			const scope = organisationScope(env.DB, input.organizationId);
			const [membership] = await scope.memberships.select((m) => eq(m.userId, user.id));
			if (!membership) throw organisationNotFound();

			const { invitationId } = input;
			if (invitationId) {
				// The plugin finds the invitation to cancel by its id alone. Here it
				// has to be a pending one of this organisation.
				const [pending] = await scope.invitations.select((i) =>
					and(eq(i.id, invitationId), eq(i.status, "pending")),
				);
				if (!pending) throw invitationNotFound();
			}
			return input;
		},
	};
}

/** The fields of the plugin's `invitation` model that decide whether it can still be taken. */
type StoredInvitation = { email: string; status: string; expiresAt: Date };

/**
 * An endpoint for the person an invitation was sent to. There is one answer
 * for an invitation that does not exist, one that has been accepted, declined
 * or cancelled, one that has expired, and one that was sent to somebody else,
 * so an invitation's id tells nobody but its recipient anything.
 */
function recipient(
	from: Endpoint["from"],
	schema: z.ZodType<{ invitationId: string } | { id: string }>,
): Endpoint {
	return {
		from,
		async admit(raw, { user, adapter }) {
			const input = await valid(schema, raw);
			// The organisation is not known until the invitation is read, so this
			// one read is by id alone, made by Better Auth, which owns the row.
			const invitation = await adapter.findOne<StoredInvitation>({
				model: "invitation",
				where: [{ field: "id", value: "id" in input ? input.id : input.invitationId }],
			});
			const theirs =
				invitation?.status === "pending" &&
				invitation.expiresAt > new Date() &&
				invitation.email.toLowerCase() === user.email.toLowerCase() &&
				user.emailVerified;
			if (!theirs) throw invitationNotFound();
			return input;
		},
	};
}

/** Every endpoint of the plugin that can be called, and exactly what each accepts. */
const ENDPOINTS: Record<string, Endpoint> = {
	"/organization/create": anyone(
		"body",
		// A name and nothing else. The slug is ours to choose.
		z
			.strictObject({ name: Name })
			.transform(async ({ name }) => ({ name, slug: await slugFor(name) })),
	),
	"/organization/list": anyone("query", nothing),
	"/organization/list-user-invitations": anyone("query", nothing),

	"/organization/get-invitation": recipient("query", z.strictObject({ id: Id })),
	"/organization/accept-invitation": recipient("body", z.strictObject({ invitationId: Id })),
	"/organization/reject-invitation": recipient("body", z.strictObject({ invitationId: Id })),

	"/organization/get-full-organization": member("query", z.strictObject(organisation)),
	"/organization/list-members": member("query", z.strictObject(organisation)),
	"/organization/list-invitations": member("query", z.strictObject(organisation)),
	"/organization/update": member(
		"body",
		// The name alone: an organisation's slug never changes.
		z.strictObject({ ...organisation, data: z.strictObject({ name: Name }) }),
	),
	"/organization/delete": member("body", z.strictObject(organisation)),
	"/organization/invite-member": member(
		"body",
		// No `resend`, which would give a pending invitation another seven days.
		z.strictObject({ ...organisation, email: z.email().max(254), role: InvitedRole }),
	),
	"/organization/cancel-invitation": member(
		"body",
		z.strictObject({ ...organisation, invitationId: Id }),
	),
	"/organization/update-member-role": member(
		"body",
		// One role. The plugin would also take a list, and store "admin,owner".
		z.strictObject({ ...organisation, memberId: Id, role: Role }),
	),
	"/organization/remove-member": member(
		"body",
		z.strictObject({ ...organisation, memberIdOrEmail: z.string().min(1).max(254) }),
	),
	"/organization/leave": member("body", z.strictObject(organisation)),
};

const gate = createAuthMiddleware(async (ctx) => {
	const endpoint = ENDPOINTS[ctx.path];
	if (!endpoint) throw new APIError("NOT_FOUND");

	const signedIn = await getSessionFromCtx(ctx);
	if (!signedIn) throw new APIError("UNAUTHORIZED");

	const input = await endpoint.admit(ctx[endpoint.from], {
		user: signedIn.user,
		adapter: ctx.context.adapter,
	});
	if (endpoint.from === "body") return { context: { body: input } };
});

const organisationRules: BetterAuthPlugin = {
	id: "organisation-rules",
	hooks: {
		before: [{ matcher: (ctx) => ctx.path?.startsWith("/organization/") ?? false, handler: gate }],
	},
};

/** The plugins that give the application its organisations. Spread into Better Auth's `plugins`. */
export function organisationPlugins() {
	return [
		organization({
			// Our tables say "organisation"; the plugin's fields say "organization".
			schema: {
				session: { fields: { activeOrganizationId: "activeOrganisationId" } },
				member: { fields: { organizationId: "organisationId" } },
				invitation: { fields: { organizationId: "organisationId" } },
			},
			ac: accessControl,
			roles,
			// The role whose holders the plugin protects: only an owner makes or
			// changes an owner, and the last one cannot leave, be removed or be demoted.
			creatorRole: "owner",
			allowUserToCreateOrganization: (user) => user.emailVerified,
			invitationExpiresIn: INVITATION_LIFETIME_SECONDS,
			// An invitation is for the person who has proved the address it was sent to.
			requireEmailVerificationOnInvitation: true,
			async sendInvitationEmail({ id, email, role, organization, inviter }, request) {
				// `handleAuthRequest` lets through only requests to our own hosts.
				if (!request || !isOurHost(request)) {
					throw new Error("An invitation's link needs the request the invitation was made in.");
				}
				const message = invitationEmail({
					link: `${new URL(request.url).origin}/invitations/${id}`,
					organisationName: organization.name,
					inviterEmail: inviter.user.email,
					role: InvitedRole.parse(role),
				});
				// Not awaited: how long the mail takes must not show in the response.
				waitUntil(sendEmail({ to: email, ...message }));
			},
		}),
		organisationRules,
	];
}
