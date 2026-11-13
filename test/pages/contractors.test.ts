import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decimalAmount, decimalHours } from "~/contractors/contractors";
import { type OrganisationScope, organisationScope } from "~/db";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, row, seedMembership, seedTeam, value } from "../organisations/harness";
import { parseCsv } from "../reports/csv";
import { open, openData, type Person, pageBody, person, submit, textOf } from "./harness";

// Contractors (TS-079, B15), through the Worker. An owner or admin marks a
// member as an employee or a contractor on Team › Members, and the change is
// in the activity log; anybody else is refused and nothing changes. The
// Contractors report at /app/<slug>/reports/contractors, and its CSV at
// .../export, list each contractor's unrounded hours and their cost at the
// cost rates in force, with people who left as contractors, to owners, admins
// and Finance; anybody else, a manager included, gets the organisation's 404.

const MEMBERS = "/app/acme/team/members";
const ACCOUNT = "/app/acme/account";
const REPORT = "/app/acme/reports/contractors";
const EXPORT = "/app/acme/reports/contractors/export";
/** Monday 5 to Sunday 11 October 2026: a week in the past, so the clock does not move it. */
const WEEK = "range=custom&from=2026-10-05&to=2026-10-11";
const NOT_ALLOWED = "Your role in this organisation does not allow that.";

let mailbox: Mailbox;
let acme: { id: string };
let scope: OrganisationScope;
let ada: Person;
let grace: Person;
let katherine: Person;
let hedy: Person;
let linus: Person;
let mallory: Person;
/** Membership ids, by person. */
const memberIds = new Map<Person, string>();

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	memberIds.clear();
	const adaMember = await value<string>(
		"select id from memberships where user_id = ?",
		ada.user.id,
	);
	memberIds.set(ada, String(adaMember));
	grace = await person(mailbox, "grace@example.com");
	katherine = await person(mailbox, "katherine@example.com");
	hedy = await person(mailbox, "hedy@example.com");
	linus = await person(mailbox, "linus@example.com");
	mallory = await person(mailbox, "mallory@example.com");
	memberIds.set(grace, await seedMembership(acme.id, grace.user.id, "admin"));
	memberIds.set(katherine, await seedMembership(acme.id, katherine.user.id, "finance"));
	memberIds.set(hedy, await seedMembership(acme.id, hedy.user.id, "member"));
	memberIds.set(linus, await seedMembership(acme.id, linus.user.id, "member"));
	memberIds.set(mallory, await seedMembership(acme.id, mallory.user.id, "member"));
	// Hedy manages Design, which Linus is in: a manager who holds the role of a member.
	await seedTeam(acme.id, "Design", { members: [linus.user.id], managers: [hedy.user.id] });
	await env.DB.prepare("update users set name = 'Linus Torvalds' where id = ?")
		.bind(linus.user.id)
		.run();
	// The first request to the Worker loads the whole application, which takes
	// longer than a hook is given by default.
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const memberOf = (who: Person) => memberIds.get(who) as string;

/** The form the Actions menu sends, by script, as the page sends it. */
async function mark(who: Person, whom: Person | string, isContractor: boolean) {
	const response = await submit(
		MEMBERS,
		{
			intent: "contractor",
			memberId: typeof whom === "string" ? whom : memberOf(whom),
			isContractor: String(isContractor),
		},
		who,
		{ byScript: true },
	);
	return { status: response.status, said: await response.text() };
}

const isContractor = async (who: Person) =>
	Boolean(await value("select is_contractor from memberships where user_id = ?", who.user.id));

const recordsOf = (action: string) =>
	value("select count(*) from activity_records where action = ?", action);

