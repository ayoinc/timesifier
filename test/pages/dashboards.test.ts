import { beforeEach, describe, expect, it } from "vitest";

import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam } from "../organisations/harness";
import { open, type Person, pageBody, person, textOf } from "./harness";
import { markOvertime, seedEntry, seedProject } from "./periods-seed";

// Dashboards (TS-086) show overtime apart from regular time (TS-095): under the
// total, and on each of the top projects, for the people the viewer may see.

const DASHBOARDS = "/app/acme/dashboards?range=custom&from=2026-10-05&to=2026-10-11";

let ada: Person;
let alan: Person;
let mona: Person;
let grace: Person;
let fin: Person;

beforeEach(async () => {
	await freshDatabase();
	const mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(ada.cookie, "Acme");
	alan = await person(mailbox, "alan@example.com");
	mona = await person(mailbox, "mona@example.com");
	grace = await person(mailbox, "grace@example.com");
	const linus = await person(mailbox, "linus@example.com");
	fin = await person(mailbox, "fin@example.com");
	await seedMembership(acme.id, alan.user.id, "admin");
	await seedMembership(acme.id, mona.user.id, "member");
	await seedMembership(acme.id, grace.user.id, "member");
	await seedMembership(acme.id, linus.user.id, "member");
	await seedMembership(acme.id, fin.user.id, "finance");
	// Mona manages Design, which Grace is in; Linus is in no team.
	await seedTeam(acme.id, "Design", { members: [grace.user.id], managers: [mona.user.id] });
	const site = await seedProject(acme.id, "Site");
	// Grace: 7:30 and 1:00 of overtime. Linus: 1:00 and 2:00 of overtime.
	await seedEntry(acme.id, grace.user.id, site, "2026-10-06T09:00:00Z", "2026-10-06T16:30:00Z");
	await markOvertime(
		await seedEntry(acme.id, grace.user.id, site, "2026-10-06T16:30:00Z", "2026-10-06T17:30:00Z"),
	);
	await seedEntry(acme.id, linus.user.id, site, "2026-10-07T09:00:00Z", "2026-10-07T10:00:00Z");
	await markOvertime(
		await seedEntry(acme.id, linus.user.id, site, "2026-10-07T10:00:00Z", "2026-10-07T12:00:00Z"),
	);
}, 60_000);

async function board(who: Person): Promise<string> {
	const response = await open(DASHBOARDS, who);
	expect(response.status).toBe(200);
	return textOf(await pageBody(response));
}

describe("overtime on Dashboards (TS-095)", () => {
	it.each(["owner", "admin", "finance"] as const)(
		"shows the %s everyone's overtime apart from regular time",
		async (role) => {
			const text = await board({ owner: ada, admin: alan, finance: fin }[role]);
			expect(text).toMatch(/Total: 11:30 of \S+ expected 8:30 \+ 3:00 overtime/);
			expect(text).toMatch(/Site 8:30 \+ 3:00 overtime 11:30/);
		},
	);

	it("shows a manager the overtime of their team's people and nobody else's", async () => {
		const text = await board(mona);
		expect(text).toMatch(/Total: 8:30 of \S+ expected 7:30 \+ 1:00 overtime/);
		expect(text).toMatch(/Site 7:30 \+ 1:00 overtime 8:30/);
		expect(text).not.toContain("3:00 overtime");
		expect(text).not.toContain("2:00 overtime");
	});

	it("is not shown to a member", async () => {
		expect((await open(DASHBOARDS, grace)).status).toBe(404);
	});
});
