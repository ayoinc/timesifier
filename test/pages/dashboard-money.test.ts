import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { createDraft, issueInvoice } from "~/invoices/invoices.server";
import { formatMoney } from "~/money/money";
import { projectPath } from "~/projects/projects";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam } from "../organisations/harness";
import { open, type Person, pageBody, person, textOf } from "./harness";

// The money on Dashboards and on a project's page (TS-086, TS-071), through
// the Worker, for each role: an owner, an admin, Finance, a manager (a member
// who manages a team) and a member. What is waiting to be invoiced and what is
// owed are shown to those who see rates, one figure per currency, each equal
// to its own page's total; a project's revenue, cost, profit and margin over a
// range equal its row of the Profitability report over the same range. A
// manager and a member are shown no amount.

const DASHBOARDS = "/app/acme/dashboards";
const UNINVOICED = "/app/acme/invoices/uninvoiced";
const RECEIVABLES = "/app/acme/invoices/reports?report=receivables";
const PROFITABILITY = "/app/acme/reports/profitability";
/** Monday 5 to Sunday 11 October 2026: a week in the past, so the clock does not move it. */
const WEEK = "range=custom&from=2026-10-05&to=2026-10-11";
const LOCALE = "en-GB";

let scope: OrganisationScope;
let ada: Person;
let grace: Person;
let hedy: Person;
let linus: Person;
let fin: Person;
let initech: string;
let globex: string;
let site: string;
let launch: string;

type RoleName = "owner" | "admin" | "manager" | "member" | "finance";
const ROLES = (): Record<RoleName, Person> => ({
	owner: ada,
	admin: grace,
	manager: hedy,
	member: linus,
	finance: fin,
});
const SEE_RATES = ["owner", "admin", "finance"] as const;
const SEE_NO_RATES = ["manager", "member"] as const;

async function track(who: Person, projectId: string, from: string, to: string, billable = true) {
	await scope.timeEntries.insert({
		userId: who.user.id,
		projectId,
		description: "Work",
		startedAt: new Date(from),
		endedAt: new Date(to),
		billable,
	});
}

/** The page at `path` as `who` reads it, after checking it answered `status`. */
async function html(path: string, who: Person, status = 200): Promise<string> {
	const response = await open(path, who);
	expect(response.status, path).toBe(status);
	return pageBody(response);
}

const read = async (path: string, who: Person, status = 200) =>
	textOf(await html(path, who, status));

/** An issued invoice of one line for `amountMinor` to `clientId`, due on `issuedOn`. */
async function issued(clientId: string, amountMinor: number, currency: string, issuedOn: string) {
	const made = await createDraft(scope, ada.user.id, {
		clientId,
		currency,
		issuedOn,
		paymentTermsDays: 0,
		taxIds: [null, null],
		lines: [
			{
				kind: "manual",
				description: "Work",
				projectId: null,
				quantityMilli: 1000,
				unitPriceMinor: amountMinor,
				amountMinor,
				timeEntryIds: [],
				expenseIds: [],
			},
		],
	});
	if (!made.ok) throw new Error(made.problem);
	expect((await issueInvoice(scope, ada.user.id, made.id))?.ok).toBe(true);
}

/** £400 owed by Initech and $130 by Globex. */
async function issueInvoices() {
	await issued(initech, 400_00, "GBP", "2026-10-01");
	await issued(globex, 130_00, "USD", "2026-10-20");
}

/** Amounts as the pages write them, one per currency, joined as they join them. */
const figures = (...amounts: [number, string][]) =>
	amounts.map(([minor, currency]) => formatMoney(minor, currency, LOCALE)).join(" · ");

