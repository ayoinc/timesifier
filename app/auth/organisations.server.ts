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
 *   person asking to take, one whose sender may no longer invite included;
 * - lets a person own at most five organisations;
 * - derives a new organisation's slug from its name.
 *
 * Beside the gate, one hook lets a person send at most twenty invitations in
 * any 24 hours.
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
import { deleteOrganisationLogos } from "~/brand/organisation-brand.server";
import { getPlatformBrand } from "~/brand/platform-brand.server";
import { organisationScope, organisations } from "~/db";
import { deleteOrganisationReceipts } from "~/expenses/receipts.server";
import { LOGOS_NOT_DELETED, RECEIPTS_NOT_DELETED } from "~/organisations/problems";
import { accessControl, InvitedRole, Role, roles } from "~/organisations/roles";
import { availableSlug, slugFromName, slugSearchPrefix } from "~/organisations/slug";
import { SEATS_FULL } from "~/plans/plans";
import { seatForOneMore } from "~/plans/plans.server";
import { sendEmail } from "./email.server";
import { isOurHost } from "./hosts";
import { valid } from "./input.server";
import { INVITATION_LIFETIME_SECONDS, invitationEmail } from "./invitation-email";
import { type Cap, takeOne } from "./quota.server";

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

// Two caps that are not about one client in one minute. Without them one
// account could create organisations without end, each named with a sentence
// of its choosing, and have the application's own address send that sentence
// to strangers ten times a minute.
/** Invitations one person may send in any 24 hours, across every organisation. */
const INVITATIONS_PER_SENDER: Cap = { max: 20, seconds: 24 * 60 * 60 };
/** Organisations one person may own. Creating one makes its creator its owner. */
const ORGANISATIONS_PER_OWNER = 5;

/**
 * Where Better Auth's own ceilings are set, so that they never decide. Unless
 * told otherwise its organization plugin holds an organisation to 100 members
 * and 100 pending invitations, and every list Better Auth reads stops at 100
 * rows. How many people an organisation holds is the application's to say:
 * the seats on its plan (TS-099), checked in `beforeCreateInvitation`. This is
 * far above any number of seats a plan may hold (TS-112).
 */
export const LIBRARY_CEILING = 1_000_000;

// The plugin's own codes and wording, so a page reads one vocabulary. The
// plugin sends them with status 400, and something else to a person who is
// not a member or not the recipient.
const organisationNotFound = () =>
	new APIError("NOT_FOUND", { code: "ORGANIZATION_NOT_FOUND", message: "Organization not found" });
const invitationNotFound = () =>
	new APIError("NOT_FOUND", { code: "INVITATION_NOT_FOUND", message: "Invitation not found" });

/**
 * Deletes the organisation's receipts in R2 before its row, which no foreign
 * key reaches. Should one delete fail, the organisation is not deleted and says
 * so, and asking again deletes what is left (docs/security.md, "Receipts").
 */
async function deleteReceiptsFirst(organisationId: string): Promise<void> {
	try {
		await deleteOrganisationReceipts(organisationId);
	} catch (error) {
		console.error(
			`organisation: receipts not deleted, ${error instanceof Error ? error.name : "unknown"}`,
		);
		throw new APIError("SERVICE_UNAVAILABLE", {
			code: RECEIPTS_NOT_DELETED,
			message: "The organisation's receipts could not all be deleted. Try again.",
		});
	}
}

/**
 * Deletes the organisation's logos in R2 before its row, which no foreign key
 * reaches. Should a delete fail, the organisation is not deleted and says so,
 * and asking again deletes what is left (docs/security.md, "Organisation logos").
 */
async function deleteLogosFirst(organisationId: string): Promise<void> {
	try {
		await deleteOrganisationLogos(organisationId);
	} catch (error) {
		console.error(
			`organisation: logos not deleted, ${error instanceof Error ? error.name : "unknown"}`,
		);
		throw new APIError("SERVICE_UNAVAILABLE", {
			code: LOGOS_NOT_DELETED,
			message: "The organisation's logo could not be deleted. Try again.",
		});
	}
}

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
 * Shown in pages and quoted in an invitation's message, so it holds no line
 * break, no other control character and none that reverses the direction of
 * text.
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
	adapter: Pick<DBAdapter, "findOne" | "count">;
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
type StoredInvitation = {
	email: string;
	status: string;
	expiresAt: Date;
	organizationId: string;
	inviterId: string;
};

/**
 * An endpoint for the person an invitation was sent to. There is one answer
 * for an invitation that does not exist, one that has been accepted, declined
 * or cancelled, one that has expired, and one that was sent to somebody else,
 * so an invitation's id tells nobody but its recipient anything.
 *
 * `standing` adds one more to that list: an invitation whose sender may no
 * longer invite. An invitation stands on its sender's right to send it.
 * Otherwise an admin about to be removed could invite an address of their own
 * and come back with it. Declining needs no such thing.
 */
