import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { createDraft, issueInvoice, linesOf } from "~/invoices/invoices.server";
import { type Grouping, type TimeItem, timeLines } from "~/invoices/lines";
import { issueRecurring } from "~/invoices/recurring.server";
import { type SourceRequest, sourcesFor } from "~/invoices/sources.server";
import { invoiceView } from "~/invoices/view.server";
import { projectPath } from "~/projects/projects";
import { negotiateLocale } from "~/shell/locale";
import { dayOf } from "~/time/calendar";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership } from "../organisations/harness";
import { open, type Person, person, submit, textOf } from "../pages/harness";
import { seedDefaultWeek } from "../pages/schedule-seed";

// Overtime billed at its own rate (D9, OQ4): a project bills its overtime at
// the rate in force on the entry's day times the project's multiplier. Other
// than ×1, it is on a line of its own that says it is overtime, in the
// preview, the draft it saves, a recurring invoice, the PDF and the Xero file;
// at ×1 it is billed as before, on its group's line, unmarked.

const NOW = Date.parse("2026-11-02T12:00:00Z");
const TODAY = "2026-11-02";
const ORGANISATION = { timeZone: "UTC", currency: "GBP" };
/** £60.00 an hour. */
const SITE_RATE = 6000;
/** Monday to Friday, 09:00 to 17:30 with an hour's break: 7:30 a day. */
const STANDARD_WEEK = [450, 450, 450, 450, 450, 0, 0];

let scope: OrganisationScope;
let owner: Person;
let organisationId: string;
let clientId: string;
let siteId: string;
let developmentId: string;

beforeEach(async () => {
	await freshDatabase();
	const mailbox = captureEmail();
	owner = await person(mailbox, "ada@example.com");
	await env.DB.prepare("update users set name = 'Ada Lovelace' where id = ?")
		.bind(owner.user.id)
		.run();
	const acme = await createOrganisation(owner.cookie, "Acme");
	organisationId = acme.id;
	scope = organisationScope(env.DB, acme.id);
	// Overtime is allowed, without a cap, on a 7:30 day.
	await env.DB.prepare("update organisations set overtime_policy = 'allowed' where id = ?")
		.bind(acme.id)
		.run();
	await seedDefaultWeek(acme.id, STANDARD_WEEK);
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!client) throw new Error("seed failed");
	const [site] = await scope.projects.insert({
		name: "Site",
		nameKey: "site",
		clientId: client.id,
		overtimeRateMilli: 1500,
	});
	const [development] = await scope.tasks.insert({ name: "Development", nameKey: "development" });
	if (!site || !development) throw new Error("seed failed");
	clientId = client.id;
	siteId = site.id;
	developmentId = development.id;
	await scope.rates.insert({
		kind: "billable",
		projectId: siteId,
		userId: null,
		taskId: null,
		amountMinor: SITE_RATE,
		currency: "GBP",
		effectiveFrom: "2026-01-01",
	});
});

async function entry(start: string, end: string, overtime: boolean) {
	const startedAt = new Date(start);
	const [row] = await scope.timeEntries.insert({
		userId: owner.user.id,
		projectId: siteId,
		taskId: developmentId,
		description: "Work",
		billable: true,
		overtime,
		startedAt,
		spentOn: dayOf(startedAt.getTime(), "UTC"),
		endedAt: new Date(end),
	});
	if (!row) throw new Error("seed failed");
	return row.id;
}

/** Tuesday 6 October: the day's 7:30, then three hours of overtime. */
async function aLongDay() {
	const regular = await entry("2026-10-06T09:00:00Z", "2026-10-06T16:30:00Z", false);
	const overtime = await entry("2026-10-06T16:30:00Z", "2026-10-06T19:30:00Z", true);
	return { regular, overtime };
}

function request(grouping: Grouping): SourceRequest {
	return { clientId, days: null, projectIds: [], grouping, fixedMinor: new Map() };
}

const shown = (
	lines: {
		description: string;
		quantityMilli: number;
		unitPriceMinor: number;
		amountMinor: number;
	}[],
) => lines.map((l) => [l.description, l.quantityMilli, l.unitPriceMinor, l.amountMinor]);

