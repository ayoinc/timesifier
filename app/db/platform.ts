import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	like,
	lt,
	max,
	or,
	sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
	invitations,
	invoices,
	mailingDeliveries,
	mailings,
	memberships,
	organisations,
	platformEvents,
	platformStepUps,
	projects,
	sessions,
	signIns,
	timeEntries,
	users,
} from "./schema";

// The platform console's reads and writes across organisations (TS-099).
// They read metadata only: who has an account, which organisations exist, on
// which plan, how many people and how much use, and when last active. They
// never read what an organisation keeps (an entry's description, an
// invoice's lines, pay, leave): a count of rows is the most any of them takes
// from an organisation's own tables. `test/platform/metadata.test.ts` watches
// every statement the console sends and fails on any other column.
//
// What an organisation's owner lets a platform owner read under support
// access is read through `organisationScope` instead, in
// `app/platform/support.server.ts`.

const DAY = 86_400_000;

/** The address a deleted account is left with: it identifies nobody and receives no mail. */
export const DELETED_EMAIL_DOMAIN = "deleted.invalid";
export const DELETED_NAME = "Deleted person";

// ---------------------------------------------------------------------------
// Health

export interface PlatformHealth {
	accounts: number;
	signUps7: number;
	signUps30: number;
	/** Sign-ups in each of the last eight weeks, oldest first, by the week's first day. */
	weekly: { from: Date; count: number }[];
	/** People with a session used in the last 7 and 30 days. */
	active7: number;
	active30: number;
	/** Of the people who signed up 28 to 56 days ago, how many used a session in the last 7 days. */
	retention: { cohort: number; retained: number };
	organisations: number;
}

export async function platformHealth(database: D1Database, now: Date): Promise<PlatformHealth> {
	const db = drizzle(database);
	const at = (days: number) => new Date(now.getTime() - days * DAY);
	const open = isNull(users.closedAt);
	const activeSince = (since: Date) =>
		db
			.select({ n: sql<number>`count(distinct ${sessions.userId})` })
			.from(sessions)
			.where(gte(sessions.updatedAt, since));
	const [[accounts], [week], [month], weeks, [active7], [active30], [cohort], [retained], [orgs]] =
		await Promise.all([
			db.select({ n: count() }).from(users).where(open),
			db
				.select({ n: count() })
				.from(users)
				.where(gte(users.createdAt, at(7))),
			db
				.select({ n: count() })
				.from(users)
				.where(gte(users.createdAt, at(30))),
			db
				.select({
					week: sql<number>`cast((${now.getTime()} - ${users.createdAt}) / ${7 * DAY} as integer)`,
					n: count(),
				})
				.from(users)
				.where(gte(users.createdAt, at(56)))
				.groupBy(sql`1`),
			activeSince(at(7)),
			activeSince(at(30)),
			db
				.select({ n: count() })
				.from(users)
				.where(and(gte(users.createdAt, at(56)), lt(users.createdAt, at(28)))),
			db
				.select({ n: sql<number>`count(distinct ${sessions.userId})` })
				.from(sessions)
				.innerJoin(users, eq(users.id, sessions.userId))
				.where(
					and(
						gte(users.createdAt, at(56)),
						lt(users.createdAt, at(28)),
						gte(sessions.updatedAt, at(7)),
					),
				),
			db.select({ n: count() }).from(organisations),
		]);
	const byWeek = new Map(weeks.map(({ week, n }) => [Number(week), n]));
	return {
		accounts: accounts?.n ?? 0,
		signUps7: week?.n ?? 0,
		signUps30: month?.n ?? 0,
		weekly: Array.from({ length: 8 }, (_, index) => {
			const ago = 7 - index;
			return { from: at(ago * 7 + 7), count: byWeek.get(ago) ?? 0 };
		}),
		active7: active7?.n ?? 0,
		active30: active30?.n ?? 0,
		retention: { cohort: cohort?.n ?? 0, retained: retained?.n ?? 0 },
		organisations: orgs?.n ?? 0,
	};
}

