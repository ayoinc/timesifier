import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { timeEntries } from "~/db/schema";
import { startingIn } from "~/timesheet/timesheet.server";
import { freshDatabase } from "./database";

// The query behind the Day view, the Week view and History (TS-013): a
// person's entries that start in a span, in one organisation, earliest first.
// It is the statement `organisationScope` sends for `startingIn`: the
// organisation's condition, then the filter.

let database: D1Database;

beforeEach(async () => {
	database = await freshDatabase();
});

describe("the entries of a person in a span", () => {
	it("are read through the index on (organisation_id, user_id, started_at)", async () => {
		const query = drizzle(database)
			.select()
			.from(timeEntries)
			.where(
				and(
					eq(timeEntries.organisationId, "acme"),
					startingIn("ada", { from: 0, to: 86_400_000 })(timeEntries),
				),
			)
			.orderBy(asc(timeEntries.startedAt))
			.toSQL();
		const plan = await database
			.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
			.bind(...query.params)
			.all<{ detail: string }>();
		const details = plan.results.map(({ detail }) => detail).join("\n");

		expect(details).toContain("time_entries_organisation_id_user_id_started_at_idx");
		expect(details).not.toContain("USE TEMP B-TREE");
	});
});
