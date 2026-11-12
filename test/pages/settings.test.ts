import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { membershipOf } from "~/organisations/membership.server";
import { periodContaining } from "~/periods/periods";
import { zoneOfMember } from "~/time/zones.server";
import { captureEmail, type Mailbox, post } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";

// Workspace settings of an organisation, /app/<slug>/settings: the
// organisation's name and its deletion, which the server allows by role, and
// which only owners and admins are shown. And My account, /app/<slug>/account:
// the person's own name and colour scheme, which every role opens. Every form
// is posted the way the page posts it.

const SETTINGS = "/app/acme/settings";
const ACCOUNT = "/app/acme/account";

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	// The first request to the Worker loads the whole application, which takes
	// longer than a hook is given by default.
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** A person who signs in and holds `role` in Acme. */
async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

/** What an action answered a form sent by script: its status and what it said. */
async function outcome(response: Response) {
	return { status: response.status, said: await response.text() };
}

const organisationName = () =>
	value<string>("select name from organisations where id = ?", acme.id);

describe("what the page shows", () => {
	it("to an owner: the name, Rename, and Delete organisation", async () => {
		const html = await pageBody(await open(SETTINGS, ada));
		const text = textOf(html);

		expect(html).toContain(">Workspace settings</h1>");
		expect(text).toContain("Shared by everyone in Acme. You are an owner.");
		expect(html).toMatch(/<button[^>]*>Rename<\/button>/);
		expect(html).toMatch(/<button[^>]*>Delete organisation<\/button>/);
	});

	it("to an admin: Rename, and no way to delete", async () => {
		const html = await pageBody(
			await open(SETTINGS, await memberOfAcme("admin", "grace@example.com")),
		);

		expect(textOf(html)).toContain("You are an admin.");
		expect(html).toMatch(/<button[^>]*>Rename<\/button>/);
		expect(textOf(html)).not.toContain("Delete organisation");
	});

	it("to a member: nothing, the same 404 as an organisation that is not theirs", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");

		expect((await open(SETTINGS, linus)).status).toBe(404);
		expect((await open(ACCOUNT, linus)).status).toBe(200);
	});

	it("keeps the organisation's settings and the person's own on separate pages", async () => {
		const settings = await pageBody(await open(SETTINGS, ada));
		const account = await pageBody(await open(ACCOUNT, ada));

		expect(settings).toContain(">General</h2>");
		expect(settings).not.toContain(">Your account</h2>");
		expect(account).toContain(">My account</h1>");
		const yours = account.indexOf(">Your account</h2>");
		expect(yours).toBeGreaterThan(-1);
		// The colour scheme and signing out everywhere follow it, each a ruled section
		// like every other on the page (audit W25): one heading level, no sub-headings.
		for (const heading of ["Appearance", "Sign out everywhere"]) {
			expect(account.indexOf(`>${heading}</h2>`), heading).toBeGreaterThan(yours);
		}
		expect(account).not.toContain("</h3>");
		// Signing out of this browser alone is in the profile menu, not on the page (TS-063).
		expect(account).not.toContain(">Sign out</h2>");
		expect(textOf(account)).not.toContain("Delete organisation");
	});

	it("shows the person by their address until they have given a name", async () => {
		expect(textOf(await pageBody(await open(ACCOUNT, ada)))).toContain(
			"Not set. People see your address, ada@example.com.",
		);
	});
});

