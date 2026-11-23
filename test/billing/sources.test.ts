import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { billableAmount, sumBillable } from "~/billing/billable";
import { type OrganisationScope, organisationScope } from "~/db";
import { addLine, createDraft, deleteDraft, deleteLine, linesOf } from "~/invoices/invoices.server";
import { type DraftLine, expenseLines, type Grouping, timeLines } from "~/invoices/lines";
import { issueRecurring } from "~/invoices/recurring.server";
import {
	mixedCurrencies,
	type SourceRequest,
	sourcesFor,
	uninvoicedTime,
} from "~/invoices/sources.server";
import { uninvoicedOf } from "~/invoices/uninvoiced.server";
import { dayOf } from "~/time/calendar";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMember, value } from "../organisations/harness";
import { open, type Person, person, submit, textOf } from "../pages/harness";
import { seedDefaultWeek } from "../pages/schedule-seed";

// What can be put on an invoice (TS-073): the preview of a client's
// uninvoiced time, expenses and fixed fees (`sourcesFor`), the lines each
// grouping makes of it, free lines, the Uninvoiced view, and the one currency.
// Time on a day over its limit is left out until the day is corrected (TR-09).

const NOW = Date.parse("2026-11-02T12:00:00Z");
const TODAY = "2026-11-02";
const ORGANISATION = { timeZone: "UTC", currency: "GBP" };
/** Site's hourly rate: £60.00, so a minute is worth exactly 100 pence. */
const SITE_RATE = 6000;
/** Every day of the week worked, 23 hours each. */
const LONG_WEEK = [1380, 1380, 1380, 1380, 1380, 1380, 1380];
/** Monday to Friday, 09:00 to 17:30 with an hour's break: 7:30 a day. */
const STANDARD_WEEK = [450, 450, 450, 450, 450, 0, 0];

let mailbox: Mailbox;
let scope: OrganisationScope;
let owner: Person;
let organisationId: string;
let clientId: string;
let siteId: string;