describe("lines of time", () => {
	const item = (id: string, overtime: boolean, more: Partial<TimeItem> = {}): TimeItem => ({
		id,
		projectId: "p1",
		projectName: "Site",
		workPackageId: null,
		workPackageName: null,
		taskId: "t1",
		taskName: "Development",
		userId: "u1",
		personName: "Ada Lovelace",
		description: "Work",
		day: "2026-10-06",
		minutes: 60,
		rateMinor: overtime ? 9000 : 6000,
		minuteMinor: 60 * (overtime ? 9000 : 6000),
		overtime,
		overtimeApart: overtime,
		...more,
	});

	it("give each work package a line of its own, carrying its code, and add up to the same subtotal (TS-115b)", () => {
		const items = [
			item("a", false, { workPackageId: "w1", workPackageName: "WP1 Discovery" }),
			item("b", false, { workPackageId: "w2", workPackageName: "WP2 Build" }),
			item("c", false, {
				workPackageId: "w2",
				workPackageName: "WP2 Build",
				taskId: "t2",
				taskName: "Design",
			}),
			item("d", false),
		];
		const regular = items.map((each) => ({ ...each, overtimeApart: false }));
		expect(timeLines(regular, "work-package").map((l) => [l.description, l.timeEntryIds])).toEqual([
			["Site › WP1 Discovery", ["a"]],
			["Site › WP2 Build", ["b", "c"]],
			["Site", ["d"]],
		]);
		expect(timeLines(regular, "task").map((l) => l.description)).toEqual([
			"Site › WP1 Discovery: Development",
			"Site › WP2 Build: Development",
			"Site › WP2 Build: Design",
			"Site: Development",
		]);
		expect(timeLines(regular, "project").map((l) => l.description)).toEqual(["Site"]);
		const subtotal = (grouping: Grouping) =>
			timeLines(regular, grouping).reduce((sum, line) => sum + line.amountMinor, 0);
		expect(subtotal("work-package")).toBe(subtotal("project"));
		expect(subtotal("task")).toBe(subtotal("entry"));
	});

	it("put overtime on a line of its own after its group's regular time, labelled", () => {
		const items = [
			item("o1", true),
			item("r1", false),
			item("r2", false, { taskId: "t2", taskName: "Design" }),
			item("o2", true, { taskId: "t2", taskName: "Design", minutes: 30, minuteMinor: 30 * 9000 }),
		];
		expect(shown(timeLines(items, "task"))).toEqual([
			["Site: Development", 1000, 6000, 6000],
			["Site: Development (overtime)", 1000, 9000, 9000],
			["Site: Design", 1000, 6000, 6000],
			["Site: Design (overtime)", 500, 9000, 4500],
		]);
		expect(timeLines(items, "project").map((l) => [l.description, l.timeEntryIds])).toEqual([
			["Site", ["r1", "r2"]],
			["Site (overtime)", ["o1", "o2"]],
		]);
		expect(timeLines(items, "person").map((l) => l.description)).toEqual([
			"Site: Ada Lovelace",
			"Site: Ada Lovelace (overtime)",
		]);
		expect(timeLines(items, "entry").map((l) => l.description)).toEqual([
			"Site: Work: 2026-10-06 (overtime)",
			"Site: Work: 2026-10-06",
			"Site: Work: 2026-10-06",
			"Site: Work: 2026-10-06 (overtime)",
		]);
	});

	it("keep overtime billed at ×1 on its group's line, unmarked", () => {
		const atOne = (id: string, overtime: boolean) =>
			item(id, overtime, { overtimeApart: false, rateMinor: 6000, minuteMinor: 60 * 6000 });
		const items = [atOne("r1", false), atOne("o1", true)];
		expect(timeLines(items, "task").map((l) => [l.description, l.timeEntryIds])).toEqual([
			["Site: Development", ["r1", "o1"]],
		]);
	});
});

