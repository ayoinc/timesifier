/**
 * The few reads that come before an organisation is known (TS-081, TS-087,
 * TS-089). An API token or a calendar feed's address arrives without one: its
 * keyed hash is looked up here, and what is found names the organisation every
 * later statement is scoped to. The webhook dispatcher, run by the clock, asks
 * which organisations have webhooks to work for. Each returns ids alone; the
 * rows themselves are read through `organisationScope`.
 */
import { and, asc, eq, gt, gte, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
	activityRecords,
	apiTokens,
	calendarFeeds,
	memberships,
	webhookDeliveries,
	webhooks,
} from "./schema";

/** The token whose keyed hash is `hash`, revoked or not, or null. */
export async function apiTokenByHash(
	database: D1Database,
	hash: string,
): Promise<{ id: string; organisationId: string } | null> {
	const [token] = await drizzle(database)
		.select({ id: apiTokens.id, organisationId: apiTokens.organisationId })
		.from(apiTokens)
		.where(eq(apiTokens.tokenHash, hash))
		.limit(1);
	return token ?? null;
}

/** The calendar feed whose keyed hash is `hash` and that is not revoked, or null. */
export async function calendarFeedByHash(
	database: D1Database,
	hash: string,
): Promise<{ id: string; organisationId: string } | null> {
	const [feed] = await drizzle(database)
		.select({ id: calendarFeeds.id, organisationId: calendarFeeds.organisationId })
		.from(calendarFeeds)
		.where(and(eq(calendarFeeds.tokenHash, hash), isNull(calendarFeeds.revokedAt)))
		.limit(1);
	return feed ?? null;
}

/**
 * The organisations with work for the webhook dispatcher at `now`: an active
 * webhook, whose new activity is to be read, or a delivery due. At most
 * `limit`, the same ones first each time.
 */
export async function organisationsWithWebhooks(
	database: D1Database,
	now: Date,
	limit: number,
): Promise<string[]> {
	const db = drizzle(database);
	const [active, due] = await Promise.all([
		db
			.selectDistinct({ organisationId: webhooks.organisationId })
			.from(webhooks)
			.where(eq(webhooks.active, true))
			.orderBy(asc(webhooks.organisationId))
			.limit(limit),
		db
			.selectDistinct({ organisationId: webhookDeliveries.organisationId })
			.from(webhookDeliveries)
			.where(
				and(
					eq(webhookDeliveries.status, "pending"),
					or(isNull(webhookDeliveries.nextAttemptAt), lte(webhookDeliveries.nextAttemptAt, now)),
				),
			)
			.orderBy(asc(webhookDeliveries.organisationId))
			.limit(limit),
	]);
	return [...new Set([...active, ...due].map(({ organisationId }) => organisationId))].slice(
		0,
		limit,
	);
}

/**
 * The organisation's activity records written after the one at `afterRow`, in
 * the order they were written, for the webhook dispatcher; with no `afterRow`,
 * those written from `notBefore` on. A record's `row` is SQLite's rowid, which
 * grows in the order rows are committed, so a record committed late is never
 * passed over, as one could be by its id, whose order within a millisecond is
 * random.
 */
export async function activityAfter(
	database: D1Database,
	organisationId: string,
	afterRow: number | null,
	notBefore: Date,
	limit: number,
) {
	const row = sql<number>`${activityRecords}.rowid`;
	return drizzle(database)
		.select({
			row,
			id: activityRecords.id,
			actorId: activityRecords.actorId,
			source: activityRecords.source,
			action: activityRecords.action,
			subjectType: activityRecords.subjectType,
			subjectId: activityRecords.subjectId,
			ownerId: activityRecords.ownerId,
			summary: activityRecords.summary,
			createdAt: activityRecords.createdAt,
		})
		.from(activityRecords)
		.where(
			and(
				eq(activityRecords.organisationId, organisationId),
				afterRow === null ? gte(activityRecords.createdAt, notBefore) : gt(row, afterRow),
			),
		)
		.orderBy(asc(row))
		.limit(limit);
}

/**
 * How many organisations the signed-in person belongs to: the profile menu
 * offers the list of them when there is more than one (audit W31).
 */
export async function organisationCountOf(database: D1Database, userId: string): Promise<number> {
	const [found] = await drizzle(database)
		.select({ count: sql<number>`count(*)` })
		.from(memberships)
		.where(eq(memberships.userId, userId));
	return found?.count ?? 0;
}
