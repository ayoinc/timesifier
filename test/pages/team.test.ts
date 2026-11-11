import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";
import { seedHoliday, seedLeave } from "./leave-seed";
import { seedEntry, seedPeriod, seedProject } from "./periods-seed";

// Team (TS-045, TS-038): This week, one person's week, and the teams. Owners
// and admins see everyone and manage the teams; a manager sees the members of
// the teams they manage and changes nothing; a member gets 404.

const TEAM = "/app/acme/team";
const TEAMS = "/app/acme/team?show=teams";
/** A week long past, so its days are the same in any zone the test runs in. */
const WEEK = "2026-01-05";
const NOT_ALLOWED = "Your role in this organisation does not allow that.";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
}, 30_000);

async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

const ask = async (who: Person, fields: Record<string, string>) => {
	const response = await submit(TEAM, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
};

const teamId = (name: string) =>
	value<string>("select id from teams where organisation_id = ? and name = ?", acme.id, name).then(
		String,
	);

describe("This week", () => {
	it("shows each visible person's hours, running timer and status, with arrows to earlier weeks", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		const project = await seedProject(acme.id, "Website");
		await seedEntry(
			acme.id,
			grace.user.id,
			project,
			"2026-01-06T10:00:00Z",
			"2026-01-06T17:30:00Z",
		);
		await seedEntry(
			acme.id,
			grace.user.id,
			project,
			"2026-01-07T10:00:00Z",
			"2026-01-07T11:00:00Z",
		);
		// A week before, not counted.
		await seedEntry(
			acme.id,
			grace.user.id,
			project,
			"2025-12-30T10:00:00Z",
			"2025-12-30T12:00:00Z",
		);
		await seedEntry(acme.id, linus.user.id, project, Date.now() - 60_000, null);
		await seedPeriod(acme.id, grace.user.id, WEEK, "submitted");

		const html = await pageBody(await open(`${TEAM}?week=${WEEK}`, ada));
		const text = textOf(html);
		expect(text).toContain("5 to 11 January 2026");
		expect(text).toMatch(/grace@example\.com Submitted 8:30/);
		expect(text).toMatch(/linus@example\.com Not submitted · Timer running 0:00/);
		// The week's total stands above the people (TS-058).
		expect(text).toContain("Week's total 8:30");
		expect(text.indexOf("Week's total")).toBeLessThan(text.indexOf("grace@example.com Submitted"));
		expect(html).toContain('href="/app/acme/team?week=2025-12-29"');
		expect(html).toContain('href="/app/acme/team?week=2026-01-12"');
		expect(html).toContain(`href="/app/acme/team?week=${WEEK}&amp;person=${grace.user.id}"`);

		// The current week has no later one.
		expect(textOf(await pageBody(await open(TEAM, ada)))).toContain("This is the current week");
	});

	it("opens one person's week to read, and nobody else's", async () => {
		const grace = await memberOfAcme("member", "grace@example.com");
		const project = await seedProject(acme.id, "Website");
		await seedEntry(
			acme.id,
			grace.user.id,
			project,
			"2026-01-06T10:00:00Z",
			"2026-01-06T12:15:00Z",
			"Copy",
		);

		const response = await open(`${TEAM}?week=${WEEK}&person=${grace.user.id}`, ada);
		expect(response.status).toBe(200);
		const html = await pageBody(response);
		const text = textOf(html);
		expect(text).toContain("Tuesday 6 January 2:15");
		expect(text).toContain("Copy Website");
		expect(text).toContain("only they can change it");
		// Read-only: no form or button changes their entries.
		expect(html).not.toMatch(/name="intent"/);

		expect((await open(`${TEAM}?person=nobody`, ada)).status).toBe(404);
	});

	it("shows a manager only the members of the teams they manage", async () => {
		const mona = await memberOfAcme("member", "mona@example.com");
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		await seedTeam(acme.id, "Design", { members: [grace.user.id], managers: [mona.user.id] });

		const text = textOf(await pageBody(await open(TEAM, mona)));
		expect(text).toContain("grace@example.com");
		expect(text).not.toContain("linus@example.com");
		expect(text).not.toContain("ada@example.com");
		expect((await open(`${TEAM}?person=${linus.user.id}`, mona)).status).toBe(404);
		expect((await open(`${TEAM}?person=${grace.user.id}`, mona)).status).toBe(200);
	});

	describe("filtered by name in the address (TS-058)", () => {
		async function seedWeek() {
			const grace = await memberOfAcme("member", "grace@example.com");
			const linus = await memberOfAcme("member", "linus@example.com");
			const project = await seedProject(acme.id, "Website");
			await seedEntry(
				acme.id,
				grace.user.id,
				project,
				"2026-01-06T10:00:00Z",
				"2026-01-06T12:00:00Z",
			);
			await seedEntry(
				acme.id,
				linus.user.id,
				project,
				"2026-01-07T10:00:00Z",
				"2026-01-07T13:00:00Z",
			);
			return { grace, linus };
		}

		it("narrows the people and the total on the server, by name or address, in any case", async () => {
			await seedWeek();
			const all = textOf(await pageBody(await open(`${TEAM}?week=${WEEK}`, ada)));
			expect(all).toContain("Week's total 5:00");

			const response = await open(`${TEAM}?week=${WEEK}&q=GRA`, ada);
			expect(response.status).toBe(200);
			const html = await pageBody(response);
			const text = textOf(html);
			expect(text).toContain("grace@example.com");
			expect(text).not.toContain("linus@example.com");
			expect(text).toContain("Total for “GRA” 2:00");
			expect(text).toContain("1 of 3");
			// The field holds the filter, and the arrows keep it.
			expect(html).toMatch(/<input[^>]*name="q"[^>]*value="GRA"/);
			expect(html).toContain('href="/app/acme/team?week=2025-12-29&amp;q=GRA"');
		});

		it("says when nobody matches, with a way back to everyone", async () => {
			await seedWeek();
			const html = await pageBody(await open(`${TEAM}?week=${WEEK}&q=nobody`, ada));
			const text = textOf(html);
			expect(text).toContain("Nobody's name or address holds “nobody”.");
			expect(text).toContain("Total for “nobody” 0:00");
			expect(html).toMatch(new RegExp(`href="/app/acme/team\\?week=${WEEK}"[^>]*>Show everyone`));
		});

		it("finds a manager only among the members of the teams they manage", async () => {
			const { grace, linus } = await seedWeek();
			const mona = await memberOfAcme("member", "mona@example.com");
			await seedTeam(acme.id, "Design", { members: [grace.user.id], managers: [mona.user.id] });

			const theirs = textOf(await pageBody(await open(`${TEAM}?week=${WEEK}&q=grace`, mona)));
			expect(theirs).toContain("Total for “grace” 2:00");
			const outside = textOf(await pageBody(await open(`${TEAM}?week=${WEEK}&q=linus`, mona)));
			expect(outside).not.toContain(linus.user.email);
			expect(outside).toContain("Total for “linus” 0:00");
			expect(textOf(await pageBody(await open(`${TEAM}?week=${WEEK}`, mona)))).toContain(
				"Week's total 2:00",
			);
		});

		it("is not there for a member, filtered or not", async () => {
			const bob = await memberOfAcme("member", "bob@example.com");
			expect((await open(`${TEAM}?q=bob`, bob)).status).toBe(404);
		});
	});

	it("is not there for a member", async () => {
		const bob = await memberOfAcme("member", "bob@example.com");
		expect((await open(TEAM, bob)).status).toBe(404);
		expect((await open(TEAMS, bob)).status).toBe(404);
		expect((await ask(bob, { intent: "create", name: "Mine" })).status).toBe(404);
	});

	it("links the tabs: This week, Teams, Members and Invitations", async () => {
		const html = await pageBody(await open(TEAM, ada));
		expect(html).toMatch(
			/<a(?=[^>]*href="\/app\/acme\/team")(?=[^>]*aria-current="page")[^>]*>This week/,
		);
		expect(html).toMatch(/href="\/app\/acme\/team\?show=teams"[^>]*>Teams/);
		expect(html).toMatch(/href="\/app\/acme\/team\/members"[^>]*>Members/);
		expect(html).toMatch(/href="\/app\/acme\/team\/invitations"[^>]*>Invitations/);
	});
});