describe("renaming the organisation", () => {
	it.each(["owner", "admin"] as const)("an %s renames it, and its address stays", async (role) => {
		const who = role === "owner" ? ada : await memberOfAcme(role, "grace@example.com");

		const response = await outcome(
			await submit(SETTINGS, { intent: "rename", name: "  Acme Ltd " }, who, { byScript: true }),
		);

		expect(response.status).toBe(200);
		expect(response.said).toContain("The organisation is now called Acme Ltd.");
		expect(await row("select name, slug from organisations")).toEqual({
			name: "Acme Ltd",
			slug: "acme",
		});
		expect(textOf(await pageBody(await open(SETTINGS, who)))).toContain(
			"Shared by everyone in Acme Ltd.",
		);
	});

	it("a member who posts the form of a page they are not shown gets 404, and nothing changes", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");

		const response = await submit(SETTINGS, { intent: "rename", name: "Linus Ltd" }, linus, {
			byScript: true,
		});

		expect(response.status).toBe(404);
		expect(await organisationName()).toBe("Acme");
	});

	it("renames the organisation in the address, whatever the form names", async () => {
		const grace = await person(mailbox, "grace@example.com");
		const initech = await createOrganisation(grace.cookie, "Initech");

		const response = await submit(
			SETTINGS,
			{ intent: "rename", name: "Mine now", organizationId: initech.id, slug: "initech" },
			ada,
			{ byScript: true },
		);

		expect(response.status).toBe(200);
		expect(await organisationName()).toBe("Mine now");
		expect(await value("select name from organisations where id = ?", initech.id)).toBe("Initech");
	});
});

describe("deleting the organisation", () => {
	it("an owner who types its name deletes it, and is sent to /app", async () => {
		const response = await submit(SETTINGS, { intent: "delete", confirmation: "Acme" }, ada);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/app");
		expect(await value("select count(*) from organisations")).toBe(0);
		expect(await value("select count(*) from memberships")).toBe(0);
		expect((await open(SETTINGS, ada)).status).toBe(404);
		// With no organisation left, /app sends them to create one.
		expect((await open("/app", ada)).headers.get("Location")).toBe("/app/new");
	});

	it.each([
		["nothing", ""],
		["another name", "Globex"],
		["the name in other letters", "acme"],
		["part of the name", "Acm"],
	])("typing %s deletes nothing and says why", async (_case, confirmation) => {
		const response = await outcome(
			await submit(SETTINGS, { intent: "delete", confirmation }, ada, { byScript: true }),
		);

		expect(response.status).toBe(400);
		expect(response.said).toContain("That is not the organisation's name.");
		expect(await value("select count(*) from organisations")).toBe(1);
	});

	it("an admin who types its name is refused by the server", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");

		const response = await outcome(
			await submit(SETTINGS, { intent: "delete", confirmation: "Acme" }, grace, { byScript: true }),
		);

		expect(response.status).toBe(403);
		expect(response.said).toContain("Your role in this organisation does not allow that.");
		expect(await value("select count(*) from organisations")).toBe(1);
		expect(await value("select count(*) from memberships")).toBe(2);
	});

	it("a member who types its name gets 404, and nothing is deleted", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");

		const response = await submit(SETTINGS, { intent: "delete", confirmation: "Acme" }, linus, {
			byScript: true,
		});

		expect(response.status).toBe(404);
		expect(await value("select count(*) from organisations")).toBe(1);
		expect(await value("select count(*) from memberships")).toBe(2);
	});
});

