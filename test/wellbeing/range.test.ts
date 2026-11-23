import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { addDays, dayOf } from "~/time/calendar";
import { MINIMUM_GROUP } from "~/wellbeing/wellbeing";
import { wellbeingSignals } from "~/wellbeing/wellbeing.server";
import { freshDatabase } from "../db/database";
import { seedMember, seedOrganisation, value } from "../organisations/harness";

// The weeks Wellbeing looks back over are days (TS-113, D7): the four whole
// weeks of seven days before the organisation's today, read by the day stored
// with each entry (TS-111). With the organisation in UTC and `NOW` on Thursday
// 12 November 2026, they are Thursday 15 October to Wednesday 11 November.
// People tracked in Auckland, 13 hours ahead of UTC in November, have stored
// days a day after the UTC day their entries start on.

const NOW = new Date("2026-11-12T12:00:00Z");
const TODAY = "2026-11-12";
const FIRST = "2026-10-15";
const LAST = "2026-11-11";
const AUCKLAND = "Pacific/Auckland";
const MINUTE = 60_000;

let scope: OrganisationScope;
let project: string;
let people: string[];
/** The organisation's working week, in minutes. */
let weekMinutes: number;

beforeEach(async () => {
	await freshDatabase();
	const organisation = await seedOrganisation("Acme", "acme");
	people = [];
	for (let n = 0; n < MINIMUM_GROUP; n++) {
		const member = await seedMember(
			organisation.id,
			n === 0 ? "owner" : "member",
			`person${n}@example.com`,
		);
		people.push(member.userId);
	}
	scope = organisationScope(env.DB, organisation.id);
	const [site] = await scope.projects.insert({ name: "Site", nameKey: "site" });
	if (!site) throw new Error("seed failed");
	project = site.id;
	weekMinutes =
		(await value(
			"select sum(minutes) from working_days where organisation_id = ?",
			organisation.id,
		)) ?? 0;
	expect(weekMinutes).toBeGreaterThan(0);
});

/** `userId` tracks `minutes` starting at `from`, on the day it is in `zone`. */
async function entry(userId: string, from: string, minutes: number, zone = "UTC") {
	const startedAt = new Date(from);
	await scope.timeEntries.insert({
		userId,
		projectId: project,
		startedAt,
		endedAt: new Date(startedAt.getTime() + minutes * MINUTE),
		spentOn: dayOf(startedAt, zone),
	});
}

/**
 * `userId` tracks `minutes` in `week` (0 the week ending on `LAST`) at noon
 * UTC on five of its days, none of them its first or last.
 */
async function inWeek(userId: string, week: number, minutes: number) {
	for (let day = 1; day <= 5; day++) {
		await entry(userId, `${addDays(LAST, -7 * week - day)}T12:00:00Z`, Math.ceil(minutes / 5));
	}
}

describe("the weeks of Wellbeing", () => {
	it("count the time on the first and the last of their stored days", async () => {
		const [p, q] = people as [string, string];
		const over = weekMinutes + 60;
		const nearly = weekMinutes - 30;

		// Over in weeks 1 and 2, and in week 3 only with an hour on its first day,
		// Thursday 15 October in Auckland, which starts on the 14th in UTC.
		await inWeek(p, 1, over);
		await inWeek(p, 2, over);
		await inWeek(p, 3, nearly);
		await entry(p, "2026-10-14T11:30:00Z", 60, AUCKLAND);
		// Over in weeks 1 and 2, and in week 0 only with an hour on its last day,
		// Wednesday 11 November in Auckland, which starts on the 10th in UTC.
		await inWeek(q, 1, over);
		await inWeek(q, 2, over);
		await inWeek(q, 0, nearly);
		await entry(q, "2026-11-10T11:30:00Z", 60, AUCKLAND);
		expect(
			await value(
				"select spent_on from time_entries where started_at = ?",
				Date.parse("2026-10-14T11:30:00Z"),
			),
		).toBe(FIRST);
		expect(
			await value(
				"select spent_on from time_entries where started_at = ?",
				Date.parse("2026-11-10T11:30:00Z"),
			),
		).toBe(LAST);

		// Two of five people, 40%.
		expect(await wellbeingSignals(scope, NOW)).toMatchObject({ shown: true, overHours: 40 });
	});

	it("leave out the time on the day before the first and on today", async () => {
		const [r, s] = people as [string, string];
		const over = weekMinutes + 60;
		const nearly = weekMinutes - 30;

		// An hour on today, Thursday 12 November in Auckland though it starts on
		// the 11th in UTC: today is not yet a whole day, and is in no week.
		await inWeek(r, 1, over);
		await inWeek(r, 2, over);
		await inWeek(r, 0, nearly);
		await entry(r, "2026-11-11T13:00:00Z", 60, AUCKLAND);
		// An hour on Wednesday 14 October in Auckland, the day before the first.
		await inWeek(s, 1, over);
		await inWeek(s, 2, over);
		await inWeek(s, 3, nearly);
		await entry(s, "2026-10-13T12:00:00Z", 60, AUCKLAND);
		expect(
			await value(
				"select spent_on from time_entries where started_at = ?",
				Date.parse("2026-11-11T13:00:00Z"),
			),
		).toBe(TODAY);
		expect(
			await value(
				"select spent_on from time_entries where started_at = ?",
				Date.parse("2026-10-13T12:00:00Z"),
			),
		).toBe(addDays(FIRST, -1));

		expect(await wellbeingSignals(scope, NOW)).toMatchObject({ shown: true, overHours: 0 });
	});
});
