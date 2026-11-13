import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { dayOf } from "~/time/calendar";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam } from "../organisations/harness";
import { parseCsv } from "../reports/csv";
import { open, openData, type Person, pageBody, person, textOf } from "./harness";
import { seedHoliday, seedLeave } from "./leave-seed";

// Reports (TS-014a) and their export as CSV (TS-014b), at /app/<slug>/reports
// and /app/<slug>/reports/export, through the Worker. Whose time a report
// holds is the viewer's to see: an owner's or admin's everyone's, a manager's
// their own and their teams' people's, a member's their own. Another
// organisation's address is the same 404 as any (test/pages/isolation.test.ts).

const REPORTS = "/app/acme/reports";
const EXPORT = "/app/acme/reports/export";
/** Monday 5 to Sunday 11 October 2026: a week in the past, so the clock does not move it. */
const WEEK = "range=custom&from=2026-10-05&to=2026-10-11";
const HOUR = 3600;

let mailbox: Mailbox;
let acme: { id: string };
let scope: OrganisationScope;
let ada: Person;
let grace: Person;
let hedy: Person;
let linus: Person;
let mallory: Person;
let site: string;
let billing: string;

async function track(
	who: Person,
	projectId: string,
	from: string,
	to: string | null,
	description = "Work",
	zone = "UTC",
) {
	// Its day, as its writer stores it: the one it starts on in `zone` (TS-111).
	await scope.timeEntries.insert({
		userId: who.user.id,
		projectId,
		description,
		startedAt: new Date(from),
		spentOn: dayOf(Date.parse(from), zone),
		endedAt: to === null ? null : new Date(to),
	});
}

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	grace = await person(mailbox, "grace@example.com");
	hedy = await person(mailbox, "hedy@example.com");
	linus = await person(mailbox, "linus@example.com");
	mallory = await person(mailbox, "mallory@example.com");
	await seedMembership(acme.id, grace.user.id, "admin");
	await seedMembership(acme.id, hedy.user.id, "member");
	await seedMembership(acme.id, linus.user.id, "member");
	await seedMembership(acme.id, mallory.user.id, "member");
	// Hedy manages Design, which Linus is in. Mallory is in no team.
	await seedTeam(acme.id, "Design", { members: [linus.user.id], managers: [hedy.user.id] });

	const [initech] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	const [p1, p2] = await scope.projects.insert([
		{ name: "Site", nameKey: "site", clientId: initech?.id ?? null },
		{ name: "Billing", nameKey: "billing" },
	]);
	if (!p1 || !p2) throw new Error("seed failed");
	site = p1.id;
	billing = p2.id;

	await track(ada, site, "2026-10-05T09:00:00Z", "2026-10-05T10:00:00Z");
	await track(hedy, billing, "2026-10-06T09:00:00Z", "2026-10-06T11:00:00Z");
	// Across midnight in UTC: two hours, counted whole on the Tuesday it starts.
	await track(linus, site, "2026-10-06T23:00:00Z", "2026-10-07T01:00:00Z");
	await track(mallory, billing, "2026-10-08T10:00:00Z", "2026-10-08T13:00:00Z");
	// The Monday after the week: in no report of it.
	await track(linus, site, "2026-10-12T09:00:00Z", "2026-10-12T10:00:00Z");
	// The first request to the Worker loads the whole application, which takes
	// longer than a hook is given by default.
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** The export of the report at `query`, as rows keyed by column, after its byte order mark and header. */
async function exported(who: Person, query: string) {
	const response = await open(`${EXPORT}?${query}`, who);
	expect(response.status).toBe(200);
	const bytes = new Uint8Array(await response.arrayBuffer());
	expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	const [header, ...rows] = parseCsv(
		new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.slice(3)),
	);
	expect(header).toEqual([
		"entry_id",
		"person",
		"project",
		"client",
		"description",
		"started_at",
		"ended_at",
		"duration_seconds",
		"overtime",
	]);
	return {
		response,
		rows: rows.map((cells) => Object.fromEntries(header?.map((name, i) => [name, cells[i]]) ?? [])),
	};
}

const secondsOf = (rows: Record<string, string | undefined>[]) =>
	rows.reduce((sum, row) => sum + Number(row.duration_seconds), 0);

