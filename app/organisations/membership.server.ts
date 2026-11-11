/**
 * Whose organisation a request is for, and what the person asking may do there.
 *
 * The organisation always comes from the request: a page under
 * `/app/<slug>/…` passes its slug here, and membership is read from the
 * database every time (docs/decisions.md entry 20).
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createContext, data } from "react-router";
import { getSession, type SignedIn } from "~/auth/auth.server";
import { organisationScope, organisations } from "~/db";
import { Role } from "./roles";

/** A signed-in person, an organisation they belong to, and their role in it. */
export type Membership = {
	organisation: { id: string; name: string; slug: string };
	role: Role;
	user: SignedIn["user"];
};

/**
 * The membership of the person behind `request` in the organisation at `slug`,
 * or `null`.
 *
 * `null` means only "not for you". It is the answer when nobody is signed in,
 * when no organisation has that slug, and when one has and the person is not a
 * member of it. For a signed-in person the last two also run the same two
 * queries, so neither the answer nor the work done says whether the
 * organisation exists.
 */
export async function findMembership(request: Request, slug: string): Promise<Membership | null> {
	const signedIn = await getSession(request);
	return signedIn ? membershipOf(signedIn.user, slug) : null;
}

/**
 * The same, for a person a guard has already read from the request: the
 * membership of `user` in the organisation at `slug`, or `null`. The same two
 * queries run whether or not the organisation exists.
 */
export async function membershipOf(
	user: SignedIn["user"],
	slug: string,
): Promise<Membership | null> {
	const [organisation] = await drizzle(env.DB)
		.select({ id: organisations.id, name: organisations.name, slug: organisations.slug })
		.from(organisations)
		.where(eq(organisations.slug, slug))
		.limit(1);
	// No organisation has an empty id, so an unknown slug is looked up as a
	// membership that cannot exist.
	const [membership] = await organisationScope(env.DB, organisation?.id ?? "").memberships.select(
		(m) => eq(m.userId, user.id),
	);

	// A role this application does not know grants nothing.
	const role = Role.safeParse(membership?.role);
	if (!organisation || !role.success) return null;
	return { organisation, role: role.data, user };
}

/**
 * The same as `findMembership`, for a loader, an action or a middleware: where
 * that returns `null`, this throws React Router's 404, which is identical for
 * an organisation that does not exist and for one the person does not belong to.
 */
export async function requireMembership(request: Request, slug: string): Promise<Membership> {
	const membership = await findMembership(request, slug);
	if (!membership) throw notFound();
	return membership;
}

/**
 * The membership every loader and action under `/app/<slug>/` acts on. The
 * organisation layout's middleware sets it before any of them runs, from the
 * slug in the address and the database (`requireMembershipOf`). It has no
 * default: reading it on a route that layout does not cover fails loudly.
 */
export const membershipContext = createContext<Membership>();

/**
 * `requireMembership` for the organisation layout, which stands behind the
 * session guard and is handed the person the guard read. It throws the same 404.
 */
export async function requireMembershipOf(
	user: SignedIn["user"],
	slug: string,
): Promise<Membership> {
	const membership = await membershipOf(user, slug);
	if (!membership) throw notFound();
	return membership;
}

/**
 * The one answer to anybody who asks for an organisation that is not theirs or
 * not there. A page that finds, part of the way through, that the person is no
 * longer a member throws it too.
 */
export function notFound() {
	return data("Not Found", { status: 404 });
}
