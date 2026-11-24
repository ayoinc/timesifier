import { env, waitUntil } from "cloudflare:workers";
import { and, asc, desc, eq, gt, isNull, type SQLWrapper, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, recordStatement, recordStatementWhen } from "~/activity/activity.server";
import { sendEmail } from "~/auth/email.server";
import { INVITATION_LIFETIME_SECONDS, invitationEmail } from "~/auth/invitation-email";
import { INVITATIONS_PER_SENDER, invitationsKey, usesOf } from "~/auth/quota.server";
import { getPlatformBrand } from "~/brand/platform-brand.server";
import {
	among,
	jsonTable,
	type OrganisationScope,
	organisationScope,
	organisations,
	type ScopedStatement,
	users,
	uuidv7,
	verifications,
} from "~/db";
import { InvitedRole } from "~/organisations/roles";
import { planStanding } from "~/plans/plans.server";
import { MAIL_BATCH } from "~/platform/limits";
import { capLeft, mailOrigin } from "~/platform/mail.server";
import { assignSchedule } from "~/schedules/schedules.server";
import { addToTeam, setManager } from "~/teams/teams.server";
import { dayOf } from "~/time/calendar";

import {
	capProblem,
	decidePeople,
	type Known,
	type Outcome,
	type PersonPlan,
	type PersonRow,
	readPeopleFile,
	seatsProblem,
} from "./people";

// Company onboarding (TS-108, docs/decisions.md entry 72): many invitations
// sent at once, from "Invite many" or a people import, each with what is to
// happen when it is accepted.
//
// All of one send is written in one batch or none of it: the invitations, what
// each is to apply, the uses of the sender's cap and the activity records. The
// batch's first statement holds the checks, the seats and the cap counted for
// every invitation together, and the rest follow only if it wrote. The emails
// wait in `invitation_plans` and go a few a minute (`sendWaitingInvitations`).

/** How long a person's email stays taken by one run before another may send it. */
const SENDING_STALE_MS = 10 * 60 * 1000;

/** What the organisation has, as rows are decided against it. */
export async function knownOf(scope: OrganisationScope, now: number): Promise<Known> {
	const [members, invited, teams, schedules] = await Promise.all([
		drizzle(env.DB)
			.select({ userId: users.id, email: users.email })
			.from(users)
			.where(
				sql`${users.id} in (select user_id from memberships where organisation_id = ${scope.organisationId})`,
			),
		scope.invitations.select((i) => and(eq(i.status, "pending"), gt(i.expiresAt, new Date(now)))),
		scope.teams.select(),
		scope.workSchedules.select(),
	]);
	return {
		members: new Map(members.map((m) => [m.email.toLowerCase(), m.userId])),
		invited: new Set(invited.map((i) => i.email.toLowerCase())),
		teams: new Map(teams.map((t) => [t.nameKey, { id: t.id, name: t.name }])),
		schedules: new Map(
			schedules.map((s) => [
				s.nameKey,
				{ id: s.id, name: s.name, archived: s.archivedAt !== null },
			]),
		),
	};
}

/** Room for more invitations: the plan's seats left, and the sender's cap. */
export interface Room {
	seats: number;
	seatsLeft: number;
	/** Invitations the sender may send in 24 hours from this organisation. */
	cap: number;
	capLeft: number;
}

/**
 * The seats left on the organisation's plan, and what is left of the sender's
 * cap. Sending many at once, the cap is the plan's seats, and never fewer than
 * the 20 one person may send one by one (decision 72).
 */
export async function roomFor(organisationId: string, senderId: string, now: Date): Promise<Room> {
	const [standing, uses] = await Promise.all([
		planStanding(organisationId, now),
		usesOf(env.DB, invitationsKey(senderId)),
	]);
	const seats = standing?.seats ?? 0;
	const cap = Math.max(INVITATIONS_PER_SENDER.max, seats);
	return {
		seats,
		seatsLeft: Math.max(0, seats - (standing?.used ?? seats)),
		cap,
		capLeft: Math.max(0, cap - uses),
	};
}