describe("Teams", () => {
	it("an admin creates, renames and deletes a team; names are unique, any case", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		expect((await ask(grace, { intent: "create", name: " Design " })).said).toContain(
			"Team Design created.",
		);
		const taken = await ask(grace, { intent: "create", name: "DESIGN" });
		expect(taken.status).toBe(409);
		expect(taken.said).toContain("Another team of this organisation has that name");
		expect((await ask(grace, { intent: "create", name: "" })).status).toBe(400);

		const id = await teamId("Design");
		expect((await ask(grace, { intent: "rename", teamId: id, name: "Brand" })).said).toContain(
			"Team renamed Brand.",
		);
		expect(textOf(await pageBody(await open(TEAMS, grace)))).toContain("Brand");

		expect((await ask(grace, { intent: "delete", teamId: id })).status).toBe(200);
		expect(await value("select count(*) from teams")).toBe(0);
	});

	it("an owner adds people, marks a manager, and takes people out; the manager then sees their time", async () => {
		const mona = await memberOfAcme("member", "mona@example.com");
		const grace = await memberOfAcme("member", "grace@example.com");
		await ask(ada, { intent: "create", name: "Design" });
		const id = await teamId("Design");

		await ask(ada, { intent: "add", teamId: id, userId: grace.user.id });
		const added = await ask(ada, {
			intent: "add",
			teamId: id,
			userId: mona.user.id,
			manager: "on",
		});
		expect(added.said).toContain("Added to the team as its manager.");
		expect((await ask(ada, { intent: "add", teamId: id, userId: grace.user.id })).status).toBe(409);
		expect((await ask(ada, { intent: "add", teamId: id, userId: "stranger" })).said).toContain(
			"not a member",
		);

		// Mona now manages Design, so Team is hers and shows Grace.
		expect(textOf(await pageBody(await open(TEAM, mona)))).toContain("grace@example.com");
		const teams = textOf(await pageBody(await open(TEAMS, ada)));
		expect(teams).toMatch(/grace@example\.com Member/);
		expect(teams).toMatch(/mona@example\.com Manager/);

		// Grace made a manager, Mona no longer one.
		await ask(ada, { intent: "manager", teamId: id, userId: grace.user.id, isManager: "true" });
		await ask(ada, { intent: "manager", teamId: id, userId: mona.user.id, isManager: "false" });
		expect((await open(TEAM, mona)).status).toBe(404);
		expect((await open(TEAM, grace)).status).toBe(200);

		await ask(ada, { intent: "remove", teamId: id, userId: grace.user.id });
		expect((await open(TEAM, grace)).status).toBe(404);
	});

	it("a manager sees the teams they manage and changes nothing", async () => {
		const mona = await memberOfAcme("member", "mona@example.com");
		const id = await seedTeam(acme.id, "Design", { managers: [mona.user.id] });
		await seedTeam(acme.id, "Sales", {});

		const html = await pageBody(await open(TEAMS, mona));
		expect(textOf(html)).toContain("Design");
		expect(textOf(html)).not.toContain("Sales");
		expect(html).not.toContain("New team");

		const attempts: Record<string, string>[] = [
			{ intent: "create", name: "Mine" },
			{ intent: "rename", teamId: id, name: "Mine" },
			{ intent: "delete", teamId: id },
			{ intent: "add", teamId: id, userId: ada.user.id },
		];
		for (const fields of attempts) {
			const refused = await ask(mona, fields);
			expect(refused.status).toBe(403);
			expect(refused.said).toContain(NOT_ALLOWED);
		}
		expect(await value("select name from teams where id = ?", id)).toBe("Design");
	});

	it("does not reach another organisation's team", async () => {
		const other = await createOrganisation(ada.cookie, "Other");
		const theirs = await seedTeam(other.id, "Theirs", {});
		const grace = await memberOfAcme("member", "grace@example.com");
		expect((await ask(ada, { intent: "rename", teamId: theirs, name: "Mine" })).status).toBe(409);
		expect((await ask(ada, { intent: "add", teamId: theirs, userId: grace.user.id })).status).toBe(
			409,
		);
		expect((await ask(ada, { intent: "delete", teamId: theirs })).status).toBe(409);
		expect(await value("select name from teams where id = ?", theirs)).toBe("Theirs");
	});
});

