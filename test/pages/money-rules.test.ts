import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectBudget } from "~/budgets/budget.server";
import { type OrganisationScope, organisationScope, users } from "~/db";
import { membershipOf } from "~/organisations/membership.server";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import { projectPath } from "~/projects/projects";
import { destinationPath } from "~/shell/destinations";
import { TAG_NAME_TAKEN, TAG_NOT_OFFERED } from "~/tags/tags.server";
import { TASK_NOT_OFFERED } from "~/tasks/tasks.server";
import { trackChoices } from "~/tasks/track.server";
import { dayOf } from "~/time/calendar";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { value } from "../organisations/harness";
import { parseCsv } from "../reports/csv";
import { open, type Person, pageBody, submit, textOf } from "./harness";
import { type Kind, seedRoles } from "./roles-seed";

// The rules of tasks (TS-066), billable time and its rates (TS-067), budgets
// (TS-069) and tags (TS-085), through the Worker where a person meets them:
// an archived task or tag is offered to nothing new and kept by what has it;
// a change of what is billed re-rates the entries no invoice bills; each kind
// of budget counts what it should, a monthly one from the organisation's own
// midnight; its alert goes out once; a project over budget warns those
// tracking to it; a tag's name is the organisation's once; and a report
// filtered by a tag, and its export, hold that tag's time alone.

const ACME = "acme";
const TIMESHEET = `${destinationPath(ACME, "timesheet")}?index`;
const TASKS = destinationPath(ACME, "tasks");
const REPORTS = destinationPath(ACME, "reports");
const EXPORT = `${REPORTS}/export`;
/** A Wednesday, 10:00 UTC. */
const T0 = Date.parse("2026-11-11T10:00:00Z");

let mailbox: Mailbox;
let acme: { id: string };
let scope: OrganisationScope;
let people: Record<Kind, Person>;
let site: string;
let general: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	const seeded = await seedRoles(mailbox);
	acme = seeded.acme;
	people = seeded.people;
	scope = organisationScope(env.DB, acme.id);
	const [project] = await scope.projects.insert({ name: "Site", nameKey: "site" });
	if (!project) throw new Error("No project was made.");
	site = project.id;
	general = (await value<string>(
		"select id from tasks where organisation_id = ? and name_key = 'general'",
		acme.id,
	)) as string;
	// The project bills £100 an hour.
	await scope.rates.insert({
		kind: "billable",
		projectId: site,
		userId: null,
		taskId: null,
		amountMinor: 10_000,
		currency: "GBP",
		effectiveFrom: "2026-01-01",
	});
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** The server's clock, fixed at `at` for what follows. */
function clockAt(at: number) {
	vi.spyOn(Date, "now").mockReturnValue(at);
}

