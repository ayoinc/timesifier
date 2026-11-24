import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import { capacitySortIn, shareOf, sortByCapacity, standingOf } from "~/teams/capacity";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { type Crowd, insertAll, seedCrowd, seedWork, WEEK } from "../lists/crowd";
import { createOrganisation, seedMembership } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";
import { seedHoliday, seedLeave } from "./leave-seed";
import { markOvertime, seedEntry, seedProject } from "./periods-seed";
import { type Kind, seedRoles } from "./roles-seed";
import { seedAssignment, seedSchedule } from "./schedule-seed";

// Team › This week as a capacity table (TS-125, S2-08; decision 70): each
// person's week measured against what it expected of them, from their
// schedule less public holidays and approved leave, with a bar, over and under
// in words, and an order by the figures kept in `?sort=`, through #84's pages
// and after #91's pins.

const TEAM = "/app/acme/team";
const week = (query = "") => `${TEAM}?week=${WEEK}${query}`;

/** The ids of the people This week lists, in its order. */
function idsIn(html: string): string[] {
	return [...html.matchAll(/href="[^"?]*\?week=[0-9-]+&amp;person=([0-9a-f-]+)"/g)].map(
		(m) => m[1] ?? "",
	);
}

describe("the figures", () => {
	it("measure logged time against the expected, and say over and under in words", () => {
		expect(standingOf({ seconds: 0, expectedSeconds: 135_000 })).toBe("37:30 under");
		expect(standingOf({ seconds: 142_200, expectedSeconds: 135_000 })).toBe("2:00 over");
		expect(standingOf({ seconds: 135_030, expectedSeconds: 135_000 })).toBe("On capacity");
		expect(standingOf({ seconds: 0, expectedSeconds: 0 })).toBe("Nothing expected");
		expect(standingOf({ seconds: 3_600, expectedSeconds: 0 })).toBe("1:00 over, nothing expected");
		expect(shareOf({ seconds: 3_600, expectedSeconds: 0 })).toBeNull();
		expect(shareOf({ seconds: 50_400, expectedSeconds: 54_000 })).toBe(93);
	});

	it("order by name, logged, share and remaining, ties kept by name", () => {
		const people = [
			{ id: "a", seconds: 0, expectedSeconds: 100 },
			{ id: "b", seconds: 50, expectedSeconds: 0 },
			{ id: "c", seconds: 90, expectedSeconds: 100 },
			{ id: "d", seconds: 0, expectedSeconds: 100 },
			{ id: "e", seconds: 60, expectedSeconds: 50 },
		];
		const ids = (sort: Parameters<typeof sortByCapacity>[1]) =>
			sortByCapacity(people, sort).map((p) => p.id);
		expect(ids("name")).toEqual(["a", "b", "c", "d", "e"]);
		expect(ids("logged")).toEqual(["c", "e", "b", "a", "d"]);
		// Time where none was expected is above every share.
		expect(ids("share")).toEqual(["b", "e", "c", "a", "d"]);
		expect(ids("remaining")).toEqual(["a", "d", "c", "e", "b"]);
		expect(capacitySortIn(new URLSearchParams("sort=share"))).toBe("share");
		expect(capacitySortIn(new URLSearchParams("sort=bogus"))).toBe("name");
		expect(capacitySortIn(new URLSearchParams(""))).toBe("name");
	});
});