describe("marking a member as an employee or a contractor", () => {
	it("an owner marks a member a contractor, and back; each change is in the activity log", async () => {
		const marked = await mark(ada, linus, true);
		expect(marked.status).toBe(200);
		expect(marked.said).toContain("Marked as a contractor.");
		expect(await isContractor(linus)).toBe(true);

		const recorded = await row<Record<string, string | null>>(
			`select actor_id, source, subject_type, subject_id, owner_id, summary
			from activity_records where action = 'membership.contractor_changed'`,
		);
		expect(recorded).toMatchObject({
			actor_id: ada.user.id,
			source: "web",
			subject_type: "membership",
			subject_id: memberOf(linus),
			owner_id: linus.user.id,
		});
		expect(JSON.parse(String(recorded?.summary))).toEqual({
			before: { isContractor: false },
			after: { isContractor: true },
		});

		// Asking for what already is changes nothing and records nothing.
		expect((await mark(ada, linus, true)).status).toBe(200);
		expect(await recordsOf("membership.contractor_changed")).toBe(1);

		const back = await mark(ada, linus, false);
		expect(back.said).toContain("Marked as an employee.");
		expect(await isContractor(linus)).toBe(false);
		expect(await recordsOf("membership.contractor_changed")).toBe(2);
	});

	it("an owner marks themselves: any role may be a contractor", async () => {
		expect((await mark(ada, ada, true)).status).toBe(200);
		expect(await isContractor(ada)).toBe(true);
	});

	it("an admin marks a member and another admin, but not an owner or themselves", async () => {
		const other = await person(mailbox, "barbara@example.com");
		memberIds.set(other, await seedMembership(acme.id, other.user.id, "admin"));

		expect((await mark(grace, linus, true)).status).toBe(200);
		expect((await mark(grace, other, true)).status).toBe(200);
		for (const whom of [ada, grace]) {
			const refused = await mark(grace, whom, true);
			expect(refused.status).toBe(403);
			expect(refused.said).toContain(NOT_ALLOWED);
			expect(await isContractor(whom)).toBe(false);
		}
		expect(await recordsOf("membership.contractor_changed")).toBe(2);
	});

	it("is refused to Finance, a member and a manager, and nothing changes", async () => {
		// Team is not shown to Finance or a member: its pages are their 404. A
		// manager is shown it, and the action refuses.
		expect((await mark(katherine, linus, true)).status).toBe(404);
		expect((await mark(mallory, linus, true)).status).toBe(404);
		const manager = await mark(hedy, linus, true);
		expect(manager.status).toBe(403);
		expect(manager.said).toContain(NOT_ALLOWED);
		// Not even of themselves.
		expect((await mark(hedy, hedy, true)).status).toBe(403);

		expect(await isContractor(linus)).toBe(false);
		expect(await isContractor(hedy)).toBe(false);
		expect(await recordsOf("membership.contractor_changed")).toBe(0);
	});

	it("refuses a membership that is not this organisation's, and a value that is neither", async () => {
		const gone = await mark(ada, "m-nobody", true);
		expect(gone.status).toBe(404);
		expect(gone.said).toContain("That person is no longer a member of this organisation.");

		const malformed = await submit(
			MEMBERS,
			{ intent: "contractor", memberId: memberOf(linus), isContractor: "maybe" },
			ada,
			{ byScript: true },
		);
		expect(malformed.status).toBe(400);
		expect(await recordsOf("membership.contractor_changed")).toBe(0);
	});

	it("shows Contractor beside the role, and the menu to owners and admins alone", async () => {
		await mark(ada, linus, true);

		const html = await pageBody(await open(MEMBERS, ada));
		expect(textOf(html)).toContain("Linus Torvalds linus@example.com Member · Contractor");
		expect(textOf(html)).toContain("mallory@example.com Member");
		expect(textOf(html)).not.toContain("mallory@example.com Member · Contractor");
		// The owner's own row has Actions, to mark themselves.
		expect(html).toContain('aria-label="Actions for ada@example.com"');

		const managers = await pageBody(await open(MEMBERS, hedy));
		expect(textOf(managers)).toContain("Member · Contractor");
		expect(managers).not.toContain("Actions for");
	});

	it("a removal and a leaving record whether the person was a contractor", async () => {
		await mark(ada, linus, true);
		const removed = await submit(MEMBERS, { intent: "remove", memberId: memberOf(linus) }, ada, {
			byScript: true,
		});
		expect(removed.status).toBe(200);
		await mark(ada, mallory, true);
		const left = await submit(ACCOUNT, { intent: "leave" }, mallory);
		expect(left.status).toBe(302);
		expect(await value("select count(*) from memberships where user_id = ?", mallory.user.id)).toBe(
			0,
		);

		const summaries = await env.DB.prepare(
			`select owner_id, actor_id, summary from activity_records
			where action = 'membership.removed' order by owner_id`,
		).all<{ owner_id: string; actor_id: string; summary: string }>();
		const byOwner = new Map(summaries.results.map((r) => [r.owner_id, r]));
		expect(JSON.parse(byOwner.get(linus.user.id)?.summary ?? "{}")).toEqual({
			before: { role: "member", isContractor: true },
		});
		expect(byOwner.get(mallory.user.id)?.actor_id).toBe(mallory.user.id);
		expect(JSON.parse(byOwner.get(mallory.user.id)?.summary ?? "{}")).toEqual({
			before: { role: "member", isContractor: true },
		});
	});
});

/**
 * The week's time. Linus is a contractor with a cost rate of £30 an hour from
 * January and £45 from Thursday 8 October, and Billing costs €20 an hour
 * whoever works on it. Bob was a contractor with no cost rate, and left. Eve
 * was an employee, and left. Mallory is an employee.
 */