/** The people import a send belongs to, which it marks imported in the same batch. */
interface FromImport {
	id: string;
	skipped: { line: number; reason: string }[];
}

export type Sent = { ok: true; sent: number } | { ok: false; problem: string };

/**
 * Sends one invitation for each plan, or none: refused when the plan's seats
 * or the sender's cap cannot take them all, or when the import is no longer
 * waiting. Each invitation is recorded as `invitation.created`, from the web
 * or from the import. The emails are taken by the scheduled work; the first
 * few go at once.
 */
export async function sendInvitations(
	scope: OrganisationScope,
	senderId: string,
	plans: readonly PersonPlan[],
	{ fromImport, origin }: { fromImport?: FromImport; origin: string },
): Promise<Sent> {
	if (plans.length === 0) return { ok: true, sent: 0 };
	const now = new Date();
	const room = await roomFor(scope.organisationId, senderId, now);
	if (plans.length > room.seatsLeft)
		return { ok: false, problem: seatsProblem(plans.length, room.seatsLeft) };
	if (plans.length > room.capLeft) {
		return { ok: false, problem: capProblem(plans.length, room.capLeft, room.cap) };
	}
	const seats = room.seats;
	const key = `quota:${invitationsKey(senderId)}`;
	const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_SECONDS * 1000);
	const rows = plans.map((plan) => ({ id: uuidv7(), plan }));
	const firstId = rows[0]?.id ?? "";
	const wrote = scope.invitations.exists((i) => eq(i.id, firstId));
	const source = fromImport ? "import" : "web";

	// Seats: members and waiting invitations, as `seatsUsed` counts them, with
	// these. Cap: the sender's uses still counting, with these.
	const fits = sql`${scope.memberships.value(() => sql<number>`count(*)`)}
		+ ${scope.invitations.value(
			() => sql<number>`count(*)`,
			(i) => eq(i.status, "pending"),
		)}
		+ ${rows.length} <= ${seats}
		and (select count(*) from verifications where identifier = ${key} and expires_at > ${now.getTime()})
		+ ${rows.length} <= ${room.cap}`;
	const stillWaiting = fromImport
		? sql` and ${scope.peopleImports.exists((j) => and(eq(j.id, fromImport.id), eq(j.status, "previewed")))}`
		: sql``;

	const statements: [ScopedStatement<unknown>, ...ScopedStatement<unknown>[]] = [
		scope.invitations.statements.insertMany(
			rows.map(({ id, plan }) => ({
				id,
				email: plan.email,
				role: plan.role,
				status: "pending",
				expiresAt,
				inviterId: senderId,
				createdAt: now,
				updatedAt: now,
			})),
			sql`${fits}${stillWaiting}`,
		),
		scope.invitationPlans.statements.insertMany(
			rows.map(({ id, plan }) => ({
				invitationId: id,
				importId: fromImport?.id ?? null,
				name: plan.name,
				teamId: plan.team?.id ?? null,
				managerEmail: plan.manager,
				scheduleId: plan.schedule?.id ?? null,
				startsOn: plan.startsOn,
				createdBy: senderId,
				mailState: "waiting",
				createdAt: now,
			})),
			wrote,
		),
		// A built `insert`, not `db.run`: a raw statement has nothing for D1's
		// batch to bind, and the batch fails with a TypeError before it is sent.
		{
			query: drizzle(env.DB)
				.insert(verifications)
				.select(
					sql`select value, ${key}, '', ${now.getTime() + INVITATIONS_PER_SENDER.seconds * 1000}, ${now.getTime()}, ${now.getTime()}
					from ${jsonTable(rows.map(() => uuidv7()))} where ${wrote}`,
				),
		} as unknown as ScopedStatement<never>,
		scope.activityRecords.statements.insertMany(
			rows.map(({ id, plan }) => ({
				actorId: senderId,
				source,
				action: "invitation.created",
				subjectType: "invitation",
				subjectId: id,
				ownerId: null,
				// The role alone, as for one invitation: the address stays with the invitation.
				summary: changes(null, { role: plan.role }, ["role"]),
			})),
			wrote,
		),
	];
	if (fromImport) {
		statements.push(
			scope.peopleImports.statements.update(
				{
					status: "imported",
					importedAt: now,
					importedCount: rows.length,
					skippedCount: fromImport.skipped.length,
					skipped: fromImport.skipped,
					source: null,
				},
				(j) => and(eq(j.id, fromImport.id), eq(j.status, "previewed"), wrote),
			),
			recordStatementWhen(
				scope,
				wrote,
				senderId,
				"import.imported",
				{ type: "import", id: fromImport.id },
				{ after: { kind: "people", imported: rows.length, skipped: fromImport.skipped.length } },
				"import",
			),
		);
	}
	await scope.batch(statements);

	const [written] = await scope.invitations.select((i) => eq(i.id, firstId), { limit: 1 });
	if (!written) {
		if (fromImport && (await findPeopleImport(scope, fromImport.id))?.status !== "previewed") {
			return { ok: false, problem: "This import is no longer waiting to be imported." };
		}
		const again = await roomFor(scope.organisationId, senderId, new Date());
		return {
			ok: false,
			problem:
				rows.length > again.seatsLeft
					? seatsProblem(rows.length, again.seatsLeft)
					: capProblem(rows.length, again.capLeft, again.cap),
		};
	}
	waitUntil(sendWaitingInvitations(now, undefined, origin));
	return { ok: true, sent: rows.length };
}