describe("a person's name", () => {
	/** Everything the database holds about Ada. */
	const stored = () => row("select * from users where id = ?", ada.user.id);

	it("is changed by the action, trimmed, and shown on My account", async () => {
		const response = await outcome(
			await submit(ACCOUNT, { intent: "name", name: "  Ada Lovelace " }, ada, { byScript: true }),
		);

		expect(response.status).toBe(200);
		expect(response.said).toContain("Your name is now Ada Lovelace.");
		expect((await stored())?.name).toBe("Ada Lovelace");
		const text = textOf(await pageBody(await open(ACCOUNT, ada)));
		expect(text).toContain("Ada Lovelace");
		expect(text).not.toContain("Not set.");
	});

	it("changes the name and nothing else, whatever the form holds", async () => {
		const before = await stored();
		const sessions = await value("select count(*) from sessions where user_id = ?", ada.user.id);

		const response = await submit(
			ACCOUNT,
			{
				intent: "name",
				name: "Ada",
				email: "mallory@example.com",
				emailVerified: "false",
				email_verified: "0",
				image: "https://attacker.example/a.png",
				id: "someone-else",
				role: "owner",
				createdAt: "0",
			},
			ada,
			{ byScript: true },
		);

		expect(response.status).toBe(200);
		const { updated_at: _then, ...unchanged } = before ?? {};
		const { updated_at: _now, ...after } = (await stored()) ?? {};
		expect(after).toEqual({ ...unchanged, name: "Ada" });
		expect(await value("select id from users where email = ?", "ada@example.com")).toBe(
			ada.user.id,
		);
		expect(await value("select count(*) from users")).toBe(1);
		expect(await value("select count(*) from sessions where user_id = ?", ada.user.id)).toBe(
			sessions,
		);
	});

	it("is the only way to change it: the mount does not offer the endpoint that changes a person", async () => {
		const response = await post("/update-user", { name: "Mallory", image: "x" }, ada);

		expect(response.status).toBe(404);
		expect((await stored())?.name).toBe("");
	});

	it("changes the name of the person signed in, and of nobody else", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");

		await submit(ACCOUNT, { intent: "name", name: "Grace Hopper" }, grace, { byScript: true });

		expect(await value("select name from users where id = ?", grace.user.id)).toBe("Grace Hopper");
		expect((await stored())?.name).toBe("");
	});

	it.each([
		["nothing", ""],
		["spaces alone", "   "],
		["101 characters", "a".repeat(101)],
		["a line break", "Ada\nLovelace"],
		["a character that reverses the text", "Ada \u202E ecalevoL"],
	])("refuses a name that is %s with 400 and changes nothing", async (_case, name) => {
		const response = await submit(ACCOUNT, { intent: "name", name }, ada, { byScript: true });

		expect(response.status).toBe(400);
		expect((await stored())?.name).toBe("");
	});

	it("takes a name of exactly 100 characters", async () => {
		const name = "a".repeat(100);

		const response = await submit(ACCOUNT, { intent: "name", name }, ada, { byScript: true });

		expect(response.status).toBe(200);
		expect((await stored())?.name).toBe(name);
	});

	it("keeps the session working after the change, and the profile menu takes the name", async () => {
		await submit(ACCOUNT, { intent: "name", name: "Ada" }, ada, { byScript: true });

		const page = await open(ACCOUNT, ada);
		expect(page.status).toBe(200);
		expect(await pageBody(page)).toContain('aria-label="Account menu for Ada, A"');
	});
});

describe("the colour scheme, which My account holds in an organisation", () => {
	it("is still stored by the form the page posts", async () => {
		const response = await submit(ACCOUNT, { scheme: "dark" }, ada);

		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe(ACCOUNT);
		expect(response.headers.getSetCookie()).toEqual([
			"__Host-color-scheme=dark; Max-Age=31536000; Path=/; Secure; SameSite=Lax",
		]);
	});
});