// ---------------------------------------------------------------------------
// Organisations

export interface PlatformOrganisation {
	id: string;
	name: string;
	slug: string;
	plan: string;
	seats: number | null;
	trialEndsAt: Date | null;
	createdAt: Date;
	members: number;
	pendingInvitations: number;
	/** The last time any member used a session; null when none has one. */
	lastActiveAt: Date | null;
	entries: number;
	projects: number;
	invoices: number;
}

/** The count of rows of an organisation's table, by organisation: its ids and nothing else. */
function countsBy(
	database: D1Database,
	table: typeof timeEntries | typeof projects | typeof invoices,
	ids: string[],
) {
	return drizzle(database)
		.select({ organisationId: table.organisationId, n: count() })
		.from(table)
		.where(inArray(table.organisationId, ids))
		.groupBy(table.organisationId);
}

/**
 * Every organisation, or those whose name or address contains `query`, newest
 * first, with its plan, people, use and last activity.
 */
export async function platformOrganisations(
	database: D1Database,
	{ query, ids, limit = 200 }: { query?: string; ids?: string[]; limit?: number } = {},
): Promise<PlatformOrganisation[]> {
	const db = drizzle(database);
	const pattern = query ? `%${query.replace(/[%_]/g, "")}%` : null;
	const rows = await db
		.select({
			id: organisations.id,
			name: organisations.name,
			slug: organisations.slug,
			plan: organisations.plan,
			seats: organisations.seats,
			trialEndsAt: organisations.trialEndsAt,
			createdAt: organisations.createdAt,
		})
		.from(organisations)
		.where(
			and(
				pattern
					? or(like(organisations.name, pattern), like(organisations.slug, pattern))
					: undefined,
				ids ? inArray(organisations.id, ids) : undefined,
			),
		)
		.orderBy(desc(organisations.createdAt))
		.limit(limit);
	if (rows.length === 0) return [];
	const organisationIds = rows.map(({ id }) => id);
	const [members, pending, active, entries, projectCounts, invoiceCounts] = await Promise.all([
		db
			.select({ organisationId: memberships.organisationId, n: count() })
			.from(memberships)
			.where(inArray(memberships.organisationId, organisationIds))
			.groupBy(memberships.organisationId),
		db
			.select({ organisationId: invitations.organisationId, n: count() })
			.from(invitations)
			.where(
				and(
					inArray(invitations.organisationId, organisationIds),
					eq(invitations.status, "pending"),
				),
			)
			.groupBy(invitations.organisationId),
		db
			.select({ organisationId: memberships.organisationId, at: max(sessions.updatedAt) })
			.from(memberships)
			.innerJoin(sessions, eq(sessions.userId, memberships.userId))
			.where(inArray(memberships.organisationId, organisationIds))
			.groupBy(memberships.organisationId),
		countsBy(database, timeEntries, organisationIds),
		countsBy(database, projects, organisationIds),
		countsBy(database, invoices, organisationIds),
	]);
	const counted = (list: { organisationId: string; n: number }[]) =>
		new Map(list.map(({ organisationId, n }) => [organisationId, n]));
	const [m, p, e, pr, iv] = [members, pending, entries, projectCounts, invoiceCounts].map(counted);
	const lastActive = new Map(active.map(({ organisationId, at }) => [organisationId, at]));
	return rows.map((row) => ({
		...row,
		members: m?.get(row.id) ?? 0,
		pendingInvitations: p?.get(row.id) ?? 0,
		lastActiveAt: lastActive.get(row.id) ?? null,
		entries: e?.get(row.id) ?? 0,
		projects: pr?.get(row.id) ?? 0,
		invoices: iv?.get(row.id) ?? 0,
	}));
}