/** The total a report page shows, as "h:mm". */
async function pageTotal(who: Person, query: string): Promise<string> {
	const response = await open(`${REPORTS}?${query}`, who);
	expect(response.status).toBe(200);
	const text = textOf(await pageBody(response));
	// The headline, the largest figure, read first; the sheet's total under the heavy rule ends the "By" sheet.
	const total = /Total: (\d+:\d\d)/.exec(text)?.[1];
	if (total === undefined) throw new Error("The page shows no total.");
	const sheet = /By [a-z]+ .*? Total (\d+:\d\d) Billable /.exec(text)?.[1];
	expect(sheet).toBe(total);
	return total;
}

describe("whose time a report holds", () => {
	it.each([
		["an owner", () => ada, ["ada", "hedy", "linus", "mallory"], "8:00"],
		["an admin", () => grace, ["ada", "hedy", "linus", "mallory"], "8:00"],
		["a manager: their own and their team's people", () => hedy, ["hedy", "linus"], "4:00"],
		["a member: their own", () => linus, ["linus"], "2:00"],
		["a member in no team: their own", () => mallory, ["mallory"], "3:00"],
	])("%s", async (_, who, people, total) => {
		const { rows } = await exported(who(), WEEK);
		expect(rows.map((row) => row.person?.split("@")[0]).sort()).toEqual(people);
		// The page and the export hold the same rows.
		expect(await pageTotal(who(), WEEK)).toBe(`${secondsOf(rows) / HOUR}:00`);
		expect(await pageTotal(who(), WEEK)).toBe(total);
	});

	it("narrows to one person the viewer may see", async () => {
		const { rows } = await exported(ada, `${WEEK}&person=${linus.user.id}`);
		expect(rows.map((row) => row.person)).toEqual(["linus@example.com"]);
		expect(await pageTotal(hedy, `${WEEK}&person=${linus.user.id}`)).toBe("2:00");
		expect(await pageTotal(hedy, `${WEEK}&person=${hedy.user.id}`)).toBe("2:00");
	});

	it.each([
		["a manager asking for a person outside their teams", () => hedy, () => mallory],
		["a member asking for anybody else", () => linus, () => ada],
		["a member asking for their manager", () => linus, () => hedy],
	])("is 404 for %s, page, data and export alike", async (_, who, whom) => {
		const query = `${WEEK}&person=${whom().user.id}`;
		expect((await open(`${REPORTS}?${query}`, who())).status).toBe(404);
		expect((await openData(`${REPORTS}?${query}`, who())).status).toBe(404);
		expect((await open(`${EXPORT}?${query}`, who())).status).toBe(404);
	});

	it("offers a person field only to those who may see more than their own", async () => {
		const html = (who: Person) => open(`${REPORTS}?${WEEK}`, who).then(pageBody);
		expect(await html(ada)).toContain(">Person<");
		expect(await html(hedy)).toContain(">Person<");
		expect(await html(linus)).not.toContain(">Person<");
	});

	it("holds nothing of another organisation", async () => {
		const globex = await createOrganisation(ada.cookie, "Globex");
		const theirs = organisationScope(env.DB, globex.id);
		const [project] = await theirs.projects.insert({ name: "Secret", nameKey: "secret" });
		if (!project) throw new Error("seed failed");
		await theirs.timeEntries.insert({
			userId: ada.user.id,
			projectId: project.id,
			description: "Elsewhere",
			startedAt: new Date("2026-10-05T12:00:00Z"),
			spentOn: dayOf(Date.parse("2026-10-05T12:00:00Z"), "UTC"),
			endedAt: new Date("2026-10-05T13:00:00Z"),
		});
		const { rows } = await exported(ada, WEEK);
		expect(rows.map((row) => row.project)).not.toContain("Secret");
		expect(secondsOf(rows)).toBe(8 * HOUR);
	});
});