/** The answer to a form a page posts by script: its status and what it said. */
async function send(path: string, fields: Record<string, string>, who: Person = people.owner) {
	const response = await submit(path, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

/** An entry of `who` on Site, as the database holds it. */
async function seedEntry(
	who: Person,
	from: string,
	to: string,
	more: { taskId?: string | null; billable?: boolean; projectId?: string } = {},
) {
	const [entry] = await scope.timeEntries.insert({
		userId: who.user.id,
		projectId: more.projectId ?? site,
		taskId: more.taskId === undefined ? general : more.taskId,
		billable: more.billable ?? true,
		description: "Work",
		startedAt: new Date(from),
		endedAt: new Date(to),
	});
	if (!entry) throw new Error("No entry was made.");
	return entry.id;
}

const billableOf = async (entryId: string) =>
	Boolean(await value<number>("select billable from time_entries where id = ?", entryId));

/** A task of Acme made on the Tasks page and put on every project. */
async function createTask(name: string): Promise<string> {
	const made = await send(TASKS, { intent: "create", name, addToAllProjects: "on" });
	expect(made.status, made.said).toBe(200);
	return (await value<string>("select id from tasks where name = ?", name)) as string;
}

/** A tag of Acme made on the Tasks page. */
async function createTag(name: string): Promise<string> {
	const made = await send(TASKS, { intent: "create-tag", name });
	expect(made.status, made.said).toBe(200);
	return (await value<string>("select id from tags where name = ?", name)) as string;
}

/** The figures of Site's budget at `now`, counted in `zone`, as the page and the alert read them. */
async function siteBudget(now: number, zone = "UTC") {
	const [project] = await scope.projects.select();
	if (!project) throw new Error("No project.");
	const money = await organisationMoney(acme.id);
	return projectBudget(scope, project, {
		zone,
		now,
		money,
		pricing: await pricingOf(scope, money.currency),
	});
}

/** Gives Site a budget straight in the database: the page's form is tested apart. */
async function budgetSite(
	kind: string,
	amount: number | null,
	more: { resetsMonthly?: boolean; warnMembers?: boolean; alertPercent?: number | null } = {},
) {
	await scope.projects.update(
		{
			budgetKind: kind,
			budgetAmount: amount,
			budgetResetsMonthly: more.resetsMonthly ?? false,
			budgetWarnMembers: more.warnMembers ?? false,
			budgetAlertPercent: more.alertPercent === undefined ? 80 : more.alertPercent,
		},
		(p) => eq(p.id, site),
	);
}

describe("an archived task", () => {
	it("is offered to no new entry, and kept by the entries that have it", async () => {
		clockAt(T0);
		const design = await createTask("Design");
		const tracked = await send(
			TIMESHEET,
			{ intent: "track", projectId: site, day: "2026-11-10", hours: "1", taskId: design },
			people.member,
		);
		expect(tracked.status, tracked.said).toBe(200);
		const entryId = (await value<string>(
			"select id from time_entries where task_id = ?",
			design,
		)) as string;

		expect((await send(TASKS, { intent: "archive", taskId: design })).status).toBe(200);

		const refused = await send(
			TIMESHEET,
			{ intent: "track", projectId: site, day: "2026-11-10", hours: "1", taskId: design },
			people.member,
		);
		expect(refused.status).toBe(400);
		expect(refused.said).toContain(TASK_NOT_OFFERED);
		expect(await value("select count(*) from time_entries")).toBe(1);

		// Its entry is changed and keeps the task.
		const edited = await send(
			TIMESHEET,
			{
				intent: "edit",
				entryId,
				projectId: site,
				date: "2026-11-10",
				start: "09:00",
				end: "11:00",
				description: "Survey",
				taskId: design,
			},
			people.member,
		);
		expect(edited.status, edited.said).toBe(200);
		expect(await value("select task_id from time_entries where id = ?", entryId)).toBe(design);

		// With no task chosen, a new entry has the project's first active task.
		const plain = await send(
			TIMESHEET,
			{ intent: "track", projectId: site, day: "2026-11-10", hours: "1" },
			people.member,
		);
		expect(plain.status, plain.said).toBe(200);
		expect(await value("select count(*) from time_entries where task_id = ?", general)).toBe(1);

		// Restored, it is offered again.
		expect((await send(TASKS, { intent: "restore", taskId: design })).status).toBe(200);
		const again = await send(
			TIMESHEET,
			{ intent: "track", projectId: site, day: "2026-11-10", hours: "1", taskId: design },
			people.member,
		);
		expect(again.status, again.said).toBe(200);
	});

	it("cannot be added to a project", async () => {
		const design = await createTask("Design");
		await send(projectPath(ACME, site), { intent: "remove-task", taskId: design });
		await send(TASKS, { intent: "archive", taskId: design });
		const added = await send(projectPath(ACME, site), { intent: "add-task", taskId: design });
		expect(added.status).toBe(400);
		expect(
			await value(
				"select count(*) from project_tasks where project_id = ? and task_id = ?",
				site,
				design,
			),
		).toBe(0);
	});
});

describe("re-rating", () => {
	/** An invoice of Acme that bills `entryId`. */
	async function invoice(entryId: string) {
		const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
		const [bill] = await scope.invoices.insert({
			number: "1",
			clientId: client?.id ?? "",
			currency: "GBP",
			issuedOn: "2026-11-10",
			dueOn: "2026-12-10",
		});
		const [line] = await scope.invoiceLines.insert({
			invoiceId: bill?.id ?? "",
			position: 0,
			kind: "time",
			description: "Work",
			quantityMilli: 1000,
			unitPriceMinor: 10_000,
			amountMinor: 10_000,
		});
		await scope.invoiceLineSources.insert({ lineId: line?.id ?? "", timeEntryId: entryId });
	}

	it("of a task made non-billable changes the entries no invoice bills, and keeps those billed", async () => {
		const billed = await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z");
		const unbilled = await seedEntry(people.member, "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z");
		await invoice(billed);

		const changed = await send(projectPath(ACME, site), {
			intent: "task-billable",
			taskIds: general,
			billable: "false",
		});
		expect(changed.status, changed.said).toBe(200);
		expect(await billableOf(unbilled)).toBe(false);
		expect(await billableOf(billed)).toBe(true);

		await send(projectPath(ACME, site), {
			intent: "task-billable",
			taskIds: general,
			billable: "true",
		});
		expect(await billableOf(unbilled)).toBe(true);
	});

	it("of a project made non-billable and back changes the entries no invoice bills alone", async () => {
		const billed = await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z");
		const unbilled = await seedEntry(people.member, "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z");
		await invoice(billed);
		const billing = (billingType: string) =>
			send(projectPath(ACME, site), {
				intent: "billing",
				billingType,
				rateMode: "project",
				currency: "inherit",
				rate: "",
			});

		expect((await billing("non_billable")).status).toBe(200);
		expect(await billableOf(unbilled)).toBe(false);
		expect(await billableOf(billed)).toBe(true);
		// A non-billable project has no billable task.
		const refused = await send(projectPath(ACME, site), {
			intent: "task-billable",
			taskIds: general,
			billable: "true",
		});
		expect(refused.status).toBe(400);
		expect(refused.said).toContain("A non-billable project has no billable task.");

		// Billed again, each entry is billable as its task is by default.
		expect((await billing("hourly")).status).toBe(200);
		expect(await billableOf(unbilled)).toBe(true);
		expect(await billableOf(billed)).toBe(true);
	});

	it("prices the billable hours at the rate in force on each entry's day", async () => {
		await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z");
		await seedEntry(people.member, "2026-11-03T09:00:00Z", "2026-11-03T11:00:00Z");
		// From 3 November, £150 an hour: the earlier hour keeps £100.
		await scope.rates.insert({
			kind: "billable",
			projectId: site,
			userId: null,
			taskId: null,
			amountMinor: 15_000,
			currency: "GBP",
			effectiveFrom: "2026-11-03",
		});
		const text = textOf(await pageBody(await open(projectPath(ACME, site), people.owner)));
		expect(text).toContain("Billable amount, GBP £400.00");
	});
});

describe("a budget", () => {
	const NOW = Date.parse("2026-11-20T12:00:00Z");
	let design: string;

	beforeEach(async () => {
		design = (
			await scope.tasks.insert({ name: "Design", nameKey: "design", billableByDefault: true })
		)[0]?.id as string;
		await scope.projectTasks.insert({ projectId: site, taskId: design, billable: true });
		// Linus two hours on General, Hedy one on Design, and a non-billable half hour.
		await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T11:00:00Z");
		await seedEntry(people.manager, "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z", {
			taskId: design,
		});
		await seedEntry(people.manager, "2026-11-04T09:00:00Z", "2026-11-04T09:30:00Z", {
			taskId: design,
			billable: false,
		});
	});

	it("of total hours counts every hour, the non-billable too unless the organisation says not", async () => {
		const set = await send(projectPath(ACME, site), {
			intent: "budget",
			budgetKind: "total_hours",
			amount: "4",
			alertPercent: "",
		});
		expect(set.status, set.said).toBe(200);
		expect(await value("select budget_amount from projects where id = ?", site)).toBe(240);
		const budget = await siteBudget(NOW);
		expect(budget?.total).toEqual({ spent: 210, remaining: 30, percent: 87, over: false });

		await env.DB.prepare("update organisations set budget_counts_non_billable = 0 where id = ?")
			.bind(acme.id)
			.run();
		expect((await siteBudget(NOW))?.total?.spent).toBe(180);
	});

	it("of total fees counts the billable time at its rates", async () => {
		await budgetSite("total_fees", 25_000);
		const budget = await siteBudget(NOW);
		expect(budget?.hours).toBe(false);
		expect(budget?.currency).toBe("GBP");
		expect(budget?.total).toEqual({ spent: 30_000, remaining: -5_000, percent: 120, over: true });
	});

	it("by task counts each task's hours against its line, and the whole is the lines' sum", async () => {
		await budgetSite("task_hours", null);
		await scope.budgetLines.insert([
			{ projectId: site, taskId: general, userId: null, amount: 60 },
			{ projectId: site, taskId: design, userId: null, amount: 120 },
		]);
		const budget = await siteBudget(NOW);
		expect(budget?.amount).toBe(180);
		expect(budget?.lines.map(({ key, status }) => [key, status.spent, status.over])).toEqual(
			expect.arrayContaining([
				[general, 120, true],
				[design, 90, false],
			]),
		);
		expect(budget?.total).toEqual({ spent: 210, remaining: -30, percent: 116, over: true });
	});

	it("by person counts each person's hours against theirs", async () => {
		await budgetSite("person_hours", null);
		await scope.budgetLines.insert([
			{ projectId: site, taskId: null, userId: people.member.user.id, amount: 180 },
			{ projectId: site, taskId: null, userId: people.manager.user.id, amount: 60 },
		]);
		const budget = await siteBudget(NOW);
		expect(budget?.lines.map(({ key, status }) => [key, status.spent, status.over])).toEqual(
			expect.arrayContaining([
				[people.member.user.id, 120, false],
				[people.manager.user.id, 90, true],
			]),
		);
	});

	it("of fees by task counts each task's billable money against its line", async () => {
		await budgetSite("task_fees", null);
		await scope.budgetLines.insert([
			{ projectId: site, taskId: general, userId: null, amount: 20_000 },
			{ projectId: site, taskId: design, userId: null, amount: 5_000 },
		]);
		const budget = await siteBudget(NOW);
		expect(budget?.lines.map(({ key, status }) => [key, status.spent, status.over])).toEqual(
			expect.arrayContaining([
				[general, 20_000, false],
				[design, 10_000, true],
			]),
		);
	});

	it("with no line set has no whole, and is never over", async () => {
		await budgetSite("task_hours", null);
		const budget = await siteBudget(NOW);
		expect(budget?.total).toBeNull();
		expect(budget?.amount).toBeNull();
	});
});

describe("a monthly budget", () => {
	const AUCKLAND = "Pacific/Auckland";

	beforeEach(async () => {
		await budgetSite("total_hours", 600, { resetsMonthly: true });
		// 23:30 and 00:30 in Auckland (UTC+13), either side of its midnight into
		// December; both on 30 November in UTC.
		await seedEntry(people.member, "2026-11-30T10:30:00Z", "2026-11-30T11:00:00Z");
		await seedEntry(people.member, "2026-11-30T11:30:00Z", "2026-11-30T12:00:00Z");
	});

	it("starts again at the organisation's own midnight on the first of the month", async () => {
		// 23:50 on 30 November in Auckland: both are November's, the first alone counted.
		const before = await siteBudget(Date.parse("2026-11-30T10:50:00Z"), AUCKLAND);
		expect(before?.period).toEqual({ startsOn: "2026-11-01", endsOn: "2026-11-30" });
		expect(before?.total?.spent).toBe(30);

		// 00:10 on 1 December in Auckland: December's budget holds the half hour after its midnight.
		const after = await siteBudget(Date.parse("2026-11-30T11:10:00Z"), AUCKLAND);
		expect(after?.period).toEqual({ startsOn: "2026-12-01", endsOn: "2026-12-31" });
		expect(after?.total?.spent).toBe(30);

		// In UTC both are 30 November's.
		const utc = await siteBudget(Date.parse("2026-11-30T23:00:00Z"));
		expect(utc?.period.startsOn).toBe("2026-11-01");
		expect(utc?.total?.spent).toBe(60);
	});
});

describe("a budget's alert", () => {
	const subject = "A project has reached its budget alert on Timesifier";
	const alerts = () => mailbox.sent().filter((message) => message.subject === subject);

	it("goes out once a period, to owners, admins and the managers of those who tracked, when time crosses it", async () => {
		clockAt(T0);
		await budgetSite("total_hours", 120, { alertPercent: 80 });
		await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z");
		const track = () =>
			send(
				TIMESHEET,
				{ intent: "track", projectId: site, day: "2026-11-10", hours: "1" },
				people.member,
			);

		expect((await track()).status).toBe(200);
		expect(alerts().map(({ to }) => to)).toEqual([
			"ada@example.com",
			"grace@example.com",
			"hedy@example.com",
		]);
		expect(alerts()[0]?.text).toContain(`${projectPath(ACME, site)}`);
		expect(await value("select count(*) from budget_alerts")).toBe(1);

		// Past it again, and over: nothing more this period.
		expect((await track()).status).toBe(200);
		expect(alerts()).toHaveLength(3);
		expect(await value("select count(*) from budget_alerts")).toBe(1);
	});

	it("of a fees budget goes to owners and admins, not to managers, who see no money", async () => {
		clockAt(T0);
		await budgetSite("total_fees", 10_000, { alertPercent: 50 });
		const tracked = await send(
			TIMESHEET,
			{ intent: "track", projectId: site, day: "2026-11-10", hours: "1" },
			people.member,
		);
		expect(tracked.status).toBe(200);
		expect(alerts().map(({ to }) => to)).toEqual(["ada@example.com", "grace@example.com"]);
	});

	it("is not sent below it, nor with no alert set", async () => {
		clockAt(T0);
		await budgetSite("total_hours", 600, { alertPercent: 80 });
		await send(
			TIMESHEET,
			{ intent: "track", projectId: site, day: "2026-11-10", hours: "1" },
			people.member,
		);
		await budgetSite("total_hours", 60, { alertPercent: null });
		await send(
			TIMESHEET,
			{ intent: "track", projectId: site, day: "2026-11-10", hours: "1" },
			people.member,
		);
		expect(alerts()).toEqual([]);
	});
});

describe("the over-budget warning", () => {
	async function warned(now: number) {
		const [user] = await drizzle(env.DB)
			.select()
			.from(users)
			.where(eq(users.id, people.member.user.id));
		if (!user) throw new Error("No user.");
		const membership = await membershipOf(user, ACME);
		if (!membership) throw new Error("No membership.");
		return (await trackChoices(scope, membership, [], now)).overBudget;
	}

	it("names a project over its budget whose people are warned, and no other", async () => {
		const now = Date.parse("2026-11-20T12:00:00Z");
		await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T11:00:00Z");
		await budgetSite("total_hours", 60, { warnMembers: true });
		expect(await warned(now)).toEqual([site]);

		// Not warned: no warning, though over.
		await budgetSite("total_hours", 60, { warnMembers: false });
		expect(await warned(now)).toEqual([]);

		// Warned, at its budget and not past it: no warning yet.
		await budgetSite("total_hours", 120, { warnMembers: true });
		expect(await warned(now)).toEqual([]);

		// Archived: offered to nobody, so nobody is warned.
		await budgetSite("total_hours", 60, { warnMembers: true });
		await scope.projects.update({ archivedAt: new Date(now) }, (p) => eq(p.id, site));
		expect(await warned(now)).toEqual([]);
	});
});

describe("a budget's spent, for random entries (property)", () => {
	/** A small, seeded generator (mulberry32), so a failing case can be run again. */
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
	const ZONES = ["Europe/London", "Pacific/Auckland", "America/Los_Angeles", "UTC"];
	const FROM = Date.parse("2026-11-28T00:00:00Z");
	const SPAN = 6 * 86_400_000;

	it("is every whole minute of the entries that start in the period, in the organisation's zone", async () => {
		const next = random(66_069);
		for (let run = 0; run < 25; run++) {
			await scope.timeEntries.delete((e) => eq(e.projectId, site));
			const zone = ZONES[Math.floor(next() * ZONES.length)] as string;
			const monthly = next() < 0.7;
			await budgetSite("total_hours", 6_000, { resetsMonthly: monthly });
			const starts: { at: number; seconds: number }[] = [];
			const count = 1 + Math.floor(next() * 6);
			for (let i = 0; i < count; i++) {
				const at = FROM + Math.floor(next() * SPAN);
				const seconds = 60 + Math.floor(next() * 3 * 3_600);
				starts.push({ at, seconds });
				await seedEntry(
					people.member,
					new Date(at).toISOString(),
					new Date(at + seconds * 1000).toISOString(),
					{ billable: next() < 0.5 },
				);
			}
			const now = FROM + Math.floor(next() * SPAN);
			const month = dayOf(now, zone).slice(0, 7);
			const counted = starts.filter(({ at }) => !monthly || dayOf(at, zone).slice(0, 7) === month);
			const expected = Math.floor(counted.reduce((sum, { seconds }) => sum + seconds, 0) / 60);

			const budget = await siteBudget(now, zone);
			expect(budget?.total?.spent, `run ${run}: ${zone}, monthly ${monthly}`).toBe(expected);
		}
	});
});

describe("billable time", () => {
	/** A project billed in euros at €80 an hour. */
	async function euroProject() {
		const [euro] = await scope.projects.insert({ name: "Euro", nameKey: "euro", currency: "EUR" });
		const id = euro?.id ?? "";
		await scope.rates.insert({
			kind: "billable",
			projectId: id,
			userId: null,
			taskId: null,
			amountMinor: 8_000,
			currency: "EUR",
			effectiveFrom: "2026-01-01",
		});
		return id;
	}
	const WEEK = "range=custom&from=2026-11-02&to=2026-11-08";

	it("is split from the rest on a report, with what it is worth in each currency, never added across them, for those who see rates alone", async () => {
		const euro = await euroProject();
		await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T11:00:00Z");
		await seedEntry(people.member, "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z", {
			billable: false,
		});
		await seedEntry(people.member, "2026-11-04T09:00:00Z", "2026-11-04T10:00:00Z", {
			projectId: euro,
		});

		const owners = textOf(await pageBody(await open(`${REPORTS}?${WEEK}`, people.owner)));
		expect(owners).toContain("Billable hours 3:00");
		expect(owners).toContain("Non-billable hours 1:00");
		expect(owners).toContain("Billable amount, GBP £200.00");
		expect(owners).toContain("Billable amount, EUR €80.00");

		const managers = textOf(await pageBody(await open(`${REPORTS}?${WEEK}`, people.manager)));
		expect(managers).toContain("Billable hours 3:00");
		expect(managers).toContain("Non-billable hours 1:00");
		expect(managers).not.toContain("Billable amount");
		expect(managers).not.toMatch(/[£€]/);
	});

	it("with no rate is listed on its project's page as Missing rate, and counts 0", async () => {
		// Billed by person, and nobody has a rate.
		await scope.projects.update({ rateMode: "person" }, (p) => eq(p.id, site));
		await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T10:30:00Z");

		const owners = textOf(await pageBody(await open(projectPath(ACME, site), people.owner)));
		expect(owners).toContain(
			"1 billable entry has no rate. Each counts 0 in the amount until it has one.",
		);
		expect(owners).toContain("linus@example.com");
		expect(owners).toContain("linus@example.com Monday 2 November · General 1:30 Missing rate");
		expect(owners).toContain("Billable amount, GBP £0.00");

		const reports = textOf(await pageBody(await open(`${REPORTS}?${WEEK}`, people.owner)));
		expect(reports).toContain("1 billable entry has no rate.");

		const managers = textOf(await pageBody(await open(projectPath(ACME, site), people.manager)));
		expect(managers).not.toContain("Missing rate");
	});

	it("is in the organisation's currency, or its client's, or its project's own, the nearest one", async () => {
		const SETTINGS = destinationPath(ACME, "settings");
		const changed = await send(SETTINGS, { intent: "currency", currency: "USD" });
		expect(changed.status, changed.said).toBe(200);
		const amountOn = async () =>
			/Billable amount, ([A-Z]{3})/.exec(
				textOf(await pageBody(await open(projectPath(ACME, site), people.owner))),
			)?.[1];
		expect(await amountOn()).toBe("USD");
		const [client] = await scope.clients.insert({
			name: "Initech",
			nameKey: "initech",
			currency: "EUR",
		});
		await scope.projects.update({ clientId: client?.id ?? null }, (p) => eq(p.id, site));
		expect(await amountOn()).toBe("EUR");
		await scope.projects.update({ currency: "JPY" }, (p) => eq(p.id, site));
		expect(await amountOn()).toBe("JPY");
		// Finance, shown no Workspace settings, cannot change the currency there.
		expect(
			(await send(SETTINGS, { intent: "currency", currency: "GBP" }, people.finance)).status,
		).toBe(404);
	});

	it("non-billable counts against hour budgets until an owner or admin says not, on Workspace settings", async () => {
		const SETTINGS = destinationPath(ACME, "settings");
		const counts = () =>
			value("select budget_counts_non_billable from organisations where id = ?", acme.id);
		expect(await counts()).toBe(1);
		const off = await send(SETTINGS, { intent: "budget-hours" });
		expect(off.status, off.said).toBe(200);
		expect(off.said).toContain("Only billable hours now count against hour budgets.");
		expect(await counts()).toBe(0);
		const on = await send(
			SETTINGS,
			{ intent: "budget-hours", countNonBillable: "on" },
			people.admin,
		);
		expect(on.status).toBe(200);
		expect(await counts()).toBe(1);
	});

	it("of a fixed-fee project needs its fee", async () => {
		const billing = (fee: string) =>
			send(projectPath(ACME, site), {
				intent: "billing",
				billingType: "fixed_fee",
				rateMode: "project",
				currency: "inherit",
				fee,
				rate: "",
			});
		expect((await billing("")).status).toBe(400);
		const set = await billing("5000");
		expect(set.status, set.said).toBe(200);
		expect(await value("select fee_minor from projects where id = ?", site)).toBe(500_000);
	});
});

describe("a project's budget on its page", () => {
	beforeEach(async () => {
		await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T11:00:00Z");
	});

	it("in fees is shown to those who see rates alone", async () => {
		await budgetSite("total_fees", 50_000);
		const owners = textOf(await pageBody(await open(projectPath(ACME, site), people.owner)));
		expect(owners).toContain("£200.00 spent of £500.00");
		expect(owners).toContain("£300.00 remaining · 40%");
		const managers = textOf(await pageBody(await open(projectPath(ACME, site), people.manager)));
		expect(managers).not.toContain("spent of");
		expect(managers).not.toContain("£");
	});

	it("in hours is shown to those who oversee the work, a manager too, as spent, remaining and %; a member is only warned", async () => {
		await budgetSite("total_hours", 300);
		for (const who of [people.owner, people.admin, people.finance, people.manager]) {
			const text = textOf(await pageBody(await open(projectPath(ACME, site), who)));
			expect(text, who.user.email).toContain("2:00 spent of 5:00");
			expect(text, who.user.email).toContain("3:00 remaining · 40%");
		}
		const members = textOf(await pageBody(await open(projectPath(ACME, site), people.member)));
		expect(members).toContain("Total hours 2:00");
		expect(members).not.toContain("spent of");
	});
});

describe("a tag", () => {
	it("has a name no other tag of the organisation has, in any case", async () => {
		await createTag("Urgent");
		const again = await send(TASKS, { intent: "create-tag", name: "  urgent " });
		expect(again.status).toBe(400);
		expect(again.said).toContain(TAG_NAME_TAKEN);

		const research = await createTag("Research");
		const renamed = await send(TASKS, { intent: "rename-tag", tagId: research, name: "URGENT" });
		expect(renamed.status).toBe(400);
		expect(renamed.said).toContain(TAG_NAME_TAKEN);
		expect(await value("select count(*) from tags")).toBe(2);
	});

	it("archived, is put on nothing new, and stays on what has it", async () => {
		clockAt(T0);
		const urgent = await createTag("Urgent");
		const tracked = await send(
			TIMESHEET,
			{ intent: "track", projectId: site, day: "2026-11-10", hours: "1", tagIds: urgent },
			people.member,
		);
		expect(tracked.status, tracked.said).toBe(200);
		const entryId = (await value<string>("select time_entry_id from entry_tags")) as string;

		expect((await send(TASKS, { intent: "archive-tag", tagId: urgent })).status).toBe(200);

		const refused = await send(
			TIMESHEET,
			{ intent: "track", projectId: site, day: "2026-11-10", hours: "1", tagIds: urgent },
			people.member,
		);
		expect(refused.status).toBe(400);
		expect(refused.said).toContain(TAG_NOT_OFFERED);

		const onProject = await send(projectPath(ACME, site), { intent: "tags", tagIds: urgent });
		expect(onProject.status).toBe(400);
		expect(onProject.said).toContain(TAG_NOT_OFFERED);

		// The entry that has it is changed and keeps it.
		const edited = await send(
			TIMESHEET,
			{
				intent: "edit",
				entryId,
				projectId: site,
				date: "2026-11-10",
				start: "09:00",
				end: "10:30",
				description: "Survey",
				tagIds: urgent,
			},
			people.member,
		);
		expect(edited.status, edited.said).toBe(200);
		expect(await value("select count(*) from entry_tags where tag_id = ?", urgent)).toBe(1);
	});

	it("filters a report, and its export, to the time with it on the entry or on its project", async () => {
		const research = await createTag("Research");
		const [other] = await scope.projects.insert({ name: "Billing", nameKey: "billing" });
		const otherId = other?.id ?? "";
		const tagged = await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z");
		await seedEntry(people.member, "2026-11-02T10:00:00Z", "2026-11-02T12:00:00Z");
		const onProject = await seedEntry(
			people.manager,
			"2026-11-03T09:00:00Z",
			"2026-11-03T12:00:00Z",
			{ projectId: otherId },
		);
		await scope.entryTags.insert({ timeEntryId: tagged, tagId: research });
		await scope.projectTags.insert({ projectId: otherId, tagId: research });
		const week = "range=custom&from=2026-11-02&to=2026-11-08";

		const all = textOf(await pageBody(await open(`${REPORTS}?${week}`, people.owner)));
		expect(all).toMatch(/Total 6:00/);
		const page = await open(`${REPORTS}?${week}&tag=${research}`, people.owner);
		expect(page.status).toBe(200);
		const html = await pageBody(page);
		expect(textOf(html)).toMatch(/Total 4:00/);
		// The export link keeps the filter.
		expect(html).toContain(`tag=${research}`);

		const response = await open(`${EXPORT}?${week}&tag=${research}`, people.owner);
		expect(response.status).toBe(200);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const [header, ...rows] = parseCsv(
			new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.slice(3)),
		);
		const ids = rows.map((cells) => cells[header?.indexOf("entry_id") ?? 0]).sort();
		expect(ids).toEqual([tagged, onProject].sort());
	});

	it("is a report filter of Acme's alone: another organisation's tag holds nothing", async () => {
		await seedEntry(people.member, "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z");
		const page = await open(
			`${REPORTS}?range=custom&from=2026-11-02&to=2026-11-08&tag=not-a-tag`,
			people.owner,
		);
		expect(page.status).toBe(200);
		expect(textOf(await pageBody(page))).not.toMatch(/Total 1:00/);
	});
});