/** The owners of an organisation: who to talk to about it. */
export function organisationOwners(database: D1Database, organisationId: string) {
	return drizzle(database)
		.select({ id: users.id, name: users.name, email: users.email })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.where(and(eq(memberships.organisationId, organisationId), eq(memberships.role, "owner")))
		.orderBy(asc(users.name));
}

/** The plan columns of one organisation, as the console sets them. */
export async function setOrganisationPlan(
	database: D1Database,
	organisationId: string,
	plan: { plan: string; seats: number | null; trialEndsAt: Date | null },
): Promise<boolean> {
	const changed = await drizzle(database)
		.update(organisations)
		.set({ ...plan, updatedAt: new Date() })
		.where(eq(organisations.id, organisationId))
		.returning({ id: organisations.id });
	return changed.length > 0;
}

/** Seats used: members and pending invitations, which each hold one. */
export async function seatsUsed(database: D1Database, organisationId: string): Promise<number> {
	const db = drizzle(database);
	const [[members], [pending]] = await Promise.all([
		db
			.select({ n: count() })
			.from(memberships)
			.where(eq(memberships.organisationId, organisationId)),
		db
			.select({ n: count() })
			.from(invitations)
			.where(
				and(eq(invitations.organisationId, organisationId), eq(invitations.status, "pending")),
			),
	]);
	return (members?.n ?? 0) + (pending?.n ?? 0);
}

/** The organisation's plan columns. */
export async function organisationPlan(database: D1Database, organisationId: string) {
	const [row] = await drizzle(database)
		.select({
			plan: organisations.plan,
			seats: organisations.seats,
			trialEndsAt: organisations.trialEndsAt,
		})
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	return row ?? null;
}

// ---------------------------------------------------------------------------
// Accounts

export interface PlatformAccountRow {
	id: string;
	name: string;
	email: string;
	createdAt: Date;
	closedAt: Date | null;
}

const ACCOUNT_COLUMNS = {
	id: users.id,
	name: users.name,
	email: users.email,
	createdAt: users.createdAt,
	closedAt: users.closedAt,
};

/** Accounts whose address or name contains `query`, newest first; the newest when there is none. */
export function platformAccounts(database: D1Database, query: string, limit = 50) {
	const pattern = `%${query.replace(/[%_]/g, "")}%`;
	return drizzle(database)
		.select(ACCOUNT_COLUMNS)
		.from(users)
		.where(query ? or(like(users.email, pattern), like(users.name, pattern)) : undefined)
		.orderBy(desc(users.createdAt))
		.limit(limit);
}

export interface PlatformAccount extends PlatformAccountRow {
	newsletter: boolean;
	announcements: boolean;
	organisations: { id: string; name: string; slug: string; role: string }[];
	signIns: { id: string; device: string; createdAt: Date }[];
	sessions: number;
	invitations: {
		id: string;
		organisationId: string;
		organisation: string;
		role: string;
		expiresAt: Date;
	}[];
}

/** One account: who, their organisations and roles, recent sign-ins, live sessions and waiting invitations. */
export async function platformAccount(
	database: D1Database,
	id: string,
	now: Date,
): Promise<PlatformAccount | null> {
	const db = drizzle(database);
	const [user] = await db
		.select({
			...ACCOUNT_COLUMNS,
			newsletter: users.newsletter,
			announcements: users.announcements,
		})
		.from(users)
		.where(eq(users.id, id))
		.limit(1);
	if (!user) return null;
	const [memberOf, history, [live], waiting] = await Promise.all([
		db
			.select({
				id: organisations.id,
				name: organisations.name,
				slug: organisations.slug,
				role: memberships.role,
			})
			.from(memberships)
			.innerJoin(organisations, eq(organisations.id, memberships.organisationId))
			.where(eq(memberships.userId, id))
			.orderBy(asc(organisations.name)),
		db
			.select({ id: signIns.id, device: signIns.device, createdAt: signIns.createdAt })
			.from(signIns)
			.where(eq(signIns.userId, id))
			.orderBy(desc(signIns.createdAt))
			.limit(20),
		db
			.select({ n: count() })
			.from(sessions)
			.where(and(eq(sessions.userId, id), gte(sessions.expiresAt, now))),
		db
			.select({
				id: invitations.id,
				organisationId: invitations.organisationId,
				organisation: organisations.name,
				role: invitations.role,
				expiresAt: invitations.expiresAt,
			})
			.from(invitations)
			.innerJoin(organisations, eq(organisations.id, invitations.organisationId))
			.where(
				and(
					eq(invitations.email, user.email.toLowerCase()),
					eq(invitations.status, "pending"),
					gte(invitations.expiresAt, now),
				),
			)
			.orderBy(desc(invitations.expiresAt)),
	]);
	return {
		...user,
		organisations: memberOf,
		signIns: history,
		sessions: live?.n ?? 0,
		invitations: waiting,
	};
}