describe("the stepper beside the range (TS-059, TS-091)", () => {
	/** The addresses of Previous and Next on the report at `query`, as `who` sees it. */
	async function steps(who: Person, query: string) {
		const html = await pageBody(await open(`${REPORTS}?${query}`, who));
		const step = (word: string) => {
			const tag = new RegExp(`<a [^>]*aria-label="${word} [^"]*"[^>]*>`).exec(html)?.[0] ?? "";
			return /href="([^"]+)"/
				.exec(tag)?.[1]
				?.replaceAll("&amp;", "&")
				.slice(REPORTS.length + 1);
		};
		// The stepper's own links: ‹ the range › and the way back to today.
		const stepper = /aria-label="Report range".*?<\/div>/s.exec(html)?.[0] ?? "";
		return { html, stepper, text: textOf(html), previous: step("Previous"), next: step("Next") };
	}

	it("moves a custom range by its number of days, keeping the grouping and the person", async () => {
		const here = await steps(ada, `${WEEK}&group=day&person=${linus.user.id}`);
		expect(here.html).toContain('aria-label="Previous 7 days"');
		expect(here.previous).toBe(
			`range=custom&from=2026-09-28&to=2026-10-04&group=day&person=${linus.user.id}`,
		);
		expect(here.next).toBe(
			`range=custom&from=2026-10-12&to=2026-10-18&group=day&person=${linus.user.id}`,
		);
		// The report follows the address: Linus's Monday after the week.
		expect(await pageTotal(ada, here.next ?? "")).toBe("1:00");
		expect(await pageTotal(ada, here.previous ?? "")).toBe("0:00");
	});

	it("moves a week by a week", async () => {
		const here = await steps(ada, "range=week&from=2026-10-07");
		expect(here.text).toContain("5–11 October 2026");
		expect(here.html).toContain('aria-label="Next week"');
		// Away from this week, the way back to it.
		expect(here.stepper).toMatch(/href="[^"]*range=this-week[^"]*"[^>]*>This week</);
		expect(here.previous).toBe("range=week&from=2026-09-28&group=project");
		expect(here.next).toBe("range=week&from=2026-10-12&group=project");
		expect(await pageTotal(ada, "range=week&from=2026-10-07")).toBe("8:00");
		expect(await pageTotal(ada, here.next ?? "")).toBe("1:00");
	});

	it("moves a month that ends on the 31st by a calendar month, to one of 30 days", async () => {
		const october = await steps(ada, "range=month&from=2026-10-31");
		expect(october.text).toContain("1–31 October 2026");
		expect(october.html).toContain('aria-label="Next month"');
		expect(october.previous).toBe("range=month&from=2026-09-01&group=project");
		expect(october.next).toBe("range=month&from=2026-11-01&group=project");
		expect(await pageTotal(ada, "range=month&from=2026-10-31")).toBe("9:00");

		const november = await steps(ada, october.next ?? "");
		expect(november.text).toContain("1–30 November 2026");
		expect(november.previous).toBe("range=month&from=2026-10-01&group=project");
	});

	it("moves this week and this month from today", async () => {
		const today = dayOf(Date.now(), "UTC");
		const thisMonth = await steps(ada, "range=this-month");
		const month = Number(today.slice(5, 7));
		const before =
			month === 1
				? `${Number(today.slice(0, 4)) - 1}-12`
				: `${today.slice(0, 4)}-${String(month - 1).padStart(2, "0")}`;
		expect(thisMonth.previous).toBe(`range=month&from=${before}-01&group=project`);
		const thisWeek = await steps(ada, "range=this-week");
		expect(thisWeek.previous).toMatch(/^range=week&from=\d{4}-\d\d-\d\d&group=project$/);
		// Already at this week: no way back to it.
		expect(thisWeek.stepper).toContain("Previous week");
		expect(thisWeek.stepper).not.toContain("This week");
	});

	it.each([
		["an owner", () => ada, "1:00"],
		["an admin", () => grace, "1:00"],
		["a manager: their team's person", () => hedy, "1:00"],
		["a member: their own", () => linus, "1:00"],
		["a member with nothing in it", () => mallory, "0:00"],
	])("holds, for %s, only the time they may see in the range stepped to", async (_, who, total) => {
		const { next } = await steps(who(), WEEK);
		expect(next).toBe("range=custom&from=2026-10-12&to=2026-10-18&group=project");
		expect(await pageTotal(who(), next ?? "")).toBe(total);
		// The export of the range stepped to holds the same.
		const { rows } = await exported(who(), next ?? "");
		expect(`${secondsOf(rows) / HOUR}:00`).toBe(total);
	});
});

