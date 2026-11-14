import { beforeEach, describe, expect, it } from "vitest";

import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { open, type Person, pageBody, textOf } from "../pages/harness";
import { type Crowd, MANAGED, PEOPLE, seedCrowd, seedWork, WEEK } from "./crowd";

// The pages of an organisation of 150 people (TS-112). Every list of people
// goes to D1 as one JSON value (decision 40), so no page fails on D1's 100
// bound parameters, and the Approvals link is counted in one statement. Before
// TS-112 every page an owner or admin opened answered 500 here, as did a
// manager's of 120 people (`research/corporate/scale-test.md`, D1).

let crowd: Crowd;

beforeEach(async () => {
	await freshDatabase();
	crowd = await seedCrowd(captureEmail());
	await seedWork(crowd);
}, 60_000);

/** The page's text, after checking it answered 200. */
async function read(path: string, who: Person): Promise<string> {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
}

const PAGES = [
	"/app/acme",
	`/app/acme?view=week&start=${WEEK}`,
	"/app/acme/team",
	`/app/acme/team?week=${WEEK}`,
	"/app/acme/team?show=teams",
	`/app/acme/approvals?week=${WEEK}&status=pending`,
	`/app/acme/approvals?week=${WEEK}&status=not-submitted`,
	"/app/acme/time-off",
	"/app/acme/time-off?show=requests",
	"/app/acme/settings",
	"/app/acme/team/members",
	"/app/acme/settings/schedules",
];

describe(`an organisation of ${PEOPLE} people`, () => {
	for (const role of ["owner", "admin"] as const) {
		it(`opens every page of an ${role}'s list of people`, async () => {
			const who = crowd[role];
			for (const path of PAGES) await read(path, who);
			const team = await read(`/app/acme/team?week=${WEEK}`, who);
			expect(team).toContain("Person 001");
			expect(team).toContain("Person 147");
			const approvals = await read(`/app/acme/approvals?week=${WEEK}&status=pending`, who);
			expect(approvals).toContain("Person 147");
			const requests = await read("/app/acme/time-off?show=requests", who);
			expect(requests).toContain("Person 147");
		});
	}

	it("counts the Approvals link for an owner and an admin: every week and request waiting", async () => {
		// 147 weeks submitted, and 147 requests for leave, none of them the viewer's own.
		expect(await read("/app/acme/projects", crowd.owner)).toMatch(/Approvals 294 pending/);
		expect(await read("/app/acme/projects", crowd.admin)).toMatch(/Approvals 294 pending/);
	});
});

describe(`a manager of ${MANAGED} people`, () => {
	it("opens their Timesheet, Team, Approvals, Time off and Activity", async () => {
		const { manager } = crowd;
		for (const path of [
			"/app/acme",
			`/app/acme/team?week=${WEEK}`,
			"/app/acme/time-off?show=requests",
			"/app/acme/activity",
		]) {
			await read(path, manager);
		}
		const team = await read(`/app/acme/team?week=${WEEK}`, manager);
		expect(team).toContain(`Person ${String(MANAGED).padStart(3, "0")}`);
		expect(team).not.toContain(`Person ${String(MANAGED + 1).padStart(3, "0")}`);
		const approvals = await read(`/app/acme/approvals?week=${WEEK}&status=pending`, manager);
		expect(approvals).toContain("Person 120");
		expect(approvals).not.toContain("Person 121");
	});

	it("counts on the Approvals link only what waits for them", async () => {
		// The 120 weeks and the 120 requests of the people they manage.
		expect(await read("/app/acme/projects", crowd.manager)).toMatch(/Approvals 240 pending/);
	});
});