async function aWeekOfWork() {
	const [site, billing] = await scope.projects.insert([
		{ name: "Site", nameKey: "site" },
		{ name: "Billing", nameKey: "billing" },
	]);
	if (!site || !billing) throw new Error("seed failed");
	const bob = await person(mailbox, "bob@example.com");
	const eve = await person(mailbox, "eve@example.com");
	memberIds.set(bob, await seedMembership(acme.id, bob.user.id, "member"));
	memberIds.set(eve, await seedMembership(acme.id, eve.user.id, "member"));
	await env.DB.prepare("update users set name = 'Bob Builder' where id = ?")
		.bind(bob.user.id)
		.run();

	await scope.rates.insert([
		{
			kind: "cost",
			userId: linus.user.id,
			amountMinor: 3000,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "cost",
			userId: linus.user.id,
			amountMinor: 4500,
			currency: "GBP",
			effectiveFrom: "2026-10-08",
		},
		{
			kind: "cost",
			projectId: billing.id,
			amountMinor: 2000,
			currency: "EUR",
			effectiveFrom: "2026-01-01",
		},
		// A billable rate is no cost.
		{
			kind: "billable",
			userId: bob.user.id,
			amountMinor: 9900,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
	]);

	const track = (who: Person, projectId: string, from: string, to: string) =>
		scope.timeEntries.insert({
			userId: who.user.id,
			projectId,
			startedAt: new Date(from),
			endedAt: new Date(to),
		});
	// Linus: 1:30 at £30, then twice 20 minutes 30 seconds at £45, each worth
	// 1537.5 pence: rounded once, at the total, they make £30.75, not £30.76.
	await track(linus, site.id, "2026-10-06T09:00:00Z", "2026-10-06T10:30:00Z");
	await track(linus, site.id, "2026-10-09T09:00:00Z", "2026-10-09T09:20:30Z");
	await track(linus, site.id, "2026-10-10T09:00:00Z", "2026-10-10T09:20:30Z");
	// An hour on Billing, at its own rate in euros.
	await track(linus, billing.id, "2026-10-07T10:00:00Z", "2026-10-07T11:00:00Z");
	// The Monday after: in no report of the week.
	await track(linus, site.id, "2026-10-12T09:00:00Z", "2026-10-12T10:00:00Z");
	await track(bob, site.id, "2026-10-07T13:00:00Z", "2026-10-07T14:30:00Z");
	await track(eve, site.id, "2026-10-07T13:00:00Z", "2026-10-07T17:00:00Z");
	await track(mallory, site.id, "2026-10-06T09:00:00Z", "2026-10-06T11:00:00Z");

	// Linus and Bob are marked contractors, on the page; then Bob and Eve are removed.
	for (const whom of [linus, bob]) expect((await mark(ada, whom, true)).status).toBe(200);
	for (const whom of [bob, eve]) {
		const removed = await submit(MEMBERS, { intent: "remove", memberId: memberOf(whom) }, ada, {
			byScript: true,
		});
		expect(removed.status).toBe(200);
	}
	return { bob, eve };
}

/** The export of the report at `query`, as rows keyed by column, after its byte order mark and header. */
async function exported(who: Person, query: string) {
	const response = await open(`${EXPORT}?${query}`, who);
	expect(response.status).toBe(200);
	const bytes = new Uint8Array(await response.arrayBuffer());
	expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	const [header, ...rows] = parseCsv(
		new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.slice(3)),
	);
	return { response, header, rows };
}