function recipient(
	from: Endpoint["from"],
	schema: z.ZodType<{ invitationId: string } | { id: string }>,
	needs: "standing" | "pending",
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
			if (!invitation || !theirs) throw invitationNotFound();

			if (needs === "standing") {
				const [sender] = await organisationScope(
					env.DB,
					invitation.organizationId,
				).memberships.select((m) => eq(m.userId, invitation.inviterId));
				// The sender's role today, asked the question the plugin asks of
				// whoever invites: a role this application does not know grants nothing.
				const role = Role.safeParse(sender?.role);
				const mayInvite =
					role.success && roles[role.data].authorize({ invitation: ["create"] }).success;
				if (!mayInvite) throw invitationNotFound();
			}
			return input;
		},
	};
}

/** Every endpoint of the plugin that can be called, and exactly what each accepts. */
const ENDPOINTS: Record<string, Endpoint> = {
	"/organization/create": {
		from: "body",
		async admit(raw, { user, adapter }) {
			// A name and nothing else. The slug is ours to choose.
			const { name } = await valid(z.strictObject({ name: Name }), raw);
			// The plugin's own limit counts every organisation a person belongs
			// to, so five invitations accepted would stop a person creating their
			// first. This counts the ones they own, which creating adds to.
			const owned = await adapter.count({
				model: "member",
				where: [
					{ field: "userId", value: user.id },
					{ field: "role", value: "owner" },
				],
			});
			if (owned >= ORGANISATIONS_PER_OWNER) {
				throw new APIError("FORBIDDEN", {
					code: "YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS",
					message: "You have reached the maximum number of organizations",
				});
			}
			return { name, slug: await slugFor(name) };
		},
	},
	"/organization/list": anyone("query", nothing),

	"/organization/get-invitation": recipient("query", z.strictObject({ id: Id }), "standing"),
	"/organization/accept-invitation": recipient(
		"body",
		z.strictObject({ invitationId: Id }),
		"standing",
	),
	"/organization/reject-invitation": recipient(
		"body",
		z.strictObject({ invitationId: Id }),
		"pending",
	),

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
			// The seats decide, not the plugin (`LIBRARY_CEILING`). A number, not a
			// function: the plugin applies only a number to its lists of members.
			membershipLimit: LIBRARY_CEILING,
			invitationLimit: LIBRARY_CEILING,
			// Teams are not enabled, and their two ceilings are unset, which the
			// plugin reads as none. The plugin's `organizationLimit` is unset too:
			// the gate's five organisations owned stands in its place.
			organizationHooks: {
				// The last thing before an invitation is stored and its message sent,
				// after every check of the plugin's own, so only an invitation that
				// is really made uses up one of the day's twenty. The count is kept
				// apart from the invitations themselves: cancelling one, or deleting
				// the organisation, gives nothing back.
				async beforeCreateInvitation({ inviter, organization }) {
					// The plan's seats come first (TS-099): a refusal there uses up nothing.
					if (!(await seatForOneMore(organization.id, new Date()))) {
						throw new APIError("FORBIDDEN", { code: "SEATS_FULL", message: SEATS_FULL });
					}
					if (!(await takeOne(env.DB, `invitations:${inviter.id}`, INVITATIONS_PER_SENDER))) {
						throw new APIError("TOO_MANY_REQUESTS", {
							code: "TOO_MANY_INVITATIONS",
							message: `You have sent ${INVITATIONS_PER_SENDER.max} invitations in the last 24 hours. Try again later.`,
						});
					}
				},
				// The plugin deletes an organisation's memberships first and its row
				// last, and the database refuses to take the last owner from an
				// organisation that is still there (migrations/0004). So the row goes
				// first, here, in one statement, and every table of the organisation
				// goes with it through its foreign keys. The plugin's own three
				// deletes then find nothing left.
				//
				// Its receipts and its logos in R2 go before the row: no foreign key
				// reaches them.
				async beforeDeleteOrganization({ organization }) {
					await deleteReceiptsFirst(organization.id);
					await deleteLogosFirst(organization.id);
					await drizzle(env.DB).delete(organisations).where(eq(organisations.id, organization.id));
				},
			},
			async sendInvitationEmail({ id, email, role, organization, inviter }, request) {
				// `handleAuthRequest` lets through only requests to our own hosts.
				if (!request || !isOurHost(request, env)) {
					throw new Error("An invitation's link needs the request the invitation was made in.");
				}
				const message = invitationEmail(
					{
						link: `${new URL(request.url).origin}/invitations/${id}`,
						organisationName: organization.name,
						inviterEmail: inviter.user.email,
						role: InvitedRole.parse(role),
					},
					await getPlatformBrand(env),
				);
				// Not awaited: how long the mail takes must not show in the response.
				waitUntil(sendEmail({ to: email, ...message }));
			},
		}),
		organisationRules,
	];
}
