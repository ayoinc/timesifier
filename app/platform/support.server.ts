import { env } from "cloudflare:workers";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { record } from "~/activity/activity.server";
import { type OrganisationScope, organisationScope, platformData, users } from "~/db";
import { nameOrEmail } from "~/organisations/people";

// Support access (TS-099, docs/security.md, "The platform console"). An
// organisation's owner grants the platform's owners leave to read the
// organisation's own data for 24 or 72 hours; they may revoke it at any time.
// While it lasts, a platform owner who has stepped up reads, through
// `organisationScope` like any page of the organisation, and changes nothing:
// the support view has a loader and no action. Granting, revoking and every
// opening of the view are recorded in the organisation's activity log and in
// the platform's.

/** The lengths an owner chooses from, in hours. */
export const SUPPORT_HOURS = [24, 72] as const;
export type SupportHours = (typeof SUPPORT_HOURS)[number];

const HOUR = 3_600_000;

/** The grant in force at `now`, if any. */
export async function activeGrant(scope: OrganisationScope, now: Date) {
	const [grant] = await scope.supportGrants.select(
		(g) => and(isNull(g.revokedAt), gt(g.expiresAt, now)),
		{ orderBy: (g) => [desc(g.expiresAt)], limit: 1 },
	);
	return grant ?? null;
}

/** Every grant, newest first, with who granted and revoked each. */
export async function grantHistory(scope: OrganisationScope) {
	const grants = await scope.supportGrants.select(undefined, {
		orderBy: (g) => [desc(g.createdAt)],
		limit: 20,
	});
	const people = [
		...new Set(grants.flatMap((g) => [g.grantedBy, g.revokedBy].filter((id) => id !== null))),
	];
	const named =
		people.length === 0
			? []
			: await drizzle(env.DB)
					.select({ id: users.id, name: users.name, email: users.email })
					.from(users)
					.where(inArray(users.id, people));
	const nameOf = new Map(named.map((person) => [person.id, nameOrEmail(person)]));
	return grants.map((g) => ({
		id: g.id,
		createdAt: g.createdAt,
		expiresAt: g.expiresAt,
		revokedAt: g.revokedAt,
		grantedBy: nameOf.get(g.grantedBy) ?? "A former member",
		revokedBy: g.revokedBy ? (nameOf.get(g.revokedBy) ?? "A former member") : null,
	}));
}

/**
 * Grants support access for `hours` from `now`, ending any grant in force so
 * that one is in force at a time. Recorded in both logs.
 */
export async function grantSupport(
	scope: OrganisationScope,
	actorId: string,
	hours: SupportHours,
	now: Date,
) {
	const current = await activeGrant(scope, now);
	if (current) {
		await scope.supportGrants.update({ revokedAt: now, revokedBy: actorId, updatedAt: now }, (g) =>
			eq(g.id, current.id),
		);
	}
	const [grant] = await scope.supportGrants.insert({
		grantedBy: actorId,
		expiresAt: new Date(now.getTime() + hours * HOUR),
	});
	if (!grant) throw new Error("The grant was not stored");
	await Promise.all([
		record(
			scope,
			actorId,
			"support_access.granted",
			{ type: "support_access", id: grant.id },
			{
				after: { hours },
			},
		),
		platformData.recordPlatformEvent(env.DB, {
			actorId,
			action: "support_access.granted",
			subjectType: "organisation",
			subjectId: scope.organisationId,
			detail: { hours, grant: grant.id },
		}),
	]);
	return grant;
}

/** Ends the grant in force. Answers whether there was one. Recorded in both logs. */
export async function revokeSupport(scope: OrganisationScope, actorId: string, now: Date) {
	const current = await activeGrant(scope, now);
	if (!current) return false;
	await scope.supportGrants.update({ revokedAt: now, revokedBy: actorId, updatedAt: now }, (g) =>
		eq(g.id, current.id),
	);
	await Promise.all([
		record(scope, actorId, "support_access.revoked", { type: "support_access", id: current.id }),
		platformData.recordPlatformEvent(env.DB, {
			actorId,
			action: "support_access.revoked",
			subjectType: "organisation",
			subjectId: scope.organisationId,
			detail: { grant: current.id },
		}),
	]);
	return true;
}

/** The grant in force for one organisation, read for the console. */
export function grantInForce(organisationId: string, now: Date) {
	return activeGrant(organisationScope(env.DB, organisationId), now);
}

/** The most rows of each kind the support view shows. */
const SUPPORT_ROWS = 50;

/**
 * What a platform owner reads under support access: the organisation's
 * people, projects, latest time entries and invoices. Null where no grant is
 * in force, which the route answers with a 404. Every reading is recorded in
 * both logs.
 */
export async function supportView(organisationId: string, actorId: string, now: Date) {
	const scope = organisationScope(env.DB, organisationId);
	const grant = await activeGrant(scope, now);
	if (!grant) return null;
	await Promise.all([
		record(scope, actorId, "support_access.used", { type: "support_access", id: grant.id }),
		platformData.recordPlatformEvent(env.DB, {
			actorId,
			action: "support_access.used",
			subjectType: "organisation",
			subjectId: organisationId,
			detail: { grant: grant.id },
		}),
	]);
	const [members, projects, clients, entries, invoices] = await Promise.all([
		scope.memberships.select(undefined, { limit: 500 }),
		scope.projects.select(undefined, { orderBy: (p) => [p.name], limit: SUPPORT_ROWS }),
		scope.clients.select(undefined, { limit: 500 }),
		scope.timeEntries.select(undefined, {
			orderBy: (e) => [desc(e.startedAt)],
			limit: SUPPORT_ROWS,
		}),
		scope.invoices.select(undefined, {
			orderBy: (i) => [desc(i.createdAt)],
			limit: SUPPORT_ROWS,
		}),
	]);
	const people = members.map((m) => m.userId);
	const named =
		people.length === 0
			? []
			: await drizzle(env.DB)
					.select({ id: users.id, name: users.name, email: users.email })
					.from(users)
					.where(inArray(users.id, people));
	const personOf = new Map(named.map((person) => [person.id, person]));
	const nameOf = (id: string) => {
		const person = personOf.get(id);
		return person ? nameOrEmail(person) : "A former member";
	};
	const projectOf = new Map(projects.map((p) => [p.id, p.name]));
	const clientOf = new Map(clients.map((c) => [c.id, c.name]));
	return {
		expiresAt: grant.expiresAt,
		members: members.map((m) => ({
			id: m.id,
			name: nameOf(m.userId),
			email: personOf.get(m.userId)?.email ?? "",
			role: m.role,
		})),
		projects: projects.map((p) => ({
			id: p.id,
			name: p.name,
			client: p.clientId ? (clientOf.get(p.clientId) ?? null) : null,
			archived: p.archivedAt !== null,
		})),
		entries: entries.map((e) => ({
			id: e.id,
			person: nameOf(e.userId),
			project: projectOf.get(e.projectId) ?? "Another project",
			startedAt: e.startedAt,
			minutes: e.endedAt
				? Math.round((e.endedAt.getTime() - e.startedAt.getTime()) / 60_000)
				: null,
			description: e.description,
		})),
		invoices: invoices.map((i) => ({
			id: i.id,
			number: i.number,
			client: clientOf.get(i.clientId) ?? "A client",
			status: i.status,
			totalMinor: i.totalMinor,
			currency: i.currency,
		})),
	};
}
