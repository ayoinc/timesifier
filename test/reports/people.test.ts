import { beforeAll, describe, expect, it } from "vitest";

import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { type Crowd, seedCrowd, seedWork, WEEK } from "../lists/crowd";
import { open, type Person, pageBody, textOf } from "../pages/harness";

// A Time report of 150 people (TS-113, D8) draws its groups, and reads a
// group's people, or the People section past 50 people, when it is opened:
// the page's size no longer grows with the organisation. Opened through the
// address (`show`), as without script, the page holds them.

let crowd: Crowd;

beforeAll(async () => {
	await freshDatabase();
	crowd = await seedCrowd(captureEmail());
	await seedWork(crowd);
}, 60_000);

const REPORT = `/app/acme/reports?range=week&from=${WEEK}&group=project`;
const PEOPLE_LIST = 'aria-label="Worked, expected and leave by person"';

async function html(path: string, who: Person): Promise<string> {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return pageBody(response);
}

describe("a Time report of many people", () => {
	it("draws the groups and leaves the People section to be opened", async () => {
		const page = await html(REPORT, crowd.owner);
		expect(page).not.toContain(PEOPLE_LIST);
		expect(textOf(page)).toContain("Show all 150 people");
		// Every group is drawn, none of them opened.
		expect(textOf(page)).toContain("Project 001");
		expect(textOf(page)).toContain("Project 150");
		expect(page).not.toContain('aria-label="People in');
	});

	it("draws the People section when the address opens it", async () => {
		const page = await html(`${REPORT}&show=people`, crowd.owner);
		expect(page).toContain(PEOPLE_LIST);
		const people = page.slice(page.indexOf(PEOPLE_LIST));
		expect(textOf(people)).toContain("Person 001");
		expect(textOf(people)).toContain("Person 147");
	});

	it("draws one group's people when the address opens it", async () => {
		const page = await html(`${REPORT}&show=${crowd.projects[0]}`, crowd.owner);
		const opened = page.match(/<ul aria-label="People in Project 001"[^>]*>([\s\S]*?)<\/ul>/);
		expect(textOf(opened?.[1] ?? "")).toBe("Person 001 5:00");
		expect(page.match(/aria-label="People in /g)).toHaveLength(1);
	});

	it("leaves a manager's 121 people to be opened, and opens their own groups only", async () => {
		const page = await html(REPORT, crowd.manager);
		expect(textOf(page)).toContain("Show all 121 people");
		// Project 121 is the first person's beyond the team: not the manager's to see.
		expect(textOf(page)).not.toContain("Project 121 ");
		const unseen = await html(`${REPORT}&show=${crowd.projects[120]}`, crowd.manager);
		expect(unseen).not.toContain('aria-label="People in');
	});
});
