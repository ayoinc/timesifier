/**
 * Whose organisation a request is for, and what the person asking may do there.
 *
 * The organisation always comes from the request: a page under
 * `/app/<slug>/…` passes its slug here, and membership is read from the
 * database every time (docs/decisions.md entry 20).
 */
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createContext, data } from "react-router";
import type { SignedIn } from "~/auth/auth.server";
import { configuredProviders } from "~/auth/providers";
import { keepsBillingColumn, organisationScope, organisations } from "~/db";
import type { Viewer } from "~/shell/destinations";
import { managedPlaces } from "~/teams/teams.server";
import { hasClients, WorkModel } from "~/workspace/work-model";
import { Role } from "./roles";
import { admits, type CompanySignInNeeded, policyOf, type SignInPolicy } from "./sign-in-policy";

/** A signed-in person, an organisation they belong to, and their role in it. */
export type Membership = {
	organisation: {
		id: string;
		name: string;
		slug: string;
		/** The zone of a member who has not set their own (TS-048). */
		timeZone: string;
		/** The day its timesheet periods start on: 1 is Monday, 7 is Sunday. */
		weekStartsOn: number;
		/** How it works (TS-115a): client projects, internal work or both. */
		workModel: WorkModel;
		/** What it calls internal work, in the plural ("Work codes"). */
		internalTerm: string;
		/** Whether its Invoices and Estimates are there: it has clients, or holds one (TS-115a). */
		keepsBilling: boolean;
		/** When its logo was uploaded, for the logo's address in the band; null for no logo (TS-100). */
		logoVersion: number | null;
		/** Who may open its pages (TS-104): anyone signed in, or company sign-in. */
		signIn: SignInPolicy;
	};
	role: Role;
	/** Whether the person manages at least one of the organisation's teams (TS-038). */
	managesTeams: boolean;
	/**
	 * Whether the person has a stretch as delivery manager of a project, now
	 * or before (TS-115c): they approve its time on Approvals (TS-117).
	 */
	leadsProjects: boolean;
	user: SignedIn["user"];
};

/**
 * The membership of `user` in the organisation at `slug`, or `null`.
 *
 * `null` means only "not for you": no organisation has that slug, or one has
 * and the person is not a member of it. The same three queries run either way,
 * so neither the answer nor the work done says whether the organisation
 * exists: the organisation, the person's membership of it, and the places in
 * the teams they manage, which the request keeps for `accessOf`
 * (`managedPlaces`).
 *
 * It is not exported. It reads membership and nothing else: the organisation's
 * sign-in policy is applied by `requireMembershipOf`, the only way in, so no
 * caller can be handed a membership the policy would refuse (security review,
 * LOW c).
 */
async function membershipOf(user: SignedIn["user"], slug: string): Promise<Membership | null> {
	const [organisation] = await drizzle(env.DB)
		.select({
			id: organisations.id,
			name: organisations.name,
			slug: organisations.slug,
			timeZone: organisations.timeZone,
			weekStartsOn: organisations.weekStartsOn,
			workModel: organisations.workModel,
			internalTerm: organisations.internalTerm,
			keepsBilling: keepsBillingColumn,
			logoVersion: organisations.brandLogoVersion,
			signInPolicy: organisations.signInPolicy,
			signInProvider: organisations.signInProvider,
			signInTenant: organisations.signInTenant,
		})
		.from(organisations)
		.where(eq(organisations.slug, slug))
		.limit(1);
	// No organisation has an empty id, so an unknown slug is looked up as a
	// membership that cannot exist.
	const scope = organisationScope(env.DB, organisation?.id ?? "");
	const [[membership], managed, leading] = await Promise.all([
		scope.memberships.select((m) => eq(m.userId, user.id)),
		managedPlaces(scope, user.id),
		scope.projectMembers.select((m) => and(eq(m.userId, user.id), eq(m.role, "delivery_manager")), {
			limit: 1,
		}),
	]);

	// A role this application does not know grants nothing.
	const role = Role.safeParse(membership?.role);
	if (!organisation || !role.success) return null;
	const { signInPolicy, signInProvider, signInTenant, workModel, keepsBilling, ...rest } =
		organisation;
	return {
		organisation: {
			...rest,
			workModel: WorkModel.parse(workModel),
			keepsBilling: Boolean(keepsBilling),
			signIn: policyOf({ signInPolicy, signInProvider, signInTenant }),
		},
		role: role.data,
		managesTeams: managed.length > 0,
		leadsProjects: leading.length > 0,
		user,
	};
}

/** What decides the destinations a member is shown (`app/shell/destinations.ts`). */
export function viewerOf({ role, managesTeams, leadsProjects, organisation }: Membership): Viewer {
	return {
		role,
		managesTeams,
		leadsProjects,
		clientsEnabled: hasClients(organisation.workModel),
		keepsBilling: organisation.keepsBilling,
	};
}

/**
 * The membership every loader and action under `/app/<slug>/` acts on. The
 * organisation layout's middleware sets it before any of them runs, from the
 * slug in the address and the database (`requireMembershipOf`). It has no
 * default: reading it on a route that layout does not cover fails loudly.
 */
export const membershipContext = createContext<Membership>();

/**
 * The membership of the person and session a guard read from the request, for
 * the organisation layout, which stands behind the session guard. Where there
 * is none it throws React Router's 404, which is identical for an organisation
 * that does not exist and for one the person does not belong to. Then the
 * organisation's sign-in policy (TS-104 slice 104b): a member whose session it
 * does not take, owners apart, gets `companySignInNeeded`. Membership is
 * decided first, so the policy, and the organisation's name with it, is told
 * to its members alone.
 */
export async function requireMembershipOf(
	{ user, session }: SignedIn,
	slug: string,
): Promise<Membership> {
	const membership = await membershipOf(user, slug);
	if (!membership) throw notFound();
	if (!admits(membership.organisation.signIn, membership.role, session)) {
		throw companySignInNeeded(membership.organisation.name, membership.organisation.signIn);
	}
	return membership;
}

/**
 * The answer to a member whose session the organisation's policy does not
 * take: 403, with what the organisation layout's error page needs to say
 * "Acme asks you to sign in with Microsoft" and show the one button.
 */
export function companySignInNeeded(organisation: string, policy: SignInPolicy) {
	if (policy.kind === "any")
		throw new Error("An organisation that requires nothing turned a member away");
	return data<CompanySignInNeeded>(
		{
			companySignIn:
				policy.kind === "locked"
					? { organisation, provider: null, tenant: null, offered: false }
					: {
							organisation,
							provider: policy.provider,
							tenant: policy.tenant,
							offered: configuredProviders(env).includes(policy.provider),
						},
		},
		{ status: 403 },
	);
}

/**
 * The one answer to anybody who asks for an organisation that is not theirs or
 * not there. A page that finds, part of the way through, that the person is no
 * longer a member throws it too.
 */
export function notFound() {
	return data("Not Found", { status: 404 });
}