describe("who is not working (TS-061)", () => {
	/** A Wednesday: the server's clock once everyone has signed in. */
	const T0 = Date.parse("2026-11-11T10:00:00Z");

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows where each person stands now, the time expected of them and their days of leave", async () => {
		const mona = await memberOfAcme("member", "mona@example.com");
		const grace = await memberOfAcme("member", "grace@example.com");
		const linus = await memberOfAcme("member", "linus@example.com");
		const bob = await memberOfAcme("member", "bob@example.com");
		await seedTeam(acme.id, "Design", { members: [grace.user.id], managers: [mona.user.id] });
		vi.spyOn(Date, "now").mockReturnValue(T0);
		const project = await seedProject(acme.id, "Website");
		// Grace is on annual leave today and half of Friday.
		await seedLeave(acme.id, grace.user.id, "annual", "2026-11-11", "2026-11-11");
		await seedLeave(acme.id, grace.user.id, "annual", "2026-11-13", "2026-11-13", {
			startsHalf: true,
		});
		// Linus is on sick leave, but his timer runs: he is working.
		await seedLeave(acme.id, linus.user.id, "sick", "2026-11-11", "2026-11-11");
		await seedEntry(acme.id, linus.user.id, project, T0 - 3_600_000, null);
		// Bob's leave waits: he is expected as ever.
		await seedLeave(acme.id, bob.user.id, "annual", "2026-11-11", "2026-11-11", {
			status: "pending",
		});

		const text = textOf(await pageBody(await open(TEAM, ada)));
		expect(text).toMatch(
			/grace@example\.com On leave · Annual leave Not submitted Leave: Wed 11 Annual leave, Fri 13 Annual leave \(half day\) 0:00 of 26:15 expected/,
		);
		expect(text).toMatch(
			/linus@example\.com Working Not submitted · Timer running Leave: Wed 11 Sick leave 1:00 of 30:00 expected/,
		);
		expect(text).toMatch(/bob@example\.com Available Not submitted 0:00 of 37:30 expected/);

		// Her manager sees the same of her.
		const managed = textOf(await pageBody(await open(TEAM, mona)));
		expect(managed).toMatch(/grace@example\.com On leave · Annual leave/);
		expect(managed).not.toContain("linus@example.com");

		// Her week marks the days, each with the time expected.
		const week = textOf(await pageBody(await open(`${TEAM}?person=${grace.user.id}`, ada)));
		expect(week).toContain("Not submitted, 26:15 expected");
		expect(week).toMatch(/Wednesday 11 November · Annual leave 0:00 of 0:00 Annual leave/);
		expect(week).toMatch(/Friday 13 November · Annual leave \(half day\) 0:00 of 3:45/);
		expect(week).toMatch(/Thursday 12 November 0:00 of 7:30 No time\./);
		expect(week).toMatch(/Saturday 14 November · Not a working day 0:00 of 0:00/);
	});

	it("says a public holiday or a day off is not a working day, and shows no status on an earlier week", async () => {
		await memberOfAcme("member", "bob@example.com");
		vi.spyOn(Date, "now").mockReturnValue(T0);
		await seedHoliday(acme.id, "2026-11-11", "Armistice Day");

		let text = textOf(await pageBody(await open(TEAM, ada)));
		expect(text).toMatch(
			/bob@example\.com Not working today · Armistice Day Not submitted 0:00 of 30:00 expected/,
		);

		// A Saturday.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T10:00:00Z"));
		text = textOf(await pageBody(await open(TEAM, ada)));
		expect(text).toMatch(/bob@example\.com Not working today Not submitted/);

		text = textOf(await pageBody(await open(`${TEAM}?week=${WEEK}`, ada)));
		expect(text).toMatch(/bob@example\.com Not submitted 0:00 of 37:30 expected/);
		expect(text).not.toContain("Not working today");
	});
});
