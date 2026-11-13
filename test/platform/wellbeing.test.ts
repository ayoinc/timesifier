import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganisationScope, organisationScope, uuidv7 } from "~/db";
import { LEAVE_DAYS, MINIMUM_GROUP, REGULARLY, WEEKS } from "~/wellbeing/wellbeing";
import { roughShare, wellbeingSignals } from "~/wellbeing/wellbeing.server";
import { freshDatabase } from "../db/database";
import { seedMember, seedOrganisation, value } from "../organisations/harness";
import { seedLeave } from "../pages/leave-seed";

// Anonymised wellbeing for an organisation's owners (TS-099, docs/decisions.md
// entry 36): the share of people over the working week in 3 of the last 4
// weeks, and the share with no approved leave in 182 days, each rounded to
// 10%, and nothing at all below five people.

const NOW = new Date("2026-11-12T12:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

beforeEach(async () => {
	await freshDatabase();
});

interface Seeded {
	id: string;
	scope: OrganisationScope;
	project: string;
	people: string[];
	/** The organisation's working week, in minutes. */
	weekMinutes: number;
}

/** Acme with `count` members, a project, and the default working week. */
async function acme(count: number): Promise<Seeded> {
	const organisation = await seedOrganisation("Acme", "acme");
	const people: string[] = [];
	for (let n = 0; n < count; n++) {
		const member = await seedMember(
			organisation.id,
			n === 0 ? "owner" : "member",
			`person${n}@example.com`,
		);
		people.push(member.userId);
	}
	const scope = organisationScope(env.DB, organisation.id);
	const [project] = await scope.projects.insert({ name: "Site", nameKey: "site" });
	if (!project) throw new Error("seed failed");
	const weekMinutes =
		(await value(
			"select sum(minutes) from working_days where organisation_id = ?",
			organisation.id,
		)) ?? 0;
	expect(weekMinutes).toBeGreaterThan(0);
	return {
		id: organisation.id,
		scope,
		project: project.id,
		people,
		weekMinutes,
	};
}

/**
 * `userId` tracks `minutes` in each of the `weeks` (0 the latest seven days
 * before `NOW`), spread over six days so that no entry is long.
 */
async function track(seeded: Seeded, userId: string, weeks: number[], minutes: number) {
	for (const week of weeks) {
		for (let day = 1; day <= 6; day++) {
			const startedAt = new Date(NOW.getTime() - week * WEEK - day * DAY);
			await seeded.scope.timeEntries.insert({
				userId,
				projectId: seeded.project,
				startedAt,
				endedAt: new Date(startedAt.getTime() + Math.ceil(minutes / 6) * MINUTE),
			});
		}
	}
}

describe("the wellbeing signals", () => {
	it("are hidden below five people: no share at all", async () => {
		const seeded = await acme(MINIMUM_GROUP - 1);
		await track(seeded, seeded.people[0] ?? "", [0, 1, 2, 3], seeded.weekMinutes + 600);

		expect(await wellbeingSignals(seeded.scope, NOW)).toEqual({ shown: false, people: 4 });
	});

	it("are shown at five, counting only members over in at least 3 of the 4 weeks", async () => {
		const seeded = await acme(MINIMUM_GROUP);
		const [a, b, c, d] = seeded.people as [string, string, string, string, string];
		const over = seeded.weekMinutes + 60;
		await track(seeded, a, [0, 1, 2], over);
		await track(seeded, b, [0, 1, 2, 3], over);
		// Over in two weeks only, and at the working week exactly in the others: neither counts.
		await track(seeded, c, [0, 3], over);
		await track(seeded, c, [1, 2], seeded.weekMinutes - 5);
		// Five weeks back is outside the four looked at.
		await track(seeded, d, [1, 4], over);
		await track(seeded, d, [5], over);
		// Somebody who left: their time is not a member's.
		const gone = uuidv7();
		await env.DB.prepare(
			"insert into users (id, name, email, created_at, updated_at) values (?, 'Gone', 'gone@example.com', 0, 0)",
		)
			.bind(gone)
			.run();
		await track(seeded, gone, [0, 1, 2, 3], over);

		const signals = await wellbeingSignals(seeded.scope, NOW);

		expect(signals).toEqual({ shown: true, people: 5, overHours: 40, noLeave: 100 });
		expect([WEEKS, REGULARLY]).toEqual([4, 3]);
	});

	it("count people with approved leave in the last 182 days as rested", async () => {
		const seeded = await acme(6);
		const [a, b, c, d, e] = seeded.people as string[];
		await seedLeave(seeded.id, a ?? "", "annual", "2026-10-01", "2026-10-02");
		// Leave that ended on the first day of the window still counts.
		const windowStart = new Date(NOW.getTime() - LEAVE_DAYS * DAY).toISOString().slice(0, 10);
		await seedLeave(seeded.id, b ?? "", "annual", "2026-01-05", windowStart);
		// Pending, too long ago or still to come: none of these is rest taken.
		await seedLeave(seeded.id, c ?? "", "annual", "2026-10-01", "2026-10-01", {
			status: "pending",
		});
		await seedLeave(seeded.id, d ?? "", "annual", "2025-12-01", "2025-12-02");
		await seedLeave(seeded.id, e ?? "", "annual", "2026-12-01", "2026-12-02");

		expect(await wellbeingSignals(seeded.scope, NOW)).toEqual({
			shown: true,
			people: 6,
			overHours: 0,
			// Four of six, 66.7%, is shown as 70.
			noLeave: 70,
		});
	});
});

describe("a rough share", () => {
	it("is a whole percentage rounded to the nearest 10", () => {
		expect(roughShare(0, 0)).toBe(0);
		expect(roughShare(0, 5)).toBe(0);
		expect(roughShare(1, 3)).toBe(30);
		expect(roughShare(2, 3)).toBe(70);
		expect(roughShare(1, 6)).toBe(20);
		expect(roughShare(1, 20)).toBe(10);
		expect(roughShare(1, 21)).toBe(0);
		expect(roughShare(5, 5)).toBe(100);
	});
});
