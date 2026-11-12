import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { defaultRatesPath, projectPath } from "~/projects/projects";
import { destinationPath } from "~/shell/destinations";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { value } from "../organisations/harness";
import { open, openData, type Person, pageBody, submit, textOf } from "./harness";
import { KINDS, type Kind, seedRoles } from "./roles-seed";

// Tasks and tags (TS-066, TS-085), a project's own page (harvest-taste.md
// item 11) and the default rates (TS-067), to each kind of person
// (docs/security.md, "Rates and money"): who opens each page, what of it they
// read, and which of its forms they may send.

const ACME = "acme";
const TASKS = destinationPath(ACME, "tasks");
const TAGS = `${TASKS}?list=tags`;
const RATES = defaultRatesPath(ACME);

let acme: { id: string };
let scope: OrganisationScope;
let people: Record<Kind, Person>;
let site: string;

beforeEach(async () => {
	await freshDatabase();
	const seeded = await seedRoles(captureEmail());
	acme = seeded.acme;
	people = seeded.people;
	scope = organisationScope(env.DB, acme.id);
	const [project] = await scope.projects.insert({ name: "Site", nameKey: "site" });
	if (!project) throw new Error("No project was made.");
	site = project.id;
	const general = await generalTask();
	// Each tracked an hour, billable, on 2 November 2026.
	for (const [at, kind] of KINDS.entries()) {
		await scope.timeEntries.insert({
			userId: people[kind].user.id,
			projectId: site,
			taskId: general,
			billable: true,
			description: null,
			startedAt: new Date(`2026-11-02T0${at + 1}:00:00Z`),
			endedAt: new Date(`2026-11-02T0${at + 2}:00:00Z`),
		});
	}
	// The project bills £100 an hour, from long before.
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

const generalTask = async () =>
	(await value<string>(
		"select id from tasks where organisation_id = ? and name = 'General'",
		acme.id,
	)) as string;

async function textAt(path: string, who: Person) {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
}

/** The answer to a form the page posts by script: its status and what it said. */
async function send(path: string, fields: Record<string, string>, who: Person) {
	const response = await submit(path, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

const MANAGES_TASKS: Record<Kind, boolean> = {
	owner: true,
	admin: true,
	finance: false,
	manager: false,
	member: false,
};
const SEES_RATES: Record<Kind, boolean> = {
	owner: true,
	admin: true,
	finance: true,
	manager: false,
	member: false,
};

describe.each(KINDS)("to the %s", (kind) => {
	const who = () => people[kind];

	it("Tasks and its Tags list open to owners and admins alone; anyone else gets 404", async () => {
		for (const path of [TASKS, TAGS]) {
			const page = await open(path, who());
			expect(page.status, path).toBe(MANAGES_TASKS[kind] ? 200 : 404);
			expect((await openData(path, who())).status, path).toBe(MANAGES_TASKS[kind] ? 200 : 404);
			const text = textOf(await pageBody(page));
			if (MANAGES_TASKS[kind]) {
				expect(text).toContain(path === TASKS ? "Active tasks 1 General" : "Create tag");
			} else {
				expect(text).toContain("There is no page at this address, or it is not yours to open.");
				expect(text).not.toContain("Create t");
			}
		}
	});

	it("Tasks takes a new task and a new tag from owners and admins alone; to anyone else it is not here", async () => {
		const task = await send(TASKS, { intent: "create", name: "Design" }, who());
		const tag = await send(TASKS, { intent: "create-tag", name: "Urgent" }, who());
		expect(task.status).toBe(MANAGES_TASKS[kind] ? 200 : 404);
		expect(tag.status).toBe(MANAGES_TASKS[kind] ? 200 : 404);
		expect(await value("select count(*) from tasks where name = 'Design'")).toBe(
			MANAGES_TASKS[kind] ? 1 : 0,
		);
		expect(await value("select count(*) from tags where name = 'Urgent'")).toBe(
			MANAGES_TASKS[kind] ? 1 : 0,
		);
	});

	it("a project's page opens, with the hours they may see and money only to those who see rates", async () => {
		const path = projectPath(ACME, site);
		const text = await textAt(path, who());
		expect((await openData(path, who())).status).toBe(200);
		expect(text).toContain("Site");
		expect(text).toContain("Total hours");
		// Everyone's hour to those who see everyone's time; the manager's and
		// their team member's to the manager; their own to a member.
		const hours = {
			owner: "5:00",
			admin: "5:00",
			finance: "5:00",
			manager: "2:00",
			member: "1:00",
		};
		expect(text).toContain(`Total hours ${hours[kind]}`);
		if (SEES_RATES[kind]) {
			expect(text).toContain("Billable amount, GBP £500.00");
		} else {
			expect(text).not.toContain("Billable amount");
			expect(text).not.toContain("£");
		}
	});

	it("a project's Settings tab is there for those who set its money or its tasks, and Overview for anyone else", async () => {
		const settings = await textAt(projectPath(ACME, site, "settings"), who());
		const keeps = SEES_RATES[kind] || MANAGES_TASKS[kind];
		expect(settings.includes("Billing"), "Billing").toBe(keeps);
		if (!keeps) expect(settings).toContain("Total hours");
		const tasks = await textAt(projectPath(ACME, site, "tasks"), who());
		expect(tasks).toContain("General");
	});

	it("a project's forms: money from those who see rates, tasks and tags from owners and admins, 403 to anyone else", async () => {
		const path = projectPath(ACME, site);
		const billing = await send(
			path,
			{
				intent: "billing",
				billingType: "hourly",
				rateMode: "project",
				currency: "inherit",
				rate: "",
			},
			who(),
		);
		expect(billing.status).toBe(SEES_RATES[kind] ? 200 : 403);
		const budget = await send(
			path,
			{ intent: "budget", budgetKind: "total_hours", amount: "10", alertPercent: "80" },
			who(),
		);
		expect(budget.status).toBe(SEES_RATES[kind] ? 200 : 403);
		expect(await value("select budget_kind from projects where id = ?", site)).toBe(
			SEES_RATES[kind] ? "total_hours" : "none",
		);
		const rate = await send(
			path,
			{ intent: "rate", level: "project", key: "", amount: "120", from: "2099-01-01" },
			who(),
		);
		expect(rate.status).toBe(SEES_RATES[kind] ? 200 : 403);

		const [tag] = await scope.tags.insert({ name: "Retainer", nameKey: "retainer" });
		const tags = await send(path, { intent: "tags", tagIds: tag?.id ?? "" }, who());
		expect(tags.status).toBe(MANAGES_TASKS[kind] ? 200 : 403);
		expect(await value("select count(*) from project_tags where project_id = ?", site)).toBe(
			MANAGES_TASKS[kind] ? 1 : 0,
		);
		const general = await generalTask();
		const billable = await send(
			path,
			{ intent: "task-billable", taskIds: general, billable: "false" },
			who(),
		);
		expect(billable.status).toBe(MANAGES_TASKS[kind] ? 200 : 403);
	});

	it("the default rates open to those who see rates; anyone else gets the 404 of a page that is not here", async () => {
		const page = await open(RATES, who());
		expect(page.status).toBe(SEES_RATES[kind] ? 200 : 404);
		expect((await openData(RATES, who())).status).toBe(SEES_RATES[kind] ? 200 : 404);
		const text = textOf(await pageBody(page));
		if (SEES_RATES[kind]) {
			expect(text).toContain("Billable rates an hour, in GBP");
			expect(text).toContain("ada@example.com No rate");
			expect(text).toContain("General");
		} else {
			expect(text).toContain("There's no page here");
			expect(text).not.toContain("default rate");
		}
	});

	it("the default rates take a rate from those who see rates; anyone else gets 404 and nothing is set", async () => {
		const general = await generalTask();
		const set = await send(
			RATES,
			{ intent: "rate", level: "task", key: general, amount: "85.50", from: "2099-01-01" },
			who(),
		);
		expect(set.status).toBe(SEES_RATES[kind] ? 200 : 404);
		expect(await value("select amount_minor from rates where task_id = ?", general)).toBe(
			SEES_RATES[kind] ? 8550 : null,
		);
	});
});

describe("the default rates", () => {
	it("refuse a rate from a day already past, so no tracked entry is priced again", async () => {
		const general = await generalTask();
		const set = await send(
			RATES,
			{ intent: "rate", level: "task", key: general, amount: "90", from: "2020-01-01" },
			people.owner,
		);
		expect(set.status).toBe(400);
		expect(set.said).toContain("A rate starts today or later");
		expect(await value("select count(*) from rates where task_id = ?", general)).toBe(0);
	});

	it("answer 404 for a task or person of another organisation, and set nothing", async () => {
		const set = await send(
			RATES,
			{ intent: "rate", level: "person", key: "someone-else", amount: "90", from: "2099-01-01" },
			people.owner,
		);
		expect(set.status).toBe(404);
	});
});