describe("the preview", () => {
	it("bills overtime at the day's rate times the project's multiplier, on its own line", async () => {
		const { regular, overtime } = await aLongDay();
		const byTask = await sourcesFor(scope, ORGANISATION, request("task"), NOW);
		expect(byTask.leftOut).toEqual([]);
		expect(shown(byTask.lines)).toEqual([
			["Site: Development", 7500, 6000, 45_000],
			["Site: Development (overtime)", 3000, 9000, 27_000],
		]);
		expect(byTask.lines.map((l) => l.timeEntryIds)).toEqual([[regular], [overtime]]);
		const preview = byTask.entries.find((e) => e.id === overtime);
		expect(preview).toMatchObject({ overtime: true, rateMinor: 9000, minuteMinor: 180 * 9000 });

		const byProject = await sourcesFor(scope, ORGANISATION, request("project"), NOW);
		expect(shown(byProject.lines)).toEqual([
			["Site", 7500, 6000, 45_000],
			["Site (overtime)", 3000, 9000, 27_000],
		]);

		// The preview page shows the line, priced.
		const page = await open(`/app/acme/invoices/new?client=${clientId}&group=task`, owner);
		const html = await page.text();
		expect(html).toContain("Site: Development (overtime)");
		expect(html).toContain("£270.00");
	});

	it("bills overtime at ×1 as before: on its group's line, unmarked, at the day's own rate", async () => {
		await scope.projects.update({ overtimeRateMilli: 1000 }, (p) => eq(p.id, siteId));
		await aLongDay();
		const byProject = await sourcesFor(scope, ORGANISATION, request("project"), NOW);
		expect(shown(byProject.lines)).toEqual([["Site", 10_500, 6000, 63_000]]);
		const byTask = await sourcesFor(scope, ORGANISATION, request("task"), NOW);
		expect(shown(byTask.lines)).toEqual([["Site: Development", 10_500, 6000, 63_000]]);
		const page = await (
			await open(`/app/acme/invoices/new?client=${clientId}&group=task`, owner)
		).text();
		expect(page).not.toContain("(overtime)");
	});

	it("rounds an overtime hour's price to the penny once, at the rate", async () => {
		// £60.01 × 1.25 is £75.0125 an hour: £75.01.
		await scope.projects.update({ overtimeRateMilli: 1250 }, (p) => eq(p.id, siteId));
		await scope.rates.update({ amountMinor: 6001 }, (r) => eq(r.projectId, siteId));
		await aLongDay();
		const sources = await sourcesFor(scope, ORGANISATION, request("project"), NOW);
		expect(shown(sources.lines)).toEqual([
			["Site", 7500, 6001, 45_008],
			["Site (overtime)", 3000, 7501, 22_503],
		]);
	});
});

describe("what is billed", () => {
	it("the saved draft, its PDF and its Xero row each say overtime, at the multiplied price", async () => {
		await aLongDay();
		const sources = await sourcesFor(scope, ORGANISATION, request("task"), NOW);
		const made = await createDraft(scope, owner.user.id, {
			clientId,
			currency: "GBP",
			issuedOn: TODAY,
			lines: sources.lines,
		});
		if (!made.ok) throw new Error(made.problem);
		const stored = await linesOf(scope, made.id);
		expect(shown(stored)).toEqual([
			["Site: Development", 7500, 6000, 45_000],
			["Site: Development (overtime)", 3000, 9000, 27_000],
		]);
		await issueInvoice(scope, owner.user.id, made.id);

		const view = await invoiceView(scope, "Acme", made.id, {
			locale: negotiateLocale(null),
			today: TODAY,
		});
		expect(view?.printed.lines.map((l) => [l.description, l.quantity, l.unitPrice])).toEqual([
			["Site: Development", "7.5", "£60.00"],
			["Site: Development (overtime)", "3", "£90.00"],
		]);
		const pdf = await open(`/app/acme/invoices/${made.id}/pdf`, owner);
		expect(pdf.status).toBe(200);
		expect(new TextDecoder("latin1").decode(await pdf.arrayBuffer())).toContain(
			"(Site: Development \\(overtime\\)) Tj",
		);

		const xero = await open("/app/acme/invoices/xero?from=2026-11-01&to=2026-11-30", owner);
		expect(xero.status).toBe(200);
		const rows = (await xero.text()).split("\r\n");
		expect(rows.find((r) => r.includes("Site: Development (overtime)"))).toContain(
			",Site: Development (overtime),3,90.00,",
		);
		expect(rows.find((r) => r.includes(",Site: Development,"))).toContain(
			",Site: Development,7.5,60.00,",
		);
	});

	it("at ×1, the saved draft, its PDF and its Xero row bill overtime as before, on one unmarked line", async () => {
		await scope.projects.update({ overtimeRateMilli: 1000 }, (p) => eq(p.id, siteId));
		await aLongDay();
		const sources = await sourcesFor(scope, ORGANISATION, request("task"), NOW);
		const made = await createDraft(scope, owner.user.id, {
			clientId,
			currency: "GBP",
			issuedOn: TODAY,
			lines: sources.lines,
		});
		if (!made.ok) throw new Error(made.problem);
		expect(shown(await linesOf(scope, made.id))).toEqual([
			["Site: Development", 10_500, 6000, 63_000],
		]);
		await issueInvoice(scope, owner.user.id, made.id);
		const pdf = await open(`/app/acme/invoices/${made.id}/pdf`, owner);
		const printed = new TextDecoder("latin1").decode(await pdf.arrayBuffer());
		expect(printed).toContain("(Site: Development) Tj");
		expect(printed).not.toContain("overtime");
		const xero = await (
			await open("/app/acme/invoices/xero?from=2026-11-01&to=2026-11-30", owner)
		).text();
		expect(xero).toContain(",Site: Development,10.5,60.00,");
		expect(xero).not.toContain("overtime");
	});

	it("at ×1, a recurring invoice of uninvoiced time bills overtime on its group's line", async () => {
		await scope.projects.update({ overtimeRateMilli: 1000 }, (p) => eq(p.id, siteId));
		await aLongDay();
		const [template] = await scope.recurringInvoices.insert({
			clientId,
			frequency: "monthly",
			startsOn: TODAY,
			nextIssueOn: TODAY,
			currency: "GBP",
			paymentTermsDays: 30,
			includeUninvoicedTime: true,
		});
		if (!template) throw new Error("seed failed");
		const made = await issueRecurring(
			scope,
			{ name: "Acme", ...ORGANISATION },
			template.id,
			TODAY,
			NOW,
			"en-GB",
		);
		if (!made) throw new Error("no invoice made");
		expect(shown(await linesOf(scope, made))).toEqual([["Site", 10_500, 6000, 63_000]]);
	});

	it("a recurring invoice of uninvoiced time bills overtime on its own line", async () => {
		await aLongDay();
		const [template] = await scope.recurringInvoices.insert({
			clientId,
			frequency: "monthly",
			startsOn: TODAY,
			nextIssueOn: TODAY,
			currency: "GBP",
			paymentTermsDays: 30,
			includeUninvoicedTime: true,
		});
		if (!template) throw new Error("seed failed");
		const made = await issueRecurring(
			scope,
			{ name: "Acme", ...ORGANISATION },
			template.id,
			TODAY,
			NOW,
			"en-GB",
		);
		if (!made) throw new Error("no invoice made");
		expect(shown(await linesOf(scope, made))).toEqual([
			["Site", 7500, 6000, 45_000],
			["Site (overtime)", 3000, 9000, 27_000],
		]);
	});
});