// ── Sending the emails ───────────────────────────────────────────────────────

/**
 * Sends the next invitation emails waiting, oldest first, at most `budget` and
 * never past the day's cap on mail, which the platform's mailings share. Each
 * is taken first, so a run of the scheduled work and the request that made
 * them never send one twice. An invitation cancelled before its email went is
 * not sent. Answers how many were sent; one Email Service did not take goes
 * back to waiting, and the run stops there.
 */
export async function sendWaitingInvitations(
	now: Date,
	budget = MAIL_BATCH,
	origin = mailOrigin(),
): Promise<number> {
	const left = Math.min(budget, await capLeft(now));
	if (left <= 0) return 0;
	const db = drizzle(env.DB);
	const taken = await db.all<{ id: string; invitation_id: string; organisation_id: string }>(sql`
		update invitation_plans set mail_state = 'sending', mailed_at = ${now.getTime()}
		where id in (
			select p.id from invitation_plans p join invitations i on i.id = p.invitation_id
			where (p.mail_state = 'waiting' or (p.mail_state = 'sending' and p.mailed_at < ${now.getTime() - SENDING_STALE_MS}))
				and i.status = 'pending' and i.expires_at > ${now.getTime()}
			order by p.created_at, p.id limit ${left}
		)
		returning id, invitation_id, organisation_id`);
	if (taken.length === 0) return 0;
	const details = await db.all<{
		id: string;
		email: string;
		role: string;
		organisation_name: string;
		inviter_email: string;
	}>(sql`
		select i.id, i.email, i.role, o.name as organisation_name, u.email as inviter_email
		from invitations i join organisations o on o.id = i.organisation_id join users u on u.id = i.inviter_id
		where ${among(
			sql`i.id`,
			taken.map((t) => t.invitation_id),
		)}`);
	const byInvitation = new Map(details.map((d) => [d.id, d]));
	const platform = await getPlatformBrand(env);
	let sent = 0;
	for (const plan of taken) {
		const invitation = byInvitation.get(plan.invitation_id);
		const role = InvitedRole.safeParse(invitation?.role);
		if (!invitation || !role.success) continue;
		const message = invitationEmail(
			{
				link: `${origin}/invitations/${invitation.id}`,
				organisationName: invitation.organisation_name,
				inviterEmail: invitation.inviter_email,
				role: role.data,
			},
			platform,
		);
		const delivered = await sendEmail({ to: invitation.email, ...message });
		const scope = organisationScope(env.DB, plan.organisation_id);
		await scope.invitationPlans.update(
			delivered
				? { mailState: "sent", mailedAt: new Date() }
				: { mailState: "waiting", mailedAt: null },
			(p) => eq(p.id, plan.id),
		);
		if (!delivered) {
			// Put back the rest this run took, to go next time.
			await db.run(sql`update invitation_plans set mail_state = 'waiting', mailed_at = null
				where mail_state = 'sending' and mailed_at = ${now.getTime()}`);
			break;
		}
		sent += 1;
	}
	return sent;
}

