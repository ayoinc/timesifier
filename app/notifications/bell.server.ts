import { env } from "cloudflare:workers";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { deleteNotificationsBefore, organisationScope } from "~/db";
import type { Membership } from "~/organisations/membership.server";
import { organisationPath } from "~/shell/destinations";

import { BELL_LIMIT, type BellItem, NOTIFICATION_RETENTION_DAYS, NotificationKind } from "./kinds";

/**
 * The bell in the shell (TS-049): how many of the person's notifications in
 * the organisation on screen are unread, the latest of them, and marking
 * them read once the list is opened. A person reads only their own: every
 * statement here is limited to the organisation and to them.
 */

/** How many of the person's notifications in the organisation are unread, for the bell's badge. */
export async function unreadCountOf({ organisation, user }: Membership): Promise<number> {
	const scope = organisationScope(env.DB, organisation.id);
	const [line] = await scope.notifications.sum(
		() => sql<number>`1`,
		(n) => n.userId,
		(n) => and(eq(n.userId, user.id), isNull(n.readAt)),
	);
	return line?.total ?? 0;
}

/** The person's latest notifications in the organisation, newest first, as the bell lists them. */
export async function bellOf({ organisation, user }: Membership): Promise<BellItem[]> {
	const scope = organisationScope(env.DB, organisation.id);
	const rows = await scope.notifications.select((n) => eq(n.userId, user.id), {
		orderBy: (n) => [desc(n.createdAt), desc(n.id)],
		limit: BELL_LIMIT,
	});
	const base = organisationPath(organisation.slug);
	return rows.map((row) => ({
		id: row.id,
		kind: NotificationKind.parse(row.kind),
		title: row.title,
		body: row.body,
		href: `${base}${row.path}`,
		createdAt: row.createdAt.getTime(),
		read: row.readAt !== null,
	}));
}

/** Marks every unread notification of the person in the organisation read, at `now`. */
export async function markAllRead({ organisation, user }: Membership, now: Date): Promise<void> {
	const scope = organisationScope(env.DB, organisation.id);
	await scope.notifications.update({ readAt: now }, (n) =>
		and(eq(n.userId, user.id), isNull(n.readAt)),
	);
}

/** Deletes every notification older than `NOTIFICATION_RETENTION_DAYS`, run by the daily job. Returns how many. */
export function deleteExpiredNotifications(now: Date): Promise<number> {
	return deleteNotificationsBefore(
		env.DB,
		new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000),
	);
}
