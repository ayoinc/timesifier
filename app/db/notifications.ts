import { and, asc, eq, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { among } from "./among";
import {
	notificationChoices,
	notifications,
	organisations,
	periods,
	timeEntries,
	users,
} from "./schema";

/**
 * The organisations the hourly reminders have work in (TS-049, decision 69):
 * those with a timer running, read from the partial index of running timers,
 * and those with a week waiting, from the partial index of submitted weeks.
 * Neither reads more than the rows it returns.
 */
export async function remindableOrganisations(
	database: D1Database,
): Promise<{ timing: Set<string>; waiting: Set<string> }> {
	const db = drizzle(database);
	const [timing, waiting] = await Promise.all([
		db
			.selectDistinct({ id: timeEntries.organisationId })
			.from(timeEntries)
			.where(isNull(timeEntries.endedAt)),
		db
			.selectDistinct({ id: periods.organisationId })
			.from(periods)
			.where(eq(periods.status, "submitted")),
	]);
	return {
		timing: new Set(timing.map(({ id }) => id)),
		waiting: new Set(waiting.map(({ id }) => id)),
	};
}

/**
 * Notifications' reads and writes that cross organisations (TS-049): the
 * emails that wait, sent by the scheduled work for every organisation at
 * once, the daily deletion of old ones, and a person's own email choices,
 * which are theirs in every organisation. Everything else about a
 * notification goes through `organisationScope`.
 */

/** The kinds `userId` has chosen for: true for email on, false for off. A kind not listed sends email. */
export async function notificationChoicesOf(
	database: D1Database,
	userId: string,
): Promise<Map<string, boolean>> {
	const rows = await drizzle(database)
		.select({ kind: notificationChoices.kind, email: notificationChoices.email })
		.from(notificationChoices)
		.where(eq(notificationChoices.userId, userId));
	return new Map(rows.map((row) => [row.kind, row.email]));
}

/** Turns the email of one kind on or off for `userId`, and only for them. */
export async function setNotificationChoice(
	database: D1Database,
	userId: string,
	kind: string,
	email: boolean,
): Promise<void> {
	await drizzle(database)
		.insert(notificationChoices)
		.values({ userId, kind, email })
		.onConflictDoUpdate({
			target: [notificationChoices.userId, notificationChoices.kind],
			set: { email, updatedAt: new Date() },
		});
}

/**
 * The oldest notifications, in any organisation, whose email waits, at most
 * `limit`, each with its person's address and whether they turned its kind's
 * email off, and its organisation's name and slug for the words and the link.
 */
export async function waitingNotificationEmails(database: D1Database, limit: number) {
	return drizzle(database)
		.select({
			id: notifications.id,
			kind: notifications.kind,
			title: notifications.title,
			body: notifications.body,
			path: notifications.path,
			email: users.email,
			emailOn: notificationChoices.email,
			organisationName: organisations.name,
			slug: organisations.slug,
			createdAt: notifications.createdAt,
		})
		.from(notifications)
		.innerJoin(users, eq(users.id, notifications.userId))
		.innerJoin(organisations, eq(organisations.id, notifications.organisationId))
		.leftJoin(
			notificationChoices,
			and(
				eq(notificationChoices.userId, notifications.userId),
				eq(notificationChoices.kind, notifications.kind),
			),
		)
		.where(eq(notifications.emailState, "waiting"))
		.orderBy(asc(notifications.createdAt), asc(notifications.id))
		.limit(limit);
}

/** Records what became of the emails of `ids`: sent, or skipped because their person turned the kind off. */
export async function markNotificationEmails(
	database: D1Database,
	ids: readonly string[],
	state: "sent" | "skipped",
): Promise<void> {
	if (ids.length === 0) return;
	await drizzle(database)
		.update(notifications)
		.set({ emailState: state })
		.where(and(among(notifications.id, ids), eq(notifications.emailState, "waiting")));
}

/** Deletes every notification made before `before`, in every organisation. Returns how many. */
export async function deleteNotificationsBefore(
	database: D1Database,
	before: Date,
): Promise<number> {
	const result = await drizzle(database)
		.delete(notifications)
		.where(lt(notifications.createdAt, before))
		.run();
	return result.meta.changes;
}