// ── Accepting ────────────────────────────────────────────────────────────────

/**
 * Applies what invitation `invitationId` was to bring once its person has
 * joined, once: their name if their account has none, their team, their
 * manager over that team, their schedule from their start date (or today, if
 * that has passed), and the teams of their own file they were named to manage.
 * The changes are recorded as made by whoever sent the invitation. A team or
 * schedule deleted since, or a manager who is not a member now, is left out.
 */
export async function applyInvitationPlan(
	organisationId: string,
	invitationId: string,
	user: { id: string; email: string; name: string },
	now: Date,
): Promise<void> {
	const scope = organisationScope(env.DB, organisationId);
	const [plan] = await scope.invitationPlans.update({ appliedAt: now }, (p) =>
		and(eq(p.invitationId, invitationId), isNull(p.appliedAt)),
	);
	if (!plan) return;
	const actor = plan.createdBy ?? user.id;
	const email = user.email.toLowerCase();

	if (plan.name && user.name.trim() === "") {
		await drizzle(env.DB)
			.update(users)
			.set({ name: plan.name, updatedAt: now })
			.where(and(eq(users.id, user.id), eq(users.name, "")));
	}
	if (plan.teamId) {
		await addToTeam(scope, actor, plan.teamId, user.id, false);
		if (plan.managerEmail && plan.managerEmail !== email) {
			const managerId = await memberWith(scope, plan.managerEmail);
			if (managerId) await makeManager(scope, actor, plan.teamId, managerId);
		}
	}
	if (plan.importId) {
		// Others in the same import whose manager this person is.
		const job = await findPeopleImport(scope, plan.importId);
		if (job?.status === "imported") {
			const managed = await scope.invitationPlans.select((p) =>
				and(eq(p.importId, job.id), eq(p.managerEmail, email)),
			);
			for (const teamId of new Set(managed.map((p) => p.teamId))) {
				if (teamId) await makeManager(scope, actor, teamId, user.id);
			}
		}
	}
	if (plan.scheduleId) {
		const [organisation] = await drizzle(env.DB)
			.select({ timeZone: organisations.timeZone })
			.from(organisations)
			.where(eq(organisations.id, organisationId))
			.limit(1);
		const [person] = await drizzle(env.DB)
			.select({ timeZone: users.timeZone })
			.from(users)
			.where(eq(users.id, user.id))
			.limit(1);
		const today = dayOf(now, person?.timeZone ?? organisation?.timeZone ?? "UTC");
		const from = plan.startsOn && plan.startsOn > today ? plan.startsOn : today;
		await assignSchedule(
			scope,
			actor,
			{ kind: "person", id: user.id },
			plan.scheduleId,
			from,
			today,
		);
	}
}

async function memberWith(scope: OrganisationScope, email: string): Promise<string | null> {
	const [found] = await drizzle(env.DB)
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				eq(sql`lower(${users.email})`, email),
				sql`${users.id} in (select user_id from memberships where organisation_id = ${scope.organisationId})`,
			),
		)
		.limit(1);
	return found?.id ?? null;
}

/** Makes `userId` a manager of `teamId`: added to it as one, or made one where they are in it already. */
async function makeManager(
	scope: OrganisationScope,
	actor: string,
	teamId: string,
	userId: string,
) {
	if ((await addToTeam(scope, actor, teamId, userId, true)) === "already") {
		await setManager(scope, actor, teamId, userId, true);
	}
}

// ── People imports ───────────────────────────────────────────────────────────