/** A pending invitation and what its message needs: never the organisation's data. */
export async function pendingInvitation(database: D1Database, id: string, now: Date) {
	const [row] = await drizzle(database)
		.select({
			id: invitations.id,
			email: invitations.email,
			role: invitations.role,
			organisation: organisations.name,
			inviter: users.name,
			inviterEmail: users.email,
		})
		.from(invitations)
		.innerJoin(organisations, eq(organisations.id, invitations.organisationId))
		.innerJoin(users, eq(users.id, invitations.inviterId))
		.where(
			and(
				eq(invitations.id, id),
				eq(invitations.status, "pending"),
				gte(invitations.expiresAt, now),
			),
		)
		.limit(1);
	return row ?? null;
}

/** Ends every session of the account. Answers how many ended. */
export async function revokeSessions(database: D1Database, userId: string): Promise<number> {
	const ended = await drizzle(database)
		.delete(sessions)
		.where(eq(sessions.userId, userId))
		.returning({ id: sessions.id });
	return ended.length;
}

/** Closes or reopens an account. Closing also ends its sessions. Answers whether the account exists. */
export async function setAccountClosed(
	database: D1Database,
	userId: string,
	closedAt: Date | null,
): Promise<boolean> {
	const db = drizzle(database);
	const [changed] = await db
		.update(users)
		.set({ closedAt, updatedAt: new Date() })
		.where(eq(users.id, userId))
		.returning({ id: users.id });
	if (!changed) return false;
	if (closedAt) await revokeSessions(database, userId);
	return true;
}