describe("the project's Overtime billed at", () => {
	async function send(fields: Record<string, string>, who: Person = owner) {
		const response = await submit(
			projectPath("acme", siteId),
			{ intent: "overtime-rate", ...fields },
			who,
			{
				byScript: true,
			},
		);
		return { status: response.status, said: await response.text() };
	}
	const stored = async () =>
		(await scope.projects.select((p) => eq(p.id, siteId)))[0]?.overtimeRateMilli;
	async function records() {
		const { results } = await env.DB.prepare(
			"select actor_id as actor, subject_id as subject, summary from activity_records where action = 'project.updated' order by rowid",
		).all<{ actor: string; subject: string; summary: string }>();
		return results.map((r) => ({ ...r, summary: JSON.parse(r.summary) }));
	}

	it("is ×1 for a new project", async () => {
		const [made] = await scope.projects.insert({ name: "New", nameKey: "new" });
		expect(made?.overtimeRateMilli).toBe(1000);
	});

	it("saves a choice or a custom multiplier, refuses one out of bounds, and is logged", async () => {
		expect((await send({ overtimeRate: "2", customRate: "" })).status).toBe(200);
		expect(await stored()).toBe(2000);
		expect((await send({ overtimeRate: "custom", customRate: "1.75" })).status).toBe(200);
		expect(await stored()).toBe(1750);

		for (const typed of ["0.5", "10.5", "1.2345", "one", ""]) {
			const refused = await send({ overtimeRate: "custom", customRate: typed });
			expect(refused.status, typed).toBe(400);
			expect(refused.said, typed).toContain(
				"Type the multiplier as a number from 1 to 10 with at most three decimals, such as 1.75.",
			);
		}
		expect(await stored()).toBe(1750);

		expect(await records()).toEqual([
			{
				actor: owner.user.id,
				subject: siteId,
				summary: { before: { overtimeRateMilli: 1500 }, after: { overtimeRateMilli: 2000 } },
			},
			{
				actor: owner.user.id,
				subject: siteId,
				summary: { before: { overtimeRateMilli: 2000 }, after: { overtimeRateMilli: 1750 } },
			},
		]);

		// The settings tab shows it.
		const page = await open(projectPath("acme", siteId, "settings"), owner);
		expect(textOf(await page.text())).toContain("Overtime billed at ×1.75 the day's rate");
	});

	it("is changed only by those who may change the project's money settings", async () => {
		const mailbox = captureEmail();
		const member = await person(mailbox, "grace@example.com");
		await seedMembership(organisationId, member.user.id, "member");
		const refused = await send({ overtimeRate: "2", customRate: "" }, member);
		expect(refused.status).toBe(403);
		expect(await stored()).toBe(1500);
		expect(await records()).toEqual([]);
	});
});