export type Started = { ok: true; id: string } | { ok: false; problem: string };

/** Keeps an uploaded people file to be previewed, or says why it cannot be read. */
export async function startPeopleImport(
	scope: OrganisationScope,
	actorId: string,
	fileName: string,
	text: string,
): Promise<Started> {
	const read = readPeopleFile(text);
	if (!read.ok) return read;
	const id = uuidv7();
	await scope.peopleImports.insert({
		id,
		status: "previewed",
		fileName: fileName.slice(0, 200),
		rowCount: read.rows.length,
		createdBy: actorId,
		source: text,
		mapping: {},
	});
	return { ok: true, id };
}

/** A people import's dry run: each row's outcome, the columns read and not, and the room left. */
export interface PeoplePreview {
	outcomes: Outcome[];
	read: string[];
	unknown: string[];
	toSend: number;
	room: Room;
	/** Why nothing can be sent, when the rows that can do not fit. */
	refusal: string | null;
}

/** Reads a previewed people import again, against the organisation as it is now. */
export async function previewPeopleImport(
	scope: OrganisationScope,
	senderId: string,
	source: string,
): Promise<PeoplePreview | { problem: string }> {
	const read = readPeopleFile(source);
	if (!read.ok) return { problem: read.problem };
	const now = Date.now();
	const [known, room] = await Promise.all([
		knownOf(scope, now),
		roomFor(scope.organisationId, senderId, new Date(now)),
	]);
	const outcomes = decidePeople(read.rows, known);
	const toSend = outcomes.filter((o) => o.ok).length;
	return {
		outcomes,
		read: read.read,
		unknown: read.unknown,
		toSend,
		room,
		refusal:
			toSend > room.seatsLeft
				? seatsProblem(toSend, room.seatsLeft)
				: toSend > room.capLeft
					? capProblem(toSend, room.capLeft, room.cap)
					: null,
	};
}

/** Sends a people import's invitations, every row that can be sent, and marks it imported. */
export async function runPeopleImport(
	scope: OrganisationScope,
	senderId: string,
	id: string,
	origin: string,
): Promise<Sent> {
	const job = await findPeopleImport(scope, id);
	if (job?.status !== "previewed" || job.source === null) {
		return { ok: false, problem: "This import is no longer waiting to be imported." };
	}
	const preview = await previewPeopleImport(scope, senderId, job.source);
	if ("problem" in preview) return { ok: false, problem: preview.problem };
	if (preview.toSend === 0) return { ok: false, problem: "No row of this file can be sent." };
	if (preview.refusal) return { ok: false, problem: preview.refusal };
	return sendInvitations(
		scope,
		senderId,
		preview.outcomes.flatMap((o) => (o.ok ? [o.plan] : [])),
		{
			origin,
			fromImport: {
				id,
				skipped: preview.outcomes.flatMap((o) =>
					o.ok ? [] : [{ line: o.line, reason: o.problems.join(" ") }],
				),
			},
		},
	);
}

/** Where each invitation of a people import stands. */
export interface ImportStanding {
	waiting: number;
	joined: number;
	withdrawn: number;
}

/** How many of an import's invitations wait, were accepted, or were withdrawn or ended otherwise. */
export async function standingOf(scope: OrganisationScope, id: string): Promise<ImportStanding> {
	const rows = await drizzle(env.DB).all<{ status: string; applied: number }>(sql`
		select i.status as status, p.applied_at is not null as applied
		from invitation_plans p join invitations i on i.id = p.invitation_id
		where p.organisation_id = ${scope.organisationId} and p.import_id = ${id}`);
	return {
		waiting: rows.filter((r) => r.status === "pending").length,
		joined: rows.filter((r) => r.applied).length,
		withdrawn: rows.filter((r) => r.status !== "pending" && !r.applied).length,
	};
}

export type Reverted =
	| { ok: true; withdrawn: number; joined: number }
	| { ok: false; problem: string };