/** Whether the account is closed: a closed account starts no session. */
export async function isAccountClosed(database: D1Database, userId: string): Promise<boolean> {
	const [row] = await drizzle(database)
		.select({ closedAt: users.closedAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return Boolean(row?.closedAt);
}

/** The ids of the organisations a person is a member of. */
export async function membershipOrganisations(database: D1Database, userId: string) {
	const rows = await drizzle(database)
		.select({ organisationId: memberships.organisationId })
		.from(memberships)
		.where(eq(memberships.userId, userId));
	return rows.map(({ organisationId }) => organisationId);
}

/** Why an account cannot be deleted: organisations it is the only owner of, with others in them. */
export async function organisationsLeftWithoutOwner(database: D1Database, userId: string) {
	const db = drizzle(database);
	const owned = await db
		.select({ id: organisations.id, name: organisations.name })
		.from(memberships)
		.innerJoin(organisations, eq(organisations.id, memberships.organisationId))
		.where(and(eq(memberships.userId, userId), eq(memberships.role, "owner")));
	if (owned.length === 0) return { blocking: [], alone: [] };
	const ids = owned.map(({ id }) => id);
	const [owners, members] = await Promise.all([
		db
			.select({ organisationId: memberships.organisationId, n: count() })
			.from(memberships)
			.where(and(inArray(memberships.organisationId, ids), eq(memberships.role, "owner")))
			.groupBy(memberships.organisationId),
		db
			.select({ organisationId: memberships.organisationId, n: count() })
			.from(memberships)
			.where(inArray(memberships.organisationId, ids))
			.groupBy(memberships.organisationId),
	]);
	const ownersOf = new Map(owners.map(({ organisationId, n }) => [organisationId, n]));
	const membersOf = new Map(members.map(({ organisationId, n }) => [organisationId, n]));
	return {
		/** The only owner, with other members: hand over first. */
		blocking: owned.filter(
			({ id }) => (ownersOf.get(id) ?? 0) === 1 && (membersOf.get(id) ?? 0) > 1,
		),
		/** The only member: the organisation goes with the account. */
		alone: owned.filter(({ id }) => (membersOf.get(id) ?? 0) === 1),
	};
}

/**
 * Deletes an account on request (TS-021a's rules): every session ends, the
 * invitations the person sent and their memberships go, an organisation they
 * were alone in goes with them, and the `users` row stays with its name
 * "Deleted person" and an address that identifies nobody, so their time still
 * adds up in their organisations' reports. Refused, changing nothing, while
 * they are the only owner of an organisation with other members.
 */
export async function deleteAccount(
	database: D1Database,
	userId: string,
): Promise<{ ok: true } | { ok: false; blocking: { id: string; name: string }[] }> {
	const { blocking, alone } = await organisationsLeftWithoutOwner(database, userId);
	if (blocking.length > 0) return { ok: false, blocking };
	const db = drizzle(database);
	const now = new Date();
	await db.batch([
		db.delete(sessions).where(eq(sessions.userId, userId)),
		db.delete(invitations).where(eq(invitations.inviterId, userId)),
		...alone.map(({ id }) => db.delete(organisations).where(eq(organisations.id, id))),
		db.delete(memberships).where(eq(memberships.userId, userId)),
		db.delete(signIns).where(eq(signIns.userId, userId)),
		db
			.update(users)
			.set({
				name: DELETED_NAME,
				email: `${userId}@${DELETED_EMAIL_DOMAIN}`,
				newsletter: false,
				announcements: false,
				closedAt: now,
				updatedAt: now,
			})
			.where(eq(users.id, userId)),
	]);
	return { ok: true };
}

/** Whether an account was deleted: it cannot be reopened. */
export function isDeletedEmail(email: string): boolean {
	return email.endsWith(`@${DELETED_EMAIL_DOMAIN}`);
}

// ---------------------------------------------------------------------------
// Sign-in history

/** Records a sign-in, and the browser's kind. */
export async function recordSignIn(database: D1Database, userId: string, device: string) {
	await drizzle(database).insert(signIns).values({ userId, device });
}

/** Deletes sign-ins older than the 90 days they are kept. */
export async function deleteOldSignIns(database: D1Database, now: Date): Promise<void> {
	await drizzle(database)
		.delete(signIns)
		.where(lt(signIns.createdAt, new Date(now.getTime() - 90 * DAY)));
}

// ---------------------------------------------------------------------------
// The platform log

export type PlatformEventInput = {
	actorId: string | null;
	action: string;
	subjectType: "account" | "organisation" | "mailing" | "console";
	subjectId?: string | null;
	reason?: string | null;
	detail?: Record<string, string | number | boolean | null>;
};

export async function recordPlatformEvent(database: D1Database, event: PlatformEventInput) {
	await drizzle(database)
		.insert(platformEvents)
		.values({
			actorId: event.actorId,
			action: event.action,
			subjectType: event.subjectType,
			subjectId: event.subjectId ?? null,
			reason: event.reason ?? null,
			detail: event.detail ?? {},
		});
}

/** The newest records of the platform log, with who took each step. */
export function platformEventList(
	database: D1Database,
	{ subjectId, limit = 100 }: { subjectId?: string; limit?: number } = {},
) {
	return drizzle(database)
		.select({
			id: platformEvents.id,
			action: platformEvents.action,
			subjectType: platformEvents.subjectType,
			subjectId: platformEvents.subjectId,
			reason: platformEvents.reason,
			detail: platformEvents.detail,
			createdAt: platformEvents.createdAt,
			actor: users.name,
			actorEmail: users.email,
		})
		.from(platformEvents)
		.leftJoin(users, eq(users.id, platformEvents.actorId))
		.where(subjectId ? eq(platformEvents.subjectId, subjectId) : undefined)
		.orderBy(desc(platformEvents.createdAt), desc(platformEvents.id))
		.limit(limit);
}

// ---------------------------------------------------------------------------
// Step-up

export function stepUpOf(database: D1Database, sessionId: string) {
	return drizzle(database)
		.select()
		.from(platformStepUps)
		.where(eq(platformStepUps.sessionId, sessionId))
		.limit(1)
		.then(([row]) => row ?? null);
}

/** Keeps a new code for the session, replacing any waiting one; counts it. */
export async function keepStepUpCode(
	database: D1Database,
	{
		sessionId,
		userId,
		codeHash,
		expiresAt,
	}: { sessionId: string; userId: string; codeHash: string; expiresAt: Date },
) {
	const now = new Date();
	await drizzle(database)
		.insert(platformStepUps)
		.values({ sessionId, userId, codeHash, codeExpiresAt: expiresAt, attempts: 0, sent: 1 })
		.onConflictDoUpdate({
			target: platformStepUps.sessionId,
			set: {
				codeHash,
				codeExpiresAt: expiresAt,
				attempts: 0,
				sent: sql`${platformStepUps.sent} + 1`,
				updatedAt: now,
			},
		});
}

/** Counts a wrong code. */
export async function countStepUpAttempt(database: D1Database, sessionId: string) {
	await drizzle(database)
		.update(platformStepUps)
		.set({ attempts: sql`${platformStepUps.attempts} + 1`, updatedAt: new Date() })
		.where(eq(platformStepUps.sessionId, sessionId));
}

/** The code was right: the session is stepped up, and the code is spent. */
export async function markSteppedUp(database: D1Database, sessionId: string, now: Date) {
	await drizzle(database)
		.update(platformStepUps)
		.set({ verifiedAt: now, codeHash: null, codeExpiresAt: null, attempts: 0, updatedAt: now })
		.where(eq(platformStepUps.sessionId, sessionId));
}

// ---------------------------------------------------------------------------
// Mail

export type MailKind = "announcement" | "newsletter";

/** How many people a mailing of this kind would go to now: open accounts that have it on. */
export async function audienceSize(database: D1Database, kind: MailKind): Promise<number> {
	const [row] = await drizzle(database)
		.select({ n: count() })
		.from(users)
		.where(
			and(
				isNull(users.closedAt),
				kind === "newsletter" ? eq(users.newsletter, true) : eq(users.announcements, true),
			),
		);
	return row?.n ?? 0;
}

/** Makes a mailing and one waiting delivery for each person it goes to. */
export async function createMailing(
	database: D1Database,
	{
		kind,
		subject,
		body,
		sentBy,
	}: { kind: MailKind; subject: string; body: string; sentBy: string },
): Promise<{ id: string; recipients: number }> {
	const db = drizzle(database);
	const [mailing] = await db
		.insert(mailings)
		.values({ kind, subject, body, sentBy, recipients: 0 })
		.returning({ id: mailings.id });
	if (!mailing) throw new Error("The mailing was not stored");
	// One statement takes the audience as it is at this instant: whoever has the
	// kind of mail on and an open account. The count is what it inserted.
	const { meta } = await database
		.prepare(
			`insert into "mailing_deliveries" ("mailing_id", "user_id") select ?, "users"."id" from "users" where "users"."closed_at" is null and "users"."${
				kind === "newsletter" ? "newsletter" : "announcements"
			}" = 1`,
		)
		.bind(mailing.id)
		.run();
	const recipients = meta.changes;
	await db.update(mailings).set({ recipients }).where(eq(mailings.id, mailing.id));
	return { id: mailing.id, recipients };
}

/** The mailings, newest first, with how many of each were sent and how many wait. */
export async function mailingList(database: D1Database, limit = 50) {
	const db = drizzle(database);
	const rows = await db
		.select({
			id: mailings.id,
			kind: mailings.kind,
			subject: mailings.subject,
			recipients: mailings.recipients,
			createdAt: mailings.createdAt,
			sender: users.name,
		})
		.from(mailings)
		.leftJoin(users, eq(users.id, mailings.sentBy))
		.orderBy(desc(mailings.createdAt))
		.limit(limit);
	if (rows.length === 0) return [];
	const progress = await db
		.select({
			mailingId: mailingDeliveries.mailingId,
			sent: sql<number>`sum(case when ${mailingDeliveries.outcome} = 'sent' then 1 else 0 end)`,
			waiting: sql<number>`sum(case when ${mailingDeliveries.sentAt} is null then 1 else 0 end)`,
		})
		.from(mailingDeliveries)
		.where(
			inArray(
				mailingDeliveries.mailingId,
				rows.map(({ id }) => id),
			),
		)
		.groupBy(mailingDeliveries.mailingId);
	const of = new Map(progress.map((row) => [row.mailingId, row]));
	return rows.map((row) => ({
		...row,
		sent: Number(of.get(row.id)?.sent ?? 0),
		waiting: Number(of.get(row.id)?.waiting ?? 0),
	}));
}

/** Messages sent since `since`: what counts against the day's cap. */
export async function sentSince(database: D1Database, since: Date): Promise<number> {
	const [row] = await drizzle(database)
		.select({ n: count() })
		.from(mailingDeliveries)
		.where(and(gte(mailingDeliveries.sentAt, since), eq(mailingDeliveries.outcome, "sent")));
	return row?.n ?? 0;
}

/** The next deliveries waiting, oldest mailing first, with what each needs to be sent. */
export function waitingDeliveries(database: D1Database, limit: number) {
	return drizzle(database)
		.select({
			mailingId: mailingDeliveries.mailingId,
			userId: mailingDeliveries.userId,
			kind: mailings.kind,
			subject: mailings.subject,
			body: mailings.body,
			email: users.email,
			name: users.name,
			closedAt: users.closedAt,
			newsletter: users.newsletter,
			announcements: users.announcements,
		})
		.from(mailingDeliveries)
		.innerJoin(mailings, eq(mailings.id, mailingDeliveries.mailingId))
		.innerJoin(users, eq(users.id, mailingDeliveries.userId))
		.where(isNull(mailingDeliveries.sentAt))
		.orderBy(asc(mailings.createdAt), asc(mailingDeliveries.userId))
		.limit(limit);
}

export async function markDelivery(
	database: D1Database,
	{ mailingId, userId }: { mailingId: string; userId: string },
	outcome: "sent" | "skipped",
	now: Date,
) {
	await drizzle(database)
		.update(mailingDeliveries)
		.set({ sentAt: now, outcome })
		.where(and(eq(mailingDeliveries.mailingId, mailingId), eq(mailingDeliveries.userId, userId)));
}

/** A person's two kinds of mail. */
export async function mailChoices(database: D1Database, userId: string) {
	const [row] = await drizzle(database)
		.select({ newsletter: users.newsletter, announcements: users.announcements })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row ?? null;
}

/** Turns one kind of a person's mail on or off. */
export async function setMailChoice(
	database: D1Database,
	userId: string,
	kind: MailKind,
	on: boolean,
): Promise<boolean> {
	const changed = await drizzle(database)
		.update(users)
		.set(kind === "newsletter" ? { newsletter: on } : { announcements: on })
		.where(eq(users.id, userId))
		.returning({ id: users.id });
	return changed.length > 0;
}