describe("This week as a capacity table", () => {
	let people: Record<Kind | "contractor" | "stranger", Person>;
	let acme: { id: string };

	/**
	 * In the week of 5 January 2026, on a default week of 37:30:
	 * - ada (owner) logs nothing;
	 * - grace (admin) logs 7:30 each weekday and 2:00 of overtime on Friday;
	 * - hedy (manager of linus) is away the afternoon of Friday, and logs 7:30 Monday to Thursday;
	 * - ida (a contractor) logs nothing;
	 * - katherine (Finance) logs 5:00 Monday to Thursday;
	 * - linus (member) works 5:00 Monday to Wednesday, and logs 5:00, 5:00 and 4:00.
	 */
	beforeEach(async () => {
		await freshDatabase();
		const mailbox = captureEmail();
		const seeded = await seedRoles(mailbox);
		acme = seeded.acme;
		const contractor = await person(mailbox, "ida@example.com");
		await seedMembership(acme.id, contractor.user.id, "member");
		await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
			.bind(contractor.user.id)
			.run();
		const stranger = await person(mailbox, "mallory@example.com");
		await createOrganisation(stranger.cookie, "Globex");
		people = { ...seeded.people, contractor, stranger };
		const { admin, manager, finance, member } = people;

		const project = await seedProject(acme.id, "Website");
		const days = ["05", "06", "07", "08", "09"].map((d) => `2026-01-${d}`);
		const log = (who: Person, day: string, from: string, to: string) =>
			seedEntry(acme.id, who.user.id, project, `${day}T${from}:00Z`, `${day}T${to}:00Z`);
		for (const day of days) await log(admin, day, "09:00", "16:30");
		await markOvertime(await log(admin, "2026-01-09", "16:30", "18:30"));
		for (const day of days.slice(0, 4)) await log(manager, day, "09:00", "16:30");
		await seedLeave(acme.id, manager.user.id, "annual", "2026-01-09", "2026-01-09", {
			startsHalf: true,
		});
		for (const day of days.slice(0, 4)) await log(finance, day, "09:00", "14:00");
		const partTime = await seedSchedule(acme.id, "Part time", [300, 300, 300, 0, 0, 0, 0]);
		await seedAssignment(acme.id, { kind: "person", id: member.user.id }, partTime);
		await log(member, "2026-01-05", "09:00", "14:00");
		await log(member, "2026-01-06", "09:00", "14:00");
		await log(member, "2026-01-07", "09:00", "13:00");
	}, 60_000);

	const text = async (path: string, who: Person) => {
		const response = await open(path, who);
		expect(response.status, path).toBe(200);
		return textOf(await pageBody(response));
	};
	const ids = async (path: string, who: Person = people.owner) => {
		const response = await open(path, who);
		expect(response.status, path).toBe(200);
		return idsIn(await response.text());
	};

	it("gives each person their week's expected hours, logged hours, and where they stand", async () => {
		const page = await text(week(), people.owner);
		// Full time, nothing logged.
		expect(page).toMatch(
			/ada ada@example\.com Not submitted 0:00 logged 37:30 expected Actions 37:30 under · 0% of capacity/,
		);
		// Full time, with overtime shown apart, over capacity.
		expect(page).toMatch(
			/grace grace@example\.com Not submitted 39:30 logged 37:30 \+ 2:00 overtime 37:30 expected Actions 2:00 over · 105% of capacity/,
		);
		// Half a day of leave takes 3:45 off the week.
		expect(page).toMatch(
			/hedy hedy@example\.com Not submitted Leave: Fri 9 Annual leave \(half day\) 30:00 logged 33:45 expected · 3:45 leave Actions 3:45 under · 89% of capacity/,
		);
		// Part time: three days of 5:00.
		expect(page).toMatch(
			/linus linus@example\.com Not submitted 14:00 logged 15:00 expected Actions 1:00 under · 93% of capacity Part time, Monday to Wednesday, 09:00–14:00 · 15:00 a week\. Assigned to them\./,
		);
		expect(page).toMatch(
			/Week's total 103:30 101:30 \+ 2:00 overtime 198:45 expected 95:15 under · 52% of capacity/,
		);
	});

	it("draws each week as a meter that reads out its figures, leave hatched, overtime past the end", async () => {
		const response = await open(week(), people.owner);
		const html = await response.text();
		const meter = (name: string) =>
			html.match(
				new RegExp(`<span role="meter" aria-label="${name}&#x27;s week"[^>]*>[\\s\\S]*?</span>`),
			)?.[0] ?? "";
		expect(meter("grace")).toContain('aria-valuetext="39:30 of 37:30 expected, 2:00 over"');
		expect(meter("grace")).toContain('aria-valuenow="100"');
		expect(meter("grace")).toContain('data-part="over"');
		expect(meter("hedy")).toContain('aria-valuetext="30:00 of 33:45 expected, 3:45 under"');
		expect(meter("hedy")).toContain('aria-valuenow="89"');
		expect(meter("hedy")).toContain('data-part="leave"');
		expect(meter("hedy")).not.toContain('data-part="over"');
		expect(meter("ada")).toContain('aria-valuenow="0"');
		expect(meter("ada")).not.toContain('data-part="logged"');
		// Drawn without a style attribute (docs/security.md).
		expect(meter("grace")).not.toContain("style=");
	});

	it("takes a public holiday off everyone's week, part time or not", async () => {
		await seedHoliday(acme.id, "2026-01-07", "Founders' Day");
		const page = await text(week(), people.owner);
		expect(page).toMatch(/ada@example\.com .*?0:00 logged 30:00 expected Actions 30:00 under/);
		expect(page).toMatch(
			/grace@example\.com .*?39:30 logged 37:30 \+ 2:00 overtime 30:00 expected Actions 9:30 over · 132% of capacity/,
		);
		expect(page).toMatch(
			/hedy@example\.com .*?30:00 logged 26:15 expected · 3:45 leave Actions 3:45 over · 114% of capacity/,
		);
		expect(page).toMatch(
			/linus@example\.com .*?14:00 logged 10:00 expected Actions 4:00 over · 140% of capacity/,
		);
	});

	it("orders the people by each key, kept in the address", async () => {
		const { owner, admin, manager, contractor, finance, member } = people;
		const [ada, grace, hedy, ida, katherine, linus] = [
			owner,
			admin,
			manager,
			contractor,
			finance,
			member,
		].map((p) => p.user.id);
		expect(await ids(week())).toEqual([ada, grace, hedy, ida, katherine, linus]);
		expect(await ids(week("&sort=name"))).toEqual([ada, grace, hedy, ida, katherine, linus]);
		expect(await ids(week("&sort=logged"))).toEqual([grace, hedy, katherine, linus, ada, ida]);
		expect(await ids(week("&sort=share"))).toEqual([grace, linus, hedy, katherine, ada, ida]);
		expect(await ids(week("&sort=remaining"))).toEqual([ada, ida, katherine, hedy, linus, grace]);
		expect(await ids(week("&sort=bogus"))).toEqual([ada, grace, hedy, ida, katherine, linus]);
		// The filter and the order go together.
		expect(await ids(week("&q=n&sort=logged"))).toEqual([katherine, linus]);

		// The arrows to other weeks keep the order; the Sort field shows it.
		const html = await (await open(week("&sort=remaining"), owner)).text();
		expect(html).toMatch(/href="\/app\/acme\/team\?week=2025-12-29&amp;sort=remaining"/);
		expect(html).toMatch(/<option value="remaining" selected="">Most remaining<\/option>/);
	});

	describe("who sees whom", () => {
		it.each(["owner", "admin"] as const)("shows the %s everybody", async (role) => {
			expect(await ids(week("&sort=share"), people[role])).toHaveLength(6);
		});

		it("shows a manager the people of their teams, and their total alone", async () => {
			const { manager, member } = people;
			const page = await text(week("&sort=remaining"), manager);
			expect(await ids(week("&sort=remaining"), manager)).toEqual([
				manager.user.id,
				member.user.id,
			]);
			expect(page).toMatch(/Week's total 44:00 48:45 expected 4:45 under · 90% of capacity/);
			expect(page).not.toContain("grace@example.com");
		});

		it.each(["finance", "member", "contractor", "stranger"] as const)(
			"is not there for a %s",
			async (role) => {
				expect((await open(week("&sort=share"), people[role])).status).toBe(404);
			},
		);
	});
});

describe("the order through the pages and after the pins", () => {
	let crowd: Crowd;
	let mostLogged: string[];

	/**
	 * The crowd's 150: the 147 others log 5:00 and the three who sign in 1:00.
	 * Person 100 logs 10:00 more and Person 140 5:00 more; the owner pins Person 120.
	 */
	beforeEach(async () => {
		await freshDatabase();
		crowd = await seedCrowd(captureEmail());
		await seedWork(crowd);
		const { acme, others, projects } = crowd;
		const now = Date.now();
		const extra = (id: string, hours: number) => {
			const start = Date.parse(`${WEEK}T16:00:00Z`);
			return [uuidv7(), acme.id, id, projects[0], start, start + hours * 3_600_000, WEEK, now, now];
		};
		await insertAll(
			"insert into time_entries (id, organisation_id, user_id, project_id, started_at, ended_at, spent_on, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[extra(others[99] ?? "", 10), extra(others[139] ?? "", 5)],
		);
		const pinned = await submit(
			TEAM,
			{ intent: "pin", userId: others[119] ?? "", pinned: "true" },
			crowd.owner,
			{ byScript: true },
		);
		expect(pinned.status).toBe(200);
		const rest = others.filter((_, i) => i !== 99 && i !== 119 && i !== 139);
		const signed = [crowd.owner, crowd.admin, crowd.manager].map((p) => p.user.id);
		mostLogged = [others[119] ?? "", others[99] ?? "", others[139] ?? "", ...rest, ...signed];
	}, 60_000);

	it("sorts all of them before taking a page, the pins first on page 1", async () => {
		const pages = await Promise.all(
			[1, 2, 3].map(async (n) =>
				idsIn(await (await open(week(`&sort=logged&page=${n}`), crowd.owner)).text()),
			),
		);
		expect(pages).toEqual([
			mostLogged.slice(0, 50),
			mostLogged.slice(50, 100),
			mostLogged.slice(100),
		]);

		const html = await (await open(week("&sort=logged&page=2"), crowd.owner)).text();
		expect(html).toMatch(/href="\/app\/acme\/team\?week=2026-01-05&amp;sort=logged&amp;page=3"/);
		expect(html).toMatch(/href="\/app\/acme\/team\?week=2026-01-05&amp;sort=logged"/);
		// The total is everyone's, on every page: 147 × 5:00, 3 × 1:00 and 15:00 more.
		expect(textOf(html)).toContain("Week's total, all 150 753:00");

		// Most remaining: the three who logged an hour, then the 5:00s; the pin still leads.
		const remaining = idsIn(await (await open(week("&sort=remaining"), crowd.owner)).text());
		expect(remaining.slice(0, 4)).toEqual([
			crowd.others[119],
			crowd.owner.user.id,
			crowd.admin.user.id,
			crowd.manager.user.id,
		]);
		const last = idsIn(await (await open(week("&sort=remaining&page=3"), crowd.owner)).text());
		expect(last.slice(-2)).toEqual([crowd.others[139], crowd.others[99]]);
	});

	it("adds up everyone's week in SQL, however many pages or whatever order", async () => {
		const statementsOf = async (path: string) => {
			const prepare = vi.spyOn(env.DB, "prepare");
			try {
				const response = await open(path, crowd.owner);
				expect(response.status).toBe(200);
				await response.text();
				return prepare.mock.calls.map(([sql]) => String(sql));
			} finally {
				prepare.mockRestore();
			}
		};
		const byName = await statementsOf(week());
		const byShare = await statementsOf(week("&sort=share&page=3"));
		const entries = (sql: string[]) => sql.filter((s) => /from "time_entries"/.test(s));
		const summed = (sql: string[]) => entries(sql).filter((s) => /sum\(/.test(s));
		// One sum grouped by person; the rest ask only whose timer runs (the
		// viewer's, for the bar, and the people's). No entry is read row by row.
		expect(summed(byName)).toHaveLength(1);
		expect(entries(byName)).toHaveLength(3);
		expect(
			entries(byName).filter(
				(s) => !/sum\(/.test(s) && !/"ended_at" is null\)+( limit \?)?$/.test(s),
			),
		).toEqual([]);
		// The same statements, sorted by a figure and on the last page.
		expect(byShare.length).toBe(byName.length);
		expect(summed(byShare)).toHaveLength(1);
	});
});