describe("the Contractors report", () => {
	it("is shown to owners, admins and Finance, and is the organisation's 404 to members and managers", async () => {
		const stranger = await person(mailbox, "stranger@example.com");
		await createOrganisation(stranger.cookie, "Initech");

		for (const who of [ada, grace, katherine]) {
			expect((await open(`${REPORT}?${WEEK}`, who)).status).toBe(200);
			expect((await openData(`${REPORT}?${WEEK}`, who)).status).toBe(200);
			expect((await open(`${EXPORT}?${WEEK}`, who)).status).toBe(200);
		}
		for (const address of [REPORT, EXPORT]) {
			const strangers = await pageBody(await open(address, stranger));
			for (const who of [mallory, hedy]) {
				const page = await open(address, who);
				expect(page.status, address).toBe(404);
				expect(await pageBody(page), address).toBe(strangers);
				expect((await openData(address, who)).status, address).toBe(404);
			}
			// Another organisation's address is the same 404.
			expect((await open(address, stranger)).status).toBe(404);
		}
	});

	it("lists each contractor's unrounded hours and cost, with one total for each currency", async () => {
		await aWeekOfWork();

		const text = textOf(await pageBody(await open(`${REPORT}?${WEEK}`, katherine)));

		// 1:30 + 0:20:30 + 0:20:30 + 1:00 is 3:11:00.
		expect(text).toContain("Linus Torvalds 3:11 hours €20.00 · £75.75");
		expect(text).toContain(
			"Bob Builder 1:30 hours · Missing rate for 1:30 · Left the organisation £0.00",
		);
		expect(text).not.toContain("eve@example.com");
		expect(text).not.toContain("mallory@example.com");
		expect(text).toContain("Total, 4:41 hours €20.00 · £75.75");
		expect(text).toContain("1:30 hours have no cost rate in force");
		expect(text).toContain("5–11 October 2026");
		expect(text).toContain("Export as CSV");
	});

	it("counts an entry on the day it starts in the person's own zone", async () => {
		const [site] = await scope.projects.insert([{ name: "Site", nameKey: "site" }]);
		if (!site) throw new Error("seed failed");
		await mark(ada, linus, true);
		await env.DB.prepare("update users set time_zone = 'Pacific/Auckland' where id = ?")
			.bind(linus.user.id)
			.run();
		// Sunday 4 October at 12:00 UTC is Monday 5 October at 01:00 in Auckland:
		// in the week. Sunday 11 October at 12:00 UTC is Monday 12 there: not.
		await scope.timeEntries.insert([
			{
				userId: linus.user.id,
				projectId: site.id,
				startedAt: new Date("2026-10-04T12:00:00Z"),
				endedAt: new Date("2026-10-04T13:00:00Z"),
			},
			{
				userId: linus.user.id,
				projectId: site.id,
				startedAt: new Date("2026-10-11T12:00:00Z"),
				endedAt: new Date("2026-10-11T14:00:00Z"),
			},
		]);

		const text = textOf(await pageBody(await open(`${REPORT}?${WEEK}`, ada)));
		expect(text).toContain("Linus Torvalds 1:00 hours · Missing rate for 1:00 £0.00");
	});

	it("exports the same people as a CSV, with seconds and hours to six places", async () => {
		await aWeekOfWork();

		const { response, header, rows } = await exported(ada, WEEK);

		expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8; header=present");
		expect(response.headers.get("Content-Disposition")).toMatch(
			/^attachment; filename="acme-contractors-2026-10-05-to-2026-10-11-exported-\d{4}-\d{2}-\d{2}\.csv"$/,
		);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(header).toEqual([
			"person",
			"left_organisation",
			"rate_missing",
			"seconds",
			"hours",
			"currency",
			"cost",
		]);
		expect(rows).toEqual([
			["Bob Builder", "yes", "yes", "5400", "1.500000", "", ""],
			["Linus Torvalds", "no", "no", "3600", "1.000000", "EUR", "20.00"],
			["Linus Torvalds", "no", "no", "7860", "2.183333", "GBP", "75.75"],
		]);
	});

	it("says what to do when nobody is a contractor: on Members, for owners and admins", async () => {
		const owners = await pageBody(await open(`${REPORT}?${WEEK}`, ada));
		expect(textOf(owners)).toContain(
			"Nobody here is a contractor yet. Mark a member as a contractor from their Actions on Members.",
		);
		expect(owners).toMatch(
			/<a[^>]*href="\/app\/acme\/team\/members"[^>]*>Mark a member as a contractor<\/a>/,
		);

		const finance = textOf(await pageBody(await open(`${REPORT}?${WEEK}`, katherine)));
		expect(finance).toContain("Owners and admins mark them on Members.");

		await mark(ada, linus, true);
		expect(textOf(await pageBody(await open(`${REPORT}?${WEEK}`, ada)))).toContain(
			"No contractor tracked time in this range.",
		);
	});

	it("answers a range that cannot be made with 400", async () => {
		const backwards = "range=custom&from=2026-10-11&to=2026-10-05";
		expect((await open(`${REPORT}?${backwards}`, ada)).status).toBe(400);
		expect((await open(`${EXPORT}?${backwards}`, ada)).status).toBe(400);
	});
});

describe("the export's figures", () => {
	it("writes hours to six places and amounts with their currency's places", () => {
		expect(decimalHours(0)).toBe("0.000000");
		expect(decimalHours(1)).toBe("0.000278");
		expect(decimalHours(7860)).toBe("2.183333");
		expect(decimalAmount(7575, "GBP")).toBe("75.75");
		expect(decimalAmount(5, "GBP")).toBe("0.05");
		expect(decimalAmount(1200, "JPY")).toBe("1200");
		expect(decimalAmount(12345, "KWD")).toBe("12.345");
	});
});