describe("a report", () => {
	it("counts an entry of 21:33 to 02:33 whole on the day it starts, by day and in one CSV row", async () => {
		await track(mallory, site, "2026-10-09T21:33:00Z", "2026-10-10T02:33:00Z", "Late");
		const { rows } = await exported(mallory, WEEK);
		expect(
			rows
				.filter((row) => row.description === "Late")
				.map((row) => [row.started_at, row.ended_at, row.duration_seconds]),
		).toEqual([["2026-10-09T21:33:00Z", "2026-10-10T02:33:00Z", "18000"]]);
		const page = textOf(await pageBody(await open(`${REPORTS}?${WEEK}&group=day`, mallory)));
		expect(page).toContain("Friday 9 October 5:00");
		expect(page).not.toContain("Saturday 10 October");
		expect(page).toContain("Total 8:00");
		// The page lists it once, on its first day, as the export does.
		expect(page.match(/Late/g)).toHaveLength(1);
	});

	it("counts each entry on its stored day, whatever the zone of whoever reads it now", async () => {
		await env.DB.prepare("update organisations set time_zone = 'Pacific/Auckland' where id = ?")
			.bind(acme.id)
			.run();
		await env.DB.prepare("update users set time_zone = 'America/New_York' where id = ?")
			.bind(linus.user.id)
			.run();
		// 23:00 to 01:00 UTC, stored on Tuesday the 6th: one row, on the Tuesday.
		const { rows } = await exported(linus, WEEK);
		expect(rows.map((row) => row.duration_seconds)).toEqual(["7200"]);
		const inNewYork = textOf(await pageBody(await open(`${REPORTS}?${WEEK}&group=day`, linus)));
		expect(inNewYork).toContain("Tuesday 6 October 2:00");
		expect(inNewYork).toContain("America/New_York");

		// A change of zone moves nothing already tracked (decision 39).
		await env.DB.prepare("update users set time_zone = 'Pacific/Auckland' where id = ?")
			.bind(linus.user.id)
			.run();
		const inAuckland = textOf(await pageBody(await open(`${REPORTS}?${WEEK}&group=day`, linus)));
		expect(inAuckland).toContain("Tuesday 6 October 2:00");
		expect(inAuckland).not.toContain("Wednesday 7 October");
	});

	it("the report of a week holds, for a person in another zone, the week they submitted", async () => {
		// P3 (TR-05): Kiri, in Auckland, works 08:00 to 15:30 Monday 9 to Friday
		// 13 November, and 08:00 to 12:00 the Monday after; Ada reads in London.
		const AUCKLAND = "Pacific/Auckland";
		await env.DB.prepare("update users set time_zone = ? where id = ?")
			.bind(AUCKLAND, mallory.user.id)
			.run();
		await env.DB.prepare("update users set time_zone = 'Europe/London' where id = ?")
			.bind(ada.user.id)
			.run();
		// Auckland is UTC+13 in November: 08:00 there is 19:00 UTC the day before.
		for (const day of ["08", "09", "10", "11", "12"]) {
			const start = `2026-11-${day}T19:00:00Z`;
			const end = new Date(Date.parse(start) + 7.5 * HOUR * 1000).toISOString();
			await track(mallory, site, start, end, "Kiri", AUCKLAND);
		}
		await track(mallory, site, "2026-11-15T19:00:00Z", "2026-11-15T23:00:00Z", "Kiri", AUCKLAND);
		const week = `range=custom&from=2026-11-09&to=2026-11-15&person=${mallory.user.id}`;

		expect(await pageTotal(ada, week)).toBe("37:30");
		const byDay = textOf(await pageBody(await open(`${REPORTS}?${week}&group=day`, ada)));
		for (const day of ["Monday 9", "Tuesday 10", "Wednesday 11", "Thursday 12", "Friday 13"]) {
			expect(byDay).toContain(`${day} November 7:30`);
		}
		expect(byDay).not.toContain("Sunday 15 November");
		const { rows } = await exported(ada, week);
		expect(rows.map((row) => row.started_at).sort()).toEqual([
			"2026-11-08T19:00:00Z",
			"2026-11-09T19:00:00Z",
			"2026-11-10T19:00:00Z",
			"2026-11-11T19:00:00Z",
			"2026-11-12T19:00:00Z",
		]);
		expect(secondsOf(rows)).toBe(37.5 * HOUR);
	});

	it("groups by project and by client, the time with no client last", async () => {
		const byProject = textOf(await pageBody(await open(`${REPORTS}?${WEEK}&group=project`, ada)));
		expect(byProject).toMatch(/Billing 5:00 Site 3:00 Total 8:00/);
		const byClient = textOf(await pageBody(await open(`${REPORTS}?${WEEK}&group=client`, ada)));
		expect(byClient).toMatch(/Initech 3:00 No client 5:00 Total 8:00/);
	});

	it("counts a running entry up to now, with no end in the export", async () => {
		const now = Date.now();
		await scope.timeEntries.insert({
			userId: mallory.user.id,
			projectId: billing,
			description: "Still going",
			startedAt: new Date(now - 90 * 60_000),
			spentOn: dayOf(now - 90 * 60_000, "UTC"),
			endedAt: null,
		});
		const today = dayOf(now, "UTC");
		const yesterday = dayOf(now - 86_400_000, "UTC");
		const { rows } = await exported(mallory, `range=custom&from=${yesterday}&to=${today}`);
		// One row, even across midnight, with no end; its whole minutes so far.
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ended_at).toBe("");
		const seconds = secondsOf(rows);
		expect(seconds % 60).toBe(0);
		expect(seconds).toBeGreaterThanOrEqual(90 * 60);
		expect(seconds).toBeLessThan(92 * 60);
	});

	it("shows Clients only while the organisation has them, and groups by project instead", async () => {
		await env.DB.prepare("update organisations set clients_enabled = 0 where id = ?")
			.bind(acme.id)
			.run();
		const html = await pageBody(await open(`${REPORTS}?${WEEK}&group=client`, ada));
		expect(textOf(html)).toMatch(/By project .* Billing 5:00 Site 3:00 Total 8:00/);
		expect(textOf(html)).not.toContain("Initech");
		const { rows } = await exported(ada, `${WEEK}&group=client`);
		expect(rows.map((row) => row.client)).toEqual(rows.map(() => ""));
	});

	it("is 400 for a range that is not one, page and export alike", async () => {
		expect((await open(`${REPORTS}?range=forever`, ada)).status).toBe(400);
		expect((await open(`${EXPORT}?range=forever`, ada)).status).toBe(400);
	});

	it.each([
		[
			"that runs backwards",
			"range=custom&from=2026-10-11&to=2026-10-05",
			"Must be on or after the first day",
			"2026-10-05",
		],
		[
			"longer than 366 days",
			"range=custom&from=2025-10-01&to=2026-10-11",
			"At most 366 days",
			"2026-10-11",
		],
		[
			"whose last day is not a date",
			"range=custom&from=2026-10-05&to=2026-02-30",
			"Enter a date like 2026-11-09",
			"2026-02-30",
		],
		["with no last day", "range=custom&from=2026-10-05&to=", "Enter a date like 2026-11-09", ""],
	])(
		"shows the page again for a custom range %s, the days as typed and why under Last day",
		async (_, query, message, last) => {
			const response = await open(`${REPORTS}?${query}`, ada);
			expect(response.status).toBe(400);
			const html = await pageBody(response);
			const text = textOf(html);
			// The Reports page itself, not the error boundary.
			expect(html).toMatch(/<h1[^>]*>Reports<\/h1>/);
			expect(html).toContain(">Last day<");
			expect(html).toMatch(
				new RegExp(`name="to"[^>]*value="${last}"|value="${last}"[^>]*name="to"`),
			);
			expect(html).toMatch(
				/name="from"[^>]*value="20\d\d-\d\d-\d\d"|value="20\d\d-\d\d-\d\d"[^>]*name="from"/,
			);
			expect(text).toContain(message);
			// No report: no total and no export.
			expect(text).not.toContain("Total");
			expect(text).not.toContain("Export as CSV");
			expect((await open(`${EXPORT}?${query}`, ada)).status).toBe(400);
		},
	);

	it("gives Last day the first day as its least", async () => {
		const html = await pageBody(await open(`${REPORTS}?${WEEK}`, ada));
		expect(html).toMatch(/name="to"[^>]*min="2026-10-05"|min="2026-10-05"[^>]*name="to"/);
	});

	it("applies its filters as they change: there is no button to show it", async () => {
		const html = await pageBody(await open(`${REPORTS}?${WEEK}`, ada));
		expect(textOf(html)).not.toContain("Show report");
	});
});