beforeEach(async () => {
	await freshDatabase();
	const mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(ada.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	grace = await person(mailbox, "grace@example.com");
	hedy = await person(mailbox, "hedy@example.com");
	linus = await person(mailbox, "linus@example.com");
	fin = await person(mailbox, "fin@example.com");
	await seedMembership(acme.id, grace.user.id, "admin");
	await seedMembership(acme.id, hedy.user.id, "member");
	await seedMembership(acme.id, linus.user.id, "member");
	await seedMembership(acme.id, fin.user.id, "finance");
	// Hedy manages Design, which Linus is in.
	await seedTeam(acme.id, "Design", { members: [linus.user.id], managers: [hedy.user.id] });

	const [one, two] = await scope.clients.insert([
		{ name: "Initech", nameKey: "initech" },
		{ name: "Globex", nameKey: "globex", currency: "USD" },
	]);
	if (!one || !two) throw new Error("seed failed");
	initech = one.id;
	globex = two.id;

	const [hourly, fixed, portal] = await scope.projects.insert([
		{
			name: "Site",
			nameKey: "site",
			billingType: "hourly",
			rateMode: "project",
			clientId: initech,
		},
		// £3,000 over the 30 days of 1 to 30 October: £100 a day, £700 in the week.
		{
			name: "Launch",
			nameKey: "launch",
			billingType: "fixed_fee",
			feeMinor: 3000_00,
			startsOn: "2026-10-01",
			endsOn: "2026-10-30",
			clientId: initech,
		},
		// Billed in Globex's dollars.
		{
			name: "Portal",
			nameKey: "portal",
			billingType: "hourly",
			rateMode: "project",
			clientId: globex,
		},
	]);
	if (!hourly || !fixed || !portal) throw new Error("seed failed");
	site = hourly.id;
	launch = fixed.id;
	await scope.rates.insert([
		{
			kind: "billable",
			projectId: site,
			amountMinor: 100_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "billable",
			projectId: portal.id,
			amountMinor: 50_00,
			currency: "USD",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "cost",
			userId: ada.user.id,
			amountMinor: 40_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
		{
			kind: "cost",
			userId: linus.user.id,
			amountMinor: 30_00,
			currency: "GBP",
			effectiveFrom: "2026-01-01",
		},
	]);

	// Ada: 3 billable hours on Site, 2 on Launch and 1 on Portal. Linus: 2 billable
	// hours on Site. Hedy: 1 non-billable hour on Site, with no cost rate.
	await track(ada, site, "2026-10-05T09:00:00Z", "2026-10-05T12:00:00Z");
	await track(ada, launch, "2026-10-06T09:00:00Z", "2026-10-06T11:00:00Z");
	await track(ada, portal.id, "2026-10-06T13:00:00Z", "2026-10-06T14:00:00Z");
	await track(linus, site, "2026-10-05T09:00:00Z", "2026-10-05T11:00:00Z");
	await track(hedy, site, "2026-10-05T13:00:00Z", "2026-10-05T14:00:00Z", false);
	// A billable £25 of Ada's on Site.
	const [category] = await scope.expenseCategories.insert({ name: "Taxis", nameKey: "taxis" });
	if (!category) throw new Error("seed failed");
	await scope.expenses.insert({
		userId: ada.user.id,
		projectId: site,
		categoryId: category.id,
		spentOn: "2026-10-07",
		amountMinor: 25_00,
		currency: "GBP",
		billable: true,
	});
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Dashboards' uninvoiced and receivables panels (TS-086)", () => {
	it.each(SEE_RATES)(
		"show the %s what is waiting to be invoiced, one total per currency, equal to Uninvoiced's",
		async (role) => {
			const who = ROLES()[role];
			// Site: 5 h × £100 + £25 of expenses; Launch: its whole fee; Portal: 1 h × $50.
			const expected = figures([3525_00, "GBP"], [50_00, "USD"]);
			const board = await read(`${DASHBOARDS}?${WEEK}`, who);
			expect(board).toContain(`Uninvoiced ${expected}`);
			expect(await read(UNINVOICED, who)).toContain(`Everything until today ${expected}`);
			expect(await html(`${DASHBOARDS}?${WEEK}`, who)).toContain(`href="${UNINVOICED}"`);
		},
	);

	it.each(SEE_RATES)(
		"show the %s what clients owe, one total per currency, equal to the Receivables report's",
		async (role) => {
			await issueInvoices();
			const who = ROLES()[role];
			const expected = figures([400_00, "GBP"], [130_00, "USD"]);
			const board = await read(`${DASHBOARDS}?${WEEK}`, who);
			expect(board).toContain(`Outstanding ${expected}`);
			expect(await read(RECEIVABLES, who)).toContain(`Total ${expected}`);
			expect(await html(`${DASHBOARDS}?${WEEK}`, who)).toContain(`href="${RECEIVABLES}"`);
		},
	);

	it("says nothing is owed, with the way to an invoice, when no invoice is open", async () => {
		const board = await read(`${DASHBOARDS}?${WEEK}`, ada);
		expect(board).toContain("Nothing is owed: every issued invoice is paid. Create an invoice");
		expect(await html(`${DASHBOARDS}?${WEEK}`, ada)).toContain('href="/app/acme/invoices/new"');
	});

	it("shows a manager no amount and neither panel", async () => {
		await issueInvoices();
		const board = await read(`${DASHBOARDS}?${WEEK}`, hedy);
		expect(board).not.toContain("Uninvoiced");
		expect(board).not.toContain("Outstanding");
		expect(board).not.toMatch(/£|US\$/);
	});

	it("is not offered to a member", async () => {
		await read(`${DASHBOARDS}?${WEEK}`, linus, 404);
	});
});

/** Revenue, cost, margin and profit of `project`'s row in the Profitability report's text. */
function reportRow(text: string, project: string, type: string): string[] {
	const found = new RegExp(
		`${project} Initech · ${type} Revenue (\\S+) · Cost (\\S+) · margin (\\S+) (\\S+)`,
	).exec(text);
	if (!found) throw new Error(`No row for ${project} in: ${text.slice(0, 600)}`);
	return found.slice(1);
}

/** Revenue, cost, margin and profit on a project's page. */
function pageProfit(text: string): string[] {
	const found = /Revenue (\S+) Cost (\S+) Margin (\S+) Profit (\S+)/.exec(text);
	if (!found) throw new Error(`No profit in: ${text.slice(0, 600)}`);
	return found.slice(1);
}

describe("profit on a project's page (TS-071)", () => {
	it.each(SEE_RATES)(
		"shows the %s an hourly project's row of the Profitability report",
		async (role) => {
			const who = ROLES()[role];
			const report = await read(`${PROFITABILITY}?${WEEK}`, who);
			const shown = pageProfit(await read(`${projectPath("acme", site)}?${WEEK}`, who));
			// Revenue: 5 h × £100 + the £25 billable expense. Cost: 3 h × £40 + 2 h × £30
			// + £25; Hedy's hour has no cost rate.
			expect(shown).toEqual(reportRow(report, "Site", "Hourly"));
			const [revenue, cost, , profit] = shown;
			expect([revenue, cost, profit]).toEqual(["£525.00", "£205.00", "£320.00"]);
		},
	);

	it.each(SEE_RATES)(
		"shows the %s a fixed-fee project's row, its fee spread over its days",
		async (role) => {
			const who = ROLES()[role];
			const report = await read(`${PROFITABILITY}?${WEEK}`, who);
			const shown = pageProfit(await read(`${projectPath("acme", launch)}?${WEEK}`, who));
			// Revenue: 7 of its 30 days of £3,000. Cost: 2 h × £40.
			expect(shown).toEqual(reportRow(report, "Launch", "Fixed fee"));
			expect(shown).toEqual(["£700.00", "£80.00", "89%", "£620.00"]);
		},
	);

	it("links to the Profitability report over the same range, and is over this month when the address names none", async () => {
		const ranged = (await html(`${projectPath("acme", site)}?${WEEK}`, ada)).replaceAll(
			"&amp;",
			"&",
		);
		expect(ranged).toContain(
			`href="${PROFITABILITY}?range=custom&from=2026-10-05&to=2026-10-11&group=project"`,
		);
		const plain = (await html(projectPath("acme", site), ada)).replaceAll("&amp;", "&");
		expect(plain).toContain(`href="${PROFITABILITY}?range=this-month&group=project"`);
	});

	it.each(SEE_NO_RATES)("shows the %s no profit and no amount", async (role) => {
		const text = await read(`${projectPath("acme", site)}?${WEEK}`, ROLES()[role]);
		expect(text).not.toContain("Open profitability");
		expect(text).not.toMatch(/Revenue|Margin|£/);
	});
});