/**
 * Reverts people import `id`: its invitations still waiting are cancelled, so
 * their links stop working, and what was to happen when they were accepted is
 * deleted with them; nobody it names becomes a manager by it any more. People
 * who joined stay, with what they were given. Like a time import's, it may be
 * reverted for as long as it stands (decision 72).
 */
export async function revertPeopleImport(
	scope: OrganisationScope,
	actorId: string,
	id: string,
	now: Date,
): Promise<Reverted> {
	const job = await findPeopleImport(scope, id);
	if (job?.status !== "imported") {
		return { ok: false, problem: "Only a people import that was imported can be reverted." };
	}
	const ofImport = (column: SQLWrapper) =>
		sql`${column} in (select invitation_id from invitation_plans where organisation_id = ${scope.organisationId} and import_id = ${id})`;
	const waiting = await scope.invitations.select((i) =>
		and(eq(i.status, "pending"), ofImport(i.id)),
	);
	const { joined } = await standingOf(scope, id);
	const statements: [ScopedStatement<unknown>, ...ScopedStatement<unknown>[]] = [
		scope.peopleImports.statements.update({ status: "reverted", revertedAt: now }, (j) =>
			and(eq(j.id, id), eq(j.status, "imported")),
		),
	];
	if (waiting.length > 0) {
		statements.push(
			// Recorded first, each only while its invitation still waits: one
			// accepted a moment ago is not recorded as cancelled.
			scope.activityRecords.statements.insertMany(
				waiting.map((invitation) => ({
					actorId,
					source: "import",
					action: "invitation.cancelled",
					subjectType: "invitation",
					subjectId: invitation.id,
					summary: changes({ status: "pending" }, { status: "canceled" }, ["status"]),
				})),
				(column) =>
					sql`exists (select 1 from invitations where id = ${column("subjectId")} and status = 'pending')`,
			),
		);
	}
	statements.push(
		scope.invitations.statements.update({ status: "canceled", updatedAt: now }, (i) =>
			and(eq(i.status, "pending"), ofImport(i.id)),
		),
		scope.invitationPlans.statements.delete((p) => and(eq(p.importId, id), isNull(p.appliedAt))),
		recordStatement(
			scope,
			actorId,
			"import.reverted",
			{ type: "import", id },
			{ before: { kind: "people", invitations: waiting.length, joined } },
			"import",
		),
	);
	await scope.batch(statements);
	return { ok: true, withdrawn: waiting.length, joined };
}

/** The people import `id`, or null. */
export async function findPeopleImport(scope: OrganisationScope, id: string) {
	const [job] = await scope.peopleImports.select((j) => eq(j.id, id), { limit: 1 });
	return job ?? null;
}

/** Drops a people import still a dry run, and the file it kept. */
export async function discardPeopleImport(scope: OrganisationScope, id: string) {
	const [dropped] = await scope.peopleImports.delete((j) =>
		and(eq(j.id, id), eq(j.status, "previewed")),
	);
	return dropped !== undefined;
}

/** The organisation's people imports, newest first. */
export async function peopleImports(scope: OrganisationScope) {
	return scope.peopleImports.select(undefined, {
		orderBy: (j) => [desc(j.createdAt)],
		limit: 50,
	});
}

/** What waits to happen for each of these invitations: the plan's name, team and whether its email went. */
export async function plansOf(
	scope: OrganisationScope,
	invitationIds: readonly string[],
): Promise<Map<string, { name: string | null; team: string | null; emailWaiting: boolean }>> {
	if (invitationIds.length === 0) return new Map();
	const plans = await scope.invitationPlans.select((p) => among(p.invitationId, invitationIds), {
		orderBy: (p) => [asc(p.createdAt)],
	});
	const teams = new Map((await scope.teams.select()).map((t) => [t.id, t.name]));
	return new Map(
		plans.map((p) => [
			p.invitationId,
			{
				name: p.name,
				team: p.teamId ? (teams.get(p.teamId) ?? null) : null,
				emailWaiting: p.mailState === "waiting" || p.mailState === "sending",
			},
		]),
	);
}

export type { PersonRow };