describe("the export", () => {
	it("is a UTF-8 CSV attachment named for the organisation and the range, never stored", async () => {
		const { response } = await exported(ada, WEEK);
		expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8; header=present");
		expect(response.headers.get("Content-Disposition")).toBe(
			'attachment; filename="timesifier-acme-2026-10-05-to-2026-10-11.csv"',
		);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("is linked from the page with the report's own query", async () => {
		const html = await pageBody(
			await open(`${REPORTS}?${WEEK}&group=day&person=${linus.user.id}`, ada),
		);
		expect(html).toContain(
			`href="${EXPORT}?range=custom&amp;from=2026-10-05&amp;to=2026-10-11&amp;group=day&amp;person=${linus.user.id}"`,
		);
	});

	it("keeps names in any script, and cannot start a spreadsheet formula", async () => {
		await track(
			ada,
			site,
			"2026-10-09T09:00:00Z",
			"2026-10-09T09:30:00Z",
			'=HYPERLINK("http://evil","Zoë, café")',
		);
		await track(ada, site, "2026-10-09T10:00:00Z", "2026-10-09T10:30:00Z", "@SUM(1)");
		const { rows } = await exported(ada, `${WEEK}&person=${ada.user.id}`);
		// The export is in the order of the entries' ids, which two inserted in one
		// millisecond may not keep; what is asserted is how each is written.
		expect(rows.map((row) => row.description).sort()).toEqual(
			["Work", `'=HYPERLINK("http://evil","Zoë, café")`, "'@SUM(1)"].sort(),
		);
	});

	it("holds every entry, page after page", async () => {
		const many = Array.from({ length: 450 }, (_, i) => ({
			userId: linus.user.id,
			projectId: site,
			description: `Entry ${i}`,
			startedAt: new Date(Date.parse("2026-10-09T00:00:00Z") + i * 120_000),
			// A minute and a half: a whole minute, as the report counts it.
			endedAt: new Date(Date.parse("2026-10-09T00:00:00Z") + i * 120_000 + 90_000),
			spentOn: "2026-10-09",
		}));
		// D1 binds at most 100 values a statement: eight entries an insert.
		for (let at = 0; at < many.length; at += 8)
			await scope.timeEntries.insert(many.slice(at, at + 8));
		const { rows } = await exported(linus, WEEK);
		expect(rows).toHaveLength(451);
		expect(new Set(rows.map((row) => row.entry_id)).size).toBe(451);
		expect(secondsOf(rows)).toBe(2 * HOUR + 450 * 60);
		expect(await pageTotal(linus, WEEK)).toBe("9:30");
	});
});

describe("people: worked, expected and leave (TS-061)", () => {
	/** The People section of the report at `query`, as text. */
	async function peopleOf(who: Person, query: string) {
		const response = await open(`${REPORTS}?${query}`, who);
		expect(response.status).toBe(200);
		const text = textOf(await pageBody(response));
		return text.slice(text.indexOf("Worked, expected and leave"));
	}

	beforeEach(async () => {
		// Monday is a public holiday. Linus is on approved annual leave Thursday and
		// Friday; Mallory took a half day's sick leave on Wednesday, and her annual
		// leave on Tuesday was never approved.
		await seedHoliday(acme.id, "2026-10-05", "Founders' Day");
		await seedLeave(acme.id, linus.user.id, "annual", "2026-10-08", "2026-10-09");
		await seedLeave(acme.id, mallory.user.id, "sick", "2026-10-07", "2026-10-07", {
			startsHalf: true,
		});
		await seedLeave(acme.id, mallory.user.id, "annual", "2026-10-06", "2026-10-06", {
			status: "pending",
		});
	});

	it("shows each person's time worked beside the time expected of them and their leave", async () => {
		const people = await peopleOf(ada, WEEK);
		expect(people).toMatch(/ada@example\.com 30:00 expected · No leave 1:00/);
		expect(people).toMatch(/grace@example\.com 30:00 expected · No leave 0:00/);
		expect(people).toMatch(/hedy@example\.com 30:00 expected · No leave 2:00/);
		expect(people).toMatch(/linus@example\.com 15:00 expected · 15:00 leave \(2 days\) 2:00/);
		expect(people).toMatch(/mallory@example\.com 26:15 expected · 3:45 leave \(half a day\) 3:00/);
	});

	it("never counts leave as time worked", async () => {
		expect(await pageTotal(ada, WEEK)).toBe("8:00");
		expect(await pageTotal(ada, `${WEEK}&person=${linus.user.id}`)).toBe("2:00");
		const { rows } = await exported(ada, WEEK);
		expect(secondsOf(rows)).toBe(8 * HOUR);
	});

	it("holds only the people the viewer may see", async () => {
		const managed = await peopleOf(hedy, WEEK);
		expect(managed).toContain("hedy@example.com");
		expect(managed).toContain("linus@example.com 15:00 expected · 15:00 leave (2 days)");
		expect(managed).not.toContain("mallory@example.com");
		const own = await peopleOf(mallory, WEEK);
		expect(own).toContain("mallory@example.com 26:15 expected · 3:45 leave (half a day) 3:00");
		expect(own).not.toContain("linus@example.com");
	});
});

describe("regular time and overtime apart (TS-095)", () => {
	beforeEach(async () => {
		// Linus's Tuesday entry and Mallory's Thursday hour from 12:00 are overtime.
		await env.DB.prepare(
			"update time_entries set overtime = 1 where user_id = ? and started_at = ?",
		)
			.bind(linus.user.id, Date.parse("2026-10-06T23:00:00Z"))
			.run();
		await scope.timeEntries.insert({
			userId: mallory.user.id,
			projectId: billing,
			description: "Late",
			startedAt: new Date("2026-10-08T13:00:00Z"),
			spentOn: dayOf(Date.parse("2026-10-08T13:00:00Z"), "UTC"),
			endedAt: new Date("2026-10-08T14:00:00Z"),
			overtime: true,
		});
	});

	it.each([
		["an owner", () => ada, "9:00", "3:00", true],
		["an admin", () => grace, "9:00", "3:00", true],
		["a manager", () => hedy, "4:00", "2:00", false],
		["a member", () => linus, "2:00", "2:00", false],
		["a member in no team", () => mallory, "4:00", "1:00", true],
	])(
		"%s sees the overtime of the time they may see, on the page and in the export",
		async (_, who, total, overtime, seesMallory) => {
			const response = await open(`${REPORTS}?${WEEK}`, who());
			const text = textOf(await pageBody(response));
			expect(await pageTotal(who(), WEEK)).toBe(total);
			expect(text).toContain(`${overtime} of it overtime`);
			expect(text).toContain(" · Overtime");
			const { rows } = await exported(who(), WEEK);
			const overtimeSeconds = rows
				.filter((row) => row.overtime === "yes")
				.reduce((sum, row) => sum + Number(row.duration_seconds), 0);
			expect(overtimeSeconds / HOUR).toBe(Number(overtime.split(":")[0]));
			expect(rows.every((row) => row.overtime === "yes" || row.overtime === "no")).toBe(true);
			expect(rows.some((row) => row.description === "Late")).toBe(seesMallory);
		},
	);

	it("splits each group and each person into regular time and overtime", async () => {
		const text = textOf(await pageBody(await open(`${REPORTS}?${WEEK}&group=project`, ada)));
		expect(text).toContain("Billing 5:00 regular · 1:00 overtime");
		expect(text).toContain("Site 1:00 regular · 2:00 overtime");
		const people = text.slice(text.indexOf("Worked, expected and leave"));
		expect(people).toContain("0:00 regular · 2:00 overtime");
		expect(people).toContain("3:00 regular · 1:00 overtime");
		// A person with no overtime says nothing of it.
		expect(people).toMatch(/ada@example\.com 37:30 expected · No leave 1:00/);
	});

	it("says what of each person's utilisation is overtime", async () => {
		const text = textOf(await pageBody(await open(`${REPORTS}/utilisation?${WEEK}`, ada)));
		expect(text).toContain("2:00 of 37:30 capacity, 2:00 of it overtime");
		expect(text).toContain("4:00 of 37:30 capacity, 1:00 of it overtime");
	});
});
