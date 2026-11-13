import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { timeEntries } from "~/db/schema";
import { onDays } from "~/timesheet/timesheet.server";
import { freshDatabase } from "./database";

// The query behind the Day view, the Week view and History (TS-013): a
// person's entries whose stored day is in a span (TS-111), in one
// organisation, earliest first. It is the statement `organisationScope` sends
// for `onDays`: the organisation's condition, then the filter.

let database: D1Database;

beforeEach(async () => {
	database = await freshDatabase();
});

describe("the entries of a person on a span of days", () => {
	it("are read through the index on (organisation_id, user_id, spent_on)", async () => {
		const query = drizzle(database)
			.select()
			.from(timeEntries)
			.where(
				and(
					eq(timeEntries.organisationId, "acme"),
					onDays("ada", "2026-11-09", "2026-11-15")(timeEntries),
				),
			)
			.orderBy(asc(timeEntries.startedAt))
			.toSQL();
		const plan = await database
			.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
			.bind(...query.params)
			.all<{ detail: string }>();
		const details = plan.results.map(({ detail }) => detail).join("\n");

		// The rows of a person's days are found by the index and sorted by their
		// start, a few weeks' entries at most: History reads the most, 12 periods.
		expect(details).toContain("time_entries_organisation_id_user_id_spent_on_idx");
	});
});