describe("the general settings: default time zone, week start and Clients (TS-048)", () => {
	const organisationRow = () =>
		row(
			"select time_zone, week_starts_on, clients_enabled from organisations where id = ?",
			acme.id,
		);

	it.each(["owner", "admin"] as const)(
		"a %s sees them and changes each, and the page shows the new values",
		async (role) => {
			const who = role === "owner" ? ada : await memberOfAcme(role, "grace@example.com");
			let text = textOf(await pageBody(await open(SETTINGS, who)));
			expect(text).toContain("UTC");
			expect(text).toContain("Monday");
			expect(text).toContain("Clients");

			for (const [fields, said] of [
				[{ intent: "time-zone", timeZone: "America/New_York" }, "America/New York"],
				[{ intent: "week-start", weekStartsOn: "7" }, "Weeks now start on Sunday."],
				[{ intent: "clients" }, "Clients is off. Nothing was deleted"],
			] as const) {
				const answer = await outcome(await submit(SETTINGS, fields, who, { byScript: true }));
				expect(answer.status).toBe(200);
				expect(answer.said).toContain(said);
			}
			expect(await organisationRow()).toEqual({
				time_zone: "America/New_York",
				week_starts_on: 7,
				clients_enabled: 0,
			});
			text = textOf(await pageBody(await open(SETTINGS, who)));
			expect(text).toContain("America/New York");
			expect(text).toContain("Sunday");

			await submit(SETTINGS, { intent: "clients", clientsEnabled: "on" }, who, { byScript: true });
			expect((await organisationRow())?.clients_enabled).toBe(1);
		},
	);

	it("a member and a manager cannot change them: the page and its forms are 404, and nothing changes", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const mary = await memberOfAcme("member", "mary@example.com");
		await seedTeam(acme.id, "Design", { members: [linus.user.id], managers: [mary.user.id] });

		for (const who of [linus, mary]) {
			expect((await open(SETTINGS, who)).status).toBe(404);
			for (const fields of [
				{ intent: "time-zone", timeZone: "Asia/Tokyo" },
				{ intent: "week-start", weekStartsOn: "3" },
				{ intent: "clients" },
			] as Record<string, string>[]) {
				expect((await submit(SETTINGS, fields, who, { byScript: true })).status).toBe(404);
			}
		}
		expect(await organisationRow()).toEqual({
			time_zone: "UTC",
			week_starts_on: 1,
			clients_enabled: 1,
		});
	});

	it.each([
		["an unknown zone", { intent: "time-zone", timeZone: "Mars/Olympus" }],
		["a day that is no weekday", { intent: "week-start", weekStartsOn: "8" }],
		["no day", { intent: "week-start", weekStartsOn: "0" }],
	])("refuses %s with 400 and changes nothing", async (_, fields) => {
		const response = await submit(SETTINGS, fields, ada, { byScript: true });
		expect(response.status).toBe(400);
		expect(await organisationRow()).toEqual({
			time_zone: "UTC",
			week_starts_on: 1,
			clients_enabled: 1,
		});
	});

	it("the week start is the one every period starts on", async () => {
		await submit(SETTINGS, { intent: "week-start", weekStartsOn: "7" }, ada, { byScript: true });
		const weekStartsOn = await value<number>(
			"select week_starts_on from organisations where id = ?",
			acme.id,
		);
		// 2026-11-11 is a Wednesday.
		expect(periodContaining("2026-11-11", weekStartsOn ?? 0)).toEqual({
			startsOn: "2026-11-08",
			endsOn: "2026-11-14",
		});
	});

	it("the default time zone is the zone of a person who has not chosen one", async () => {
		await submit(SETTINGS, { intent: "time-zone", timeZone: "Asia/Tokyo" }, ada, {
			byScript: true,
		});
		const membership = await membershipOf(
			{ id: ada.user.id } as Parameters<typeof membershipOf>[0],
			"acme",
		);
		expect(membership && (await zoneOfMember(membership))).toBe("Asia/Tokyo");
	});

	it("Clients off hides the link and 404s the page for everyone, and deletes nothing; on brings them back", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		await submit("/app/acme/clients", { intent: "create", name: "Globex" }, ada, {
			byScript: true,
		});
		await submit(SETTINGS, { intent: "clients" }, ada, { byScript: true });

		for (const who of [ada, grace]) {
			const html = await pageBody(await open(SETTINGS, who));
			expect(html).not.toMatch(/<a[^>]*href="\/app\/acme\/clients"/);
			expect((await open("/app/acme/clients", who)).status).toBe(404);
		}
		expect(await value("select count(*) from clients")).toBe(1);

		await submit(SETTINGS, { intent: "clients", clientsEnabled: "on" }, grace, { byScript: true });
		expect(await pageBody(await open(SETTINGS, ada))).toMatch(/<a[^>]*href="\/app\/acme\/clients"/);
		expect(textOf(await pageBody(await open("/app/acme/clients", ada)))).toContain("Globex");
	});
});