/** A seeded generator (mulberry32), so a failing case can be run again. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	owner = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(owner.cookie, "Acme");
	organisationId = acme.id;
	scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!client) throw new Error("seed failed");
	const [site] = await scope.projects.insert({
		name: "Site",
		nameKey: "site",
		clientId: client.id,
	});
	if (!site) throw new Error("seed failed");
	clientId = client.id;
	siteId = site.id;
	await rate({ projectId: siteId, amountMinor: SITE_RATE });
	// Every day a long working day, so that no time is over its day's limit
	// unless a test means it to be: the random cases put hours on any day.
	await seedDefaultWeek(acme.id, LONG_WEEK);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function rate(row: {
	projectId?: string | null;
	userId?: string | null;
	taskId?: string | null;
	amountMinor: number;
	currency?: string;
	effectiveFrom?: string;
}) {
	await scope.rates.insert({
		kind: "billable",
		projectId: row.projectId ?? null,
		userId: row.userId ?? null,
		taskId: row.taskId ?? null,
		amountMinor: row.amountMinor,
		currency: row.currency ?? "GBP",
		effectiveFrom: row.effectiveFrom ?? "2026-01-01",
	});
}

async function entry({
	start,
	seconds,
	projectId = siteId,
	userId = owner.user.id,
	taskId = null,
}: {
	start: string;
	seconds: number;
	projectId?: string;
	userId?: string;
	taskId?: string | null;
}) {
	const startedAt = new Date(start);
	const [row] = await scope.timeEntries.insert({
		userId,
		projectId,
		taskId,
		description: "Work",
		billable: true,
		startedAt,
		spentOn: dayOf(startedAt.getTime(), "UTC"),
		endedAt: new Date(startedAt.getTime() + seconds * 1000),
	});
	if (!row) throw new Error("seed failed");
	return row.id;
}

async function expense(projectId: string, amountMinor: number, currency = "GBP") {
	let [category] = await scope.expenseCategories.select();
	if (!category)
		[category] = await scope.expenseCategories.insert({ name: "Travel", nameKey: "travel" });
	if (!category) throw new Error("seed failed");
	const [row] = await scope.expenses.insert({
		userId: owner.user.id,
		projectId,
		categoryId: category.id,
		spentOn: "2026-10-07",
		amountMinor,
		currency,
		billable: true,
	});
	if (!row) throw new Error("seed failed");
	return row.id;
}

function request(asked: Partial<SourceRequest> = {}): SourceRequest {
	return {
		clientId,
		days: null,
		projectIds: [],
		grouping: "project",
		fixedMinor: new Map(),
		...asked,
	};
}

async function draft(lines: readonly DraftLine[]) {
	const made = await createDraft(scope, owner.user.id, {
		clientId,
		currency: "GBP",
		issuedOn: TODAY,
		lines,
		taxIds: [null, null],
	});
	if (!made.ok) throw new Error(made.problem);
	return made.id;
}

async function invoiceRow(id: string) {
	const [row] = (await scope.invoices.select()).filter((i) => i.id === id);
	if (!row) throw new Error("no such invoice");
	return row;
}

const sum = (lines: readonly { amountMinor: number }[]) =>
	lines.reduce((total, line) => total + line.amountMinor, 0);

describe("the preview", () => {
	it("flags entries in periods that are not approved, and hides none of them", async () => {
		const approvedDay = await entry({ start: "2026-10-05T09:00:00Z", seconds: 3600 });
		const submittedDay = await entry({ start: "2026-10-12T09:00:00Z", seconds: 5400 });
		const noPeriod = await entry({ start: "2026-10-20T09:00:00Z", seconds: 1800 });
		const grace = await seedMember(organisationId, "member", "grace@example.com");
		const decided = { submittedAt: new Date(), decidedBy: owner.user.id, decidedAt: new Date() };
		await scope.periods.insert({
			userId: owner.user.id,
			startsOn: "2026-10-05",
			endsOn: "2026-10-11",
			status: "approved",
			...decided,
		});
		await scope.periods.insert({
			userId: owner.user.id,
			startsOn: "2026-10-12",
			endsOn: "2026-10-18",
			status: "submitted",
			submittedAt: new Date(),
		});
		// Somebody else's approved week approves nothing of Ada's.
		await scope.periods.insert({
			userId: grace.userId,
			startsOn: "2026-10-12",
			endsOn: "2026-10-25",
			status: "approved",
			...decided,
		});

		const sources = await sourcesFor(scope, ORGANISATION, request({ grouping: "entry" }), NOW);
		expect(sources.entries.map((e) => [e.id, e.approved])).toEqual([
			[approvedDay, true],
			[submittedDay, false],
			[noPeriod, false],
		]);
		// Flagged, not left off: every one of them is on a line.
		expect(sources.lines.flatMap((l) => l.timeEntryIds).sort()).toEqual(
			[approvedDay, submittedDay, noPeriod].sort(),
		);
		expect(sum(sources.lines)).toBe(100 * (60 + 90 + 30));
	});
});

describe("groupings", () => {
	it("property: for every grouping the subtotal is the sum of the entries' billable amounts", async () => {
		const next = random(73);
		const grace = await seedMember(organisationId, "member", "grace@example.com");
		const linus = await seedMember(organisationId, "member", "linus@example.com");
		const people = [owner.user.id, grace.userId, linus.userId];
		const [design] = await scope.tasks.insert({ name: "Design", nameKey: "design" });
		const [build] = await scope.tasks.insert({ name: "Build", nameKey: "build" });
		const [unpriced] = await scope.tasks.insert({ name: "Admin", nameKey: "admin" });
		const [byPerson] = await scope.projects.insert({
			name: "Support",
			nameKey: "support",
			clientId,
			rateMode: "person",
		});
		const [byTask] = await scope.projects.insert({
			name: "Build",
			nameKey: "build",
			clientId,
			rateMode: "task",
		});
		if (!design || !build || !unpriced || !byPerson || !byTask) throw new Error("seed failed");
		const projects = [siteId, byPerson.id, byTask.id];
		const tasks = [null, design.id, build.id, unpriced.id];

		// Each person's rate changes on 15 October; Design and Build have rates, Admin none.
		const personRates = new Map<string, [number, number]>();
		for (const id of people) {
			const rates: [number, number] = [
				500 + Math.floor(next() * 20_000),
				500 + Math.floor(next() * 20_000),
			];
			personRates.set(id, rates);
			await rate({ userId: id, amountMinor: rates[0], effectiveFrom: "2026-01-01" });
			await rate({ userId: id, amountMinor: rates[1], effectiveFrom: "2026-10-15" });
		}
		const taskRates = new Map([
			[design.id, 500 + Math.floor(next() * 20_000)],
			[build.id, 500 + Math.floor(next() * 20_000)],
		]);
		for (const [taskId, amountMinor] of taskRates) await rate({ taskId, amountMinor });

		const rateOf = (e: {
			projectId: string;
			userId: string;
			taskId: string | null;
			day: string;
		}) => {
			if (e.projectId === siteId) return SITE_RATE;
			if (e.projectId === byPerson.id) {
				const [before, after] = personRates.get(e.userId) ?? [0, 0];
				return e.day >= "2026-10-15" ? after : before;
			}
			return e.taskId ? (taskRates.get(e.taskId) ?? null) : null;
		};
		const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T;

		for (let run = 0; run < 10; run++) {
			await env.DB.prepare("delete from time_entries").run();
			const seeded: { id: string; minutes: number; rate: number | null }[] = [];
			const count = 1 + Math.floor(next() * 12);
			for (let i = 0; i < count; i++) {
				const day = `2026-10-${String(1 + Math.floor(next() * 28)).padStart(2, "0")}`;
				const at = `${day}T${String(Math.floor(next() * 20)).padStart(2, "0")}:${String(Math.floor(next() * 60)).padStart(2, "0")}:${String(Math.floor(next() * 60)).padStart(2, "0")}Z`;
				const seconds = 1 + Math.floor(next() * 4 * 3600);
				const shape = { projectId: pick(projects), userId: pick(people), taskId: pick(tasks), day };
				const id = await entry({ start: at, seconds, ...shape });
				seeded.push({ id, minutes: Math.floor(seconds / 60), rate: rateOf(shape) });
			}
			const expected = sumBillable(
				seeded.map(({ minutes, rate }) =>
					billableAmount({
						minutes,
						billable: true,
						billingType: "hourly",
						rate: rate === null ? null : { amountMinor: rate },
					}),
				),
			);
			const billed = seeded
				.filter((e) => e.rate !== null && e.minutes > 0)
				.map((e) => e.id)
				.sort();

			for (const grouping of ["project", "task", "person", "entry"] satisfies Grouping[]) {
				const sources = await sourcesFor(scope, ORGANISATION, request({ grouping }), NOW);
				const label = `run ${run}, ${grouping}`;
				expect(sources.entries, label).toHaveLength(count);
				expect(sources.problem, label).toBeNull();
				expect(sum(sources.lines), label).toBe(expected);
				expect(sources.lines.flatMap((l) => l.timeEntryIds).sort(), label).toEqual(billed);
				if (grouping === "entry") expect(sources.lines, label).toHaveLength(billed.length);
				if (sources.lines.length === 0) continue;
				const id = await draft(sources.lines);
				expect((await invoiceRow(id)).subtotalMinor, label).toBe(expected);
				expect((await deleteDraft(scope, owner.user.id, id))?.ok, label).toBe(true);
			}
		}
	});
});

describe("fixed fees", () => {
	it("a fixed-fee project adds one line for its fee, or the part of it chosen", async () => {
		const [brand] = await scope.projects.insert({
			name: "Brand",
			nameKey: "brand",
			clientId,
			billingType: "fixed_fee",
			feeMinor: 500_000,
		});
		if (!brand) throw new Error("seed failed");
		// Its tracked time is no line of its own: the fee is what is billed.
		await entry({ start: "2026-10-05T09:00:00Z", seconds: 7200, projectId: brand.id });
		const only = { projectIds: [brand.id] };
		const fixedLine = (amountMinor: number) => ({
			kind: "fixed",
			description: "Brand: fixed fee",
			projectId: brand.id,
			quantityMilli: 1000,
			unitPriceMinor: amountMinor,
			amountMinor,
			timeEntryIds: [],
			expenseIds: [],
		});

		const whole = await sourcesFor(scope, ORGANISATION, request(only), NOW);
		expect(whole.lines).toEqual([fixedLine(500_000)]);

		const part = await sourcesFor(
			scope,
			ORGANISATION,
			request({ ...only, fixedMinor: new Map([[brand.id, 200_000]]) }),
			NOW,
		);
		expect(part.lines).toEqual([fixedLine(200_000)]);
		const first = await draft(part.lines);

		// What is left, never more than that.
		const left = await sourcesFor(
			scope,
			ORGANISATION,
			request({ ...only, fixedMinor: new Map([[brand.id, 900_000]]) }),
			NOW,
		);
		expect(left.lines).toEqual([fixedLine(300_000)]);
		await draft(left.lines);
		expect((await sourcesFor(scope, ORGANISATION, request(only), NOW)).lines).toEqual([]);

		// Deleting a draft gives its part of the fee back.
		expect((await deleteDraft(scope, owner.user.id, first))?.ok).toBe(true);
		expect((await sourcesFor(scope, ORGANISATION, request(only), NOW)).lines).toEqual([
			fixedLine(200_000),
		]);
	});
});

describe("free lines", () => {
	it("change the total but never what is invoiced", async () => {
		const a = await entry({ start: "2026-10-05T09:00:00Z", seconds: 3600 });
		const b = await entry({ start: "2026-10-06T09:00:00Z", seconds: 3600 });
		const c = await entry({ start: "2026-10-07T09:00:00Z", seconds: 3600 });
		const preview = await sourcesFor(scope, ORGANISATION, request(), NOW);
		const chosen = preview.entries.filter((e) => e.id === a || e.id === b);
		const id = await draft(timeLines(chosen, "project"));
		expect((await invoiceRow(id)).totalMinor).toBe(12_000);
		const sources = () => value("select count(*) from invoice_line_sources");
		const waiting = async () =>
			(await uninvoicedTime(scope, ORGANISATION, [siteId], null, NOW)).entries.map((e) => e.id);
		expect(await sources()).toBe(2);
		expect(await waiting()).toEqual([c]);

		const added = await addLine(scope, owner.user.id, id, {
			description: "Workshop",
			quantityMilli: 1500,
			unitPriceMinor: 4000,
			taxId: null,
			secondTaxId: null,
		});
		expect(added?.ok).toBe(true);
		expect((await invoiceRow(id)).totalMinor).toBe(18_000);
		expect(await sources()).toBe(2);
		expect(await waiting()).toEqual([c]);

		const free = (await linesOf(scope, id)).find((l) => l.description === "Workshop");
		expect((await deleteLine(scope, owner.user.id, id, free?.id ?? ""))?.ok).toBe(true);
		expect((await invoiceRow(id)).totalMinor).toBe(12_000);
		expect(await sources()).toBe(2);
		expect(await waiting()).toEqual([c]);
	});
});

describe("the Uninvoiced view", () => {
	it("property: it is the billable total less what has been invoiced", async () => {
		const next = random(11);
		const [brand] = await scope.projects.insert({
			name: "Brand",
			nameKey: "brand",
			clientId,
			billingType: "fixed_fee",
			feeMinor: 250_000,
		});
		if (!brand) throw new Error("seed failed");
		let billable = 250_000;
		for (let i = 0; i < 12; i++) {
			const seconds = 60 + Math.floor(next() * 5 * 3600);
			const day = String(1 + Math.floor(next() * 28)).padStart(2, "0");
			await entry({ start: `2026-10-${day}T08:00:00Z`, seconds });
			billable += Math.floor(seconds / 60) * (SITE_RATE / 60);
		}
		for (let i = 0; i < 4; i++) {
			const amountMinor = 100 + Math.floor(next() * 50_000);
			await expense(i % 2 === 0 ? siteId : brand.id, amountMinor);
			billable += amountMinor;
		}
		const waiting = async () => sum(await uninvoicedOf(scope, ORGANISATION, null, NOW));
		expect(await waiting()).toBe(billable);

		let invoiced = 0;
		const drafts: { id: string; subtotal: number }[] = [];
		for (let round = 0; round < 4; round++) {
			const preview = await sourcesFor(scope, ORGANISATION, request(), NOW);
			const entries = preview.entries.filter(() => next() < 0.5);
			const expenses = preview.expenses.filter(() => next() < 0.5);
			const fee = preview.fixed[0];
			const lines = [
				...timeLines(entries, "entry"),
				...expenseLines(expenses),
				...(fee && next() < 0.5
					? [
							{
								kind: "fixed" as const,
								description: "Brand: fixed fee",
								projectId: brand.id,
								quantityMilli: 1000,
								unitPriceMinor: 50_000,
								amountMinor: Math.min(50_000, fee.amountMinor),
								timeEntryIds: [],
								expenseIds: [],
							},
						]
					: []),
			];
			if (lines.length === 0) continue;
			const id = await draft(lines);
			const subtotal = (await invoiceRow(id)).subtotalMinor;
			drafts.push({ id, subtotal });
			invoiced += subtotal;
			expect(await waiting(), `round ${round}`).toBe(billable - invoiced);
		}
		expect(drafts.length).toBeGreaterThan(0);

		// Deleting a draft puts what it held back.
		const [first] = drafts;
		if (!first) throw new Error("no draft");
		await deleteDraft(scope, owner.user.id, first.id);
		expect(await waiting()).toBe(billable - invoiced + first.subtotal);
	});
});

describe("one currency", () => {
	it("refuses projects, or expenses, in more than one currency", async () => {
		const [abroad] = await scope.projects.insert({
			name: "Abroad",
			nameKey: "abroad",
			clientId,
			currency: "USD",
		});
		if (!abroad) throw new Error("seed failed");
		await rate({ projectId: abroad.id, amountMinor: 9000, currency: "USD" });
		await entry({ start: "2026-10-05T09:00:00Z", seconds: 3600 });
		await entry({ start: "2026-10-05T11:00:00Z", seconds: 3600, projectId: abroad.id });

		const mixed = await sourcesFor(scope, ORGANISATION, request(), NOW);
		expect(mixed.problem).toBe(mixedCurrencies(["GBP", "USD"]));
		expect(mixed.currency).toBeNull();

		const dollars = await sourcesFor(
			scope,
			ORGANISATION,
			request({ projectIds: [abroad.id] }),
			NOW,
		);
		expect(dollars.problem).toBeNull();
		expect(dollars.currency).toBe("USD");
		expect(sum(dollars.lines)).toBe(9000);

		// The form that saves a draft refuses it, and nothing is saved.
		const response = await submit("/app/acme/invoices/new", { client: clientId }, owner, {
			byScript: true,
		});
		expect(response.status).toBe(400);
		expect(await value("select count(*) from invoices")).toBe(0);

		// A project's expense in another currency is refused as well.
		await expense(siteId, 1234, "EUR");
		const euros = await sourcesFor(scope, ORGANISATION, request({ projectIds: [siteId] }), NOW);
		expect(euros.problem).toBe(mixedCurrencies(["EUR", "GBP"]));
	});
});

describe("time on a day over its limit", () => {
	/** A member called `name`, their address the first word of it. */
	async function member(name: string) {
		const email = `${name.split(" ")[0]?.toLowerCase()}@example.com`;
		const { userId } = await seedMember(organisationId, "member", email);
		await env.DB.prepare("update users set name = ? where id = ?").bind(name, userId).run();
		return userId;
	}

	beforeEach(async () => {
		// Overtime is not allowed (the default), and a day takes 7:30.
		await seedDefaultWeek(organisationId, STANDARD_WEEK);
	});

	it("time on a day over its limit is not offered", async () => {
		const grace = await member("Grace Hopper");
		// Tuesday 10 February: a timer kept whole at 9:00 on a 7:30 day.
		const long = await entry({ start: "2026-02-10T09:00:00Z", seconds: 9 * 3600, userId: grace });
		const fine = await entry({ start: "2026-02-09T09:00:00Z", seconds: 3600, userId: grace });
		const said =
			"1 entry of Grace's is on a day over its limit (Tue 10). It is left out until the day is corrected.";

		const sources = await sourcesFor(scope, ORGANISATION, request({ grouping: "entry" }), NOW);
		expect(sources.entries.map((e) => e.id)).toEqual([fine]);
		expect(sources.lines.flatMap((l) => l.timeEntryIds)).toEqual([fine]);
		expect(sources.leftOut).toEqual([said]);
		// The Uninvoiced view counts what an invoice would take.
		expect(sum(await uninvoicedOf(scope, ORGANISATION, null, NOW))).toBe(100 * 60);
		// The preview page says so, and the draft it saves leaves it out.
		const page = await open(`/app/acme/invoices/new?client=${clientId}`, owner);
		expect(textOf(await page.text())).toContain(said);
		const saved = await submit("/app/acme/invoices/new", { client: clientId }, owner);
		expect(saved.status).toBe(302);
		expect(
			await value("select count(*) from invoice_line_sources where time_entry_id = ?", long),
		).toBe(0);
		expect(
			await value("select count(*) from invoice_line_sources where time_entry_id = ?", fine),
		).toBe(1);

		// Trimmed to 7:30, the day is within its limit and its time is offered.
		await scope.timeEntries.update({ endedAt: new Date("2026-02-10T16:30:00Z") }, (t) =>
			eq(t.id, long),
		);
		const corrected = await sourcesFor(scope, ORGANISATION, request(), NOW);
		expect(corrected.entries.map((e) => e.id)).toEqual([long]);
		expect(corrected.leftOut).toEqual([]);
		expect(sum(corrected.lines)).toBe(100 * 450);
	});

	it("says how many entries of whose are left out, and on which days", async () => {
		const grace = await member("Grace Hopper");
		const linus = await member("Linus Torvalds");
		await entry({ start: "2026-02-10T09:00:00Z", seconds: 9 * 3600, userId: grace });
		await entry({ start: "2026-02-11T08:00:00Z", seconds: 4 * 3600, userId: grace });
		await entry({ start: "2026-02-11T13:00:00Z", seconds: 4 * 3600, userId: grace });
		await entry({ start: "2026-02-09T08:00:00Z", seconds: 4 * 3600, userId: linus });
		await entry({ start: "2026-02-09T13:00:00Z", seconds: 4 * 3600, userId: linus });
		// Saturday is no working day here, and overtime is not allowed.
		await entry({ start: "2026-02-14T09:00:00Z", seconds: 3600 });

		const sources = await sourcesFor(scope, ORGANISATION, request(), NOW);
		expect(sources.entries).toEqual([]);
		expect(sources.lines).toEqual([]);
		expect(sources.leftOut).toEqual([
			"1 entry of ada's is on a day over its limit (Sat 14). It is left out until the day is corrected.",
			"3 entries of Grace's are on days over their limit (Tue 10, Wed 11). They are left out until the days are corrected.",
			"2 entries of Linus's are on a day over its limit (Mon 9). They are left out until the day is corrected.",
		]);
	});

	it("a recurring invoice of uninvoiced time leaves it out, and its page says so", async () => {
		const grace = await member("Grace Hopper");
		const long = await entry({ start: "2026-02-10T09:00:00Z", seconds: 9 * 3600, userId: grace });
		const fine = await entry({ start: "2026-02-09T09:00:00Z", seconds: 3600, userId: grace });
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
		const said =
			"1 entry of Grace's is on a day over its limit (Tue 10). It is left out until the day is corrected.";

		const page = await open(`/app/acme/invoices/recurring/${template.id}`, owner);
		expect(textOf(await page.text())).toContain(said);

		const made = await issueRecurring(
			scope,
			{ name: "Acme", ...ORGANISATION },
			template.id,
			TODAY,
			NOW,
			"en-GB",
		);
		if (!made) throw new Error("no invoice made");
		const lines = await linesOf(scope, made);
		expect(lines.map((l) => [l.description, l.quantityMilli, l.amountMinor])).toEqual([
			["Site", 1000, 6000],
		]);
		expect(
			await value("select count(*) from invoice_line_sources where time_entry_id = ?", long),
		).toBe(0);
		expect(
			await value("select count(*) from invoice_line_sources where time_entry_id = ?", fine),
		).toBe(1);
	});
});