describe("the working week, the kinds of leave and the public holidays (TS-061)", () => {
	const kindOf = (key: string) =>
		value<string>("select id from leave_kinds where organisation_id = ? and key = ?", acme.id, key);
	const kindRow = (key: string) =>
		row(
			"select name, enabled, needs_approval, allowance_half_days from leave_kinds where organisation_id = ? and key = ?",
			acme.id,
			key,
		);
	const holidays = async () =>
		(
			await env.DB.prepare(
				"select day, name from public_holidays where organisation_id = ? order by day",
			)
				.bind(acme.id)
				.all()
		).results;
	it("are shown to an owner and an admin, with the default work schedule, and each person's schedule on their My account (TS-097)", async () => {
		const grace = await memberOfAcme("admin", "grace@example.com");
		for (const who of [ada, grace]) {
			const text = textOf(await pageBody(await open(SETTINGS, who)));
			expect(text).toContain("Work schedules");
			expect(text).toContain(
				"Standard Default Everyone without another schedule Monday to Friday, 09:00–17:30 · 37:30 a week",
			);
			expect(text).toContain("Annual leave");
			expect(text).toContain("Public holiday");
			expect(text).toContain("No public holidays are set.");
		}
		const linus = await memberOfAcme("member", "linus@example.com");
		const text = textOf(await pageBody(await open(ACCOUNT, linus)));
		expect(text).toContain("Your work schedule");
		expect(text).toContain(
			"Standard: Monday to Friday, 09:00–17:30 · 37:30 a week. The organisation's default.",
		);
		expect(text).toMatch(
			/Monday 09:00–17:30, 1:00 break · 7:30 .*Saturday Not a working day Sunday Not a working day/,
		);
	});

	it("no longer takes the working week: schedules are set on their own page", async () => {
		const fields = { intent: "working-week", day1: "8" };
		expect((await submit(SETTINGS, fields, ada, { byScript: true })).status).toBe(400);
	});

	it.each(["owner", "admin"] as const)(
		"an %s renames a kind, switches it off, says it needs no approval and sets its allowance",
		async (role) => {
			const who = role === "owner" ? ada : await memberOfAcme("admin", "grace@example.com");
			const answer = await outcome(
				await submit(
					SETTINGS,
					{
						intent: "kind",
						kindId: (await kindOf("study")) ?? "",
						name: " Training ",
						allowanceDays: "5.5",
					},
					who,
					{ byScript: true },
				),
			);
			expect(answer.status).toBe(200);
			expect(answer.said).toContain("Training is saved.");
			expect(await kindRow("study")).toEqual({
				name: "Training",
				enabled: 0,
				needs_approval: 0,
				allowance_half_days: 11,
			});

			await submit(
				SETTINGS,
				{
					intent: "kind",
					kindId: (await kindOf("annual")) ?? "",
					name: "Annual leave",
					enabled: "on",
					needsApproval: "on",
					allowanceDays: "",
				},
				who,
				{ byScript: true },
			);
			expect(await kindRow("annual")).toEqual({
				name: "Annual leave",
				enabled: 1,
				needs_approval: 1,
				allowance_half_days: null,
			});
		},
	);

	it("never gives public holidays an allowance or a decision", async () => {
		const answer = await outcome(
			await submit(
				SETTINGS,
				{
					intent: "kind",
					kindId: (await kindOf("holiday")) ?? "",
					name: "Bank holiday",
					enabled: "on",
					needsApproval: "on",
					allowanceDays: "8",
				},
				ada,
				{ byScript: true },
			),
		);
		expect(answer.status).toBe(200);
		expect(await kindRow("holiday")).toEqual({
			name: "Bank holiday",
			enabled: 1,
			needs_approval: 0,
			allowance_half_days: null,
		});
	});

	it.each([
		["an allowance that is not a number", { allowanceDays: "lots" }],
		["an allowance of a quarter day", { allowanceDays: "2.25" }],
		["an allowance over a year", { allowanceDays: "366" }],
		["no name", { name: "  " }],
		["a name too long", { name: "x".repeat(61) }],
	])("refuses %s, and changes nothing", async (_, change) => {
		const fields = {
			intent: "kind",
			kindId: (await kindOf("annual")) ?? "",
			name: "Annual leave",
			enabled: "on",
			needsApproval: "on",
			allowanceDays: "25",
			...change,
		};
		expect((await submit(SETTINGS, fields, ada, { byScript: true })).status).toBe(400);
		expect(await kindRow("annual")).toEqual({
			name: "Annual leave",
			enabled: 1,
			needs_approval: 1,
			allowance_half_days: 50,
		});
	});

	it("does not change a kind of another organisation", async () => {
		const other = await createOrganisation(ada.cookie, "Other");
		const theirs = await value<string>(
			"select id from leave_kinds where organisation_id = ? and key = 'annual'",
			other.id,
		);
		const response = await submit(
			SETTINGS,
			{ intent: "kind", kindId: theirs ?? "", name: "Stolen", enabled: "on" },
			ada,
			{ byScript: true },
		);
		expect(response.status).toBe(404);
		expect(await value("select name from leave_kinds where id = ?", theirs)).toBe("Annual leave");
	});

	it.each(["owner", "admin"] as const)(
		"an %s adds a public holiday, once a day, and removes it",
		async (role) => {
			const who = role === "owner" ? ada : await memberOfAcme("admin", "grace@example.com");
			const added = await outcome(
				await submit(
					SETTINGS,
					{ intent: "add-holiday", day: "2026-12-25", name: "Christmas Day" },
					who,
					{ byScript: true },
				),
			);
			expect(added.status).toBe(200);
			expect(added.said).toContain("Christmas Day is a public holiday.");
			expect(await holidays()).toEqual([{ day: "2026-12-25", name: "Christmas Day" }]);
			expect(textOf(await pageBody(await open(SETTINGS, who)))).toContain(
				"Christmas Day 25 December 2026",
			);

			const again = await submit(
				SETTINGS,
				{ intent: "add-holiday", day: "2026-12-25", name: "Christmas" },
				who,
				{ byScript: true },
			);
			expect(again.status).toBe(409);
			expect(
				(
					await submit(
						SETTINGS,
						{ intent: "add-holiday", day: "2026-02-30", name: "No day" },
						who,
						{
							byScript: true,
						},
					)
				).status,
			).toBe(400);

			const id = await value<string>(
				"select id from public_holidays where organisation_id = ?",
				acme.id,
			);
			const removed = await outcome(
				await submit(SETTINGS, { intent: "remove-holiday", holidayId: id ?? "" }, who, {
					byScript: true,
				}),
			);
			expect(removed.status).toBe(200);
			expect(removed.said).toContain("Public holiday removed.");
			expect(await holidays()).toEqual([]);
			expect(
				(
					await submit(SETTINGS, { intent: "remove-holiday", holidayId: id ?? "" }, who, {
						byScript: true,
					})
				).status,
			).toBe(404);
		},
	);

	it("a member and a manager change none of it, and the page stays 404", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const mary = await memberOfAcme("member", "mary@example.com");
		await seedTeam(acme.id, "Design", { members: [linus.user.id], managers: [mary.user.id] });
		await submit(
			SETTINGS,
			{ intent: "add-holiday", day: "2026-12-25", name: "Christmas Day" },
			ada,
			{
				byScript: true,
			},
		);
		const holidayId = await value<string>(
			"select id from public_holidays where organisation_id = ?",
			acme.id,
		);

		for (const who of [linus, mary]) {
			const forms: Record<string, string>[] = [
				{ intent: "kind", kindId: (await kindOf("annual")) ?? "", name: "Mine", enabled: "on" },
				{ intent: "add-holiday", day: "2026-12-26", name: "Boxing Day" },
				{ intent: "remove-holiday", holidayId: holidayId ?? "" },
			];
			for (const fields of forms) {
				expect(
					(await submit(SETTINGS, fields, who, { byScript: true })).status,
					fields.intent,
				).toBe(404);
			}
		}
		expect((await kindRow("annual"))?.name).toBe("Annual leave");
		expect(await holidays()).toEqual([{ day: "2026-12-25", name: "Christmas Day" }]);
	});
});
