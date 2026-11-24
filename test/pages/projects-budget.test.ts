import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { SignedIn } from "~/auth/auth.server";
import { type OrganisationScope, organisationScope } from "~/db";
import { listedBudgets, projectPage } from "~/projects/project.server";
import { byNearestLimit } from "~/projects/projects";
import { destinationPath } from "~/shell/destinations";
import { dayOf } from "~/time/calendar";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { membershipIn, seedMembership, value } from "../organisations/harness";
import { open, openData, type Person, pageBody, person, textOf } from "./harness";
import { KINDS, type Kind, seedRoles } from "./roles-seed";

// Projects shows each budget's progress (TS-122, S2-07): the project page's
// own figures for the current period, an hours budget to those who oversee
// the work, a fees budget only to those who see rates, and nothing of either
// to a member or a contractor. `?sort=limit` puts the nearest limit first.

const ACME = "acme";
const PROJECTS = destinationPath(ACME, "projects");
const HOUR = 3_600_000;

let acme: { id: string };
let scope: OrganisationScope;
let people: Record<Kind | "contractor" | "stranger", Person>;
let site: string;
let fees: string;

function membership(who: Person) {
	return membershipIn({ id: who.user.id } as SignedIn["user"], ACME);
}

async function track(
	projectId: string,
	who: Person,
	{ hoursAgo, hours, billable = true }: { hoursAgo: number; hours: number; billable?: boolean },
) {
	const start = Date.now() - hoursAgo * HOUR;
	await scope.timeEntries.insert({
		userId: who.user.id,
		projectId,
		taskId: null,
		billable,
		description: null,
		startedAt: new Date(start),
		spentOn: dayOf(start, "Europe/London"),
		endedAt: new Date(start + hours * HOUR),
	});
}

beforeEach(async () => {
	await freshDatabase();
	const mailbox = captureEmail();
	const seeded = await seedRoles(mailbox);
	acme = seeded.acme;
	scope = organisationScope(env.DB, acme.id);
	const contractor = await person(mailbox, "ida@example.com");
	await seedMembership(acme.id, contractor.user.id, "member");
	await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
		.bind(contractor.user.id)
		.run();
	const stranger = await person(mailbox, "mallory@example.com");
	people = { ...seeded.people, contractor, stranger };

	// Site: 10 hours, lifetime. Fees: £1,000, lifetime, alert at 15%.
	const [a] = await scope.projects.insert({
		name: "Site",
		nameKey: "site",
		budgetKind: "total_hours",
		budgetAmount: 600,
	});
	const [b] = await scope.projects.insert({
		name: "Fees",
		nameKey: "fees",
		budgetKind: "total_fees",
		budgetAmount: 100_000,
		budgetAlertPercent: 15,
	});
	await scope.projects.insert({ name: "Plain", nameKey: "plain" });
	if (!a || !b) throw new Error("No project was made.");
	site = a.id;
	fees = b.id;
	await scope.rates.insert({
		kind: "billable",
		projectId: fees,
		userId: null,
		taskId: null,
		amountMinor: 10_000,
		currency: "GBP",
		effectiveFrom: "2000-01-01",
	});
	await track(site, people.member, { hoursAgo: 30, hours: 1 });
	await track(fees, people.member, { hoursAgo: 28, hours: 2 });
}, 60_000);

const SEES_HOURS: Record<Kind | "contractor", boolean> = {
	owner: true,
	admin: true,
	finance: true,
	manager: true,
	member: false,
	contractor: false,
};
const SEES_FEES: Record<Kind | "contractor", boolean> = {
	owner: true,
	admin: true,
	finance: true,
	manager: false,
	member: false,
	contractor: false,
};

describe.each([...KINDS, "contractor" as const])("Projects, to the %s", (kind) => {
	it("shows an hours budget to those who oversee the work, a fees budget only to those who see rates", async () => {
		const response = await open(PROJECTS, people[kind]);
		expect(response.status).toBe(200);
		const text = textOf(await pageBody(response));
		expect(text.includes("10% of 10:00 · 9:00 left"), "hours").toBe(SEES_HOURS[kind]);
		expect(text.includes("20% of £1,000.00 · £800.00 left · past the 15% alert"), "fees").toBe(
			SEES_FEES[kind],
		);
		expect(text.includes("Nearest budget limit"), "sort").toBe(SEES_HOURS[kind]);

		// What the page is sent holds no budget the person is not shown.
		const listed = await listedBudgets(
			scope,
			await membership(people[kind]),
			[site, fees],
			Date.now(),
		);
		expect(listed.has(site)).toBe(SEES_HOURS[kind]);
		expect(listed.has(fees)).toBe(SEES_FEES[kind]);
		const data = await (await openData(PROJECTS, people[kind])).text();
		expect(data.includes("alertReached")).toBe(SEES_HOURS[kind]);
	});
});

describe("Projects, to a stranger", () => {
	it("is not there, and says nothing of any budget", async () => {
		const response = await open(PROJECTS, people.stranger);
		expect(response.status).toBe(404);
		expect(textOf(await pageBody(response))).not.toContain("10:00");
		expect((await openData(PROJECTS, people.stranger)).status).toBe(404);
	});
});

describe("ordered by the nearest limit", () => {
	it("puts the most spent first and a project with no budget last", async () => {
		const text = textOf(await pageBody(await open(`${PROJECTS}?sort=limit`, people.owner)));
		const order = ["Fees", "Site", "Plain"].map((name) => text.indexOf(` ${name} `));
		expect(order.every((at) => at > 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		const byName = textOf(await pageBody(await open(PROJECTS, people.owner)));
		expect(byName.indexOf(" Fees ")).toBeLessThan(byName.indexOf(" Plain "));
		expect(byName.indexOf(" Plain ")).toBeLessThan(byName.indexOf(" Site "));
	});

	it("a member asking for it gets the list by name", async () => {
		const text = textOf(await pageBody(await open(`${PROJECTS}?sort=limit`, people.member)));
		expect(text.indexOf(" Plain ")).toBeLessThan(text.indexOf(" Site "));
	});

	it("ranks by share spent, a spent budget of nothing first and no budget last, stable otherwise", () => {
		const at = (name: string, budget: { amount: number; spent: number; over: boolean } | null) => ({
			name,
			budget,
		});
		const ranked = byNearestLimit([
			at("none-1", null),
			at("half", { amount: 10, spent: 5, over: false }),
			at("nothing-spent", { amount: 0, spent: 3, over: true }),
			at("quarter-a", { amount: 4, spent: 1, over: false }),
			at("none-2", null),
			at("over", { amount: 10, spent: 12, over: true }),
			at("quarter-b", { amount: 8, spent: 2, over: false }),
		]);
		expect(ranked.map((p) => p.name)).toEqual([
			"nothing-spent",
			"over",
			"half",
			"quarter-a",
			"quarter-b",
			"none-1",
			"none-2",
		]);
	});
});

describe("a row's percentage", () => {
	it("is the project page's for the same period, over random budgets and entries", async () => {
		// A seeded generator, so a failure is the same failure each run.
		let seed = 122;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		const owner = await membership(people.owner);
		const kinds = ["total_hours", "total_fees"] as const;
		for (let round = 0; round < 12; round++) {
			const kind = kinds[Math.floor(random() * kinds.length)] ?? "total_hours";
			const [project] = await scope.projects.insert({
				name: `Round ${round}`,
				nameKey: `round ${round}`,
				budgetKind: kind,
				budgetAmount: Math.floor(random() * 2_000),
				budgetResetsMonthly: random() < 0.5,
			});
			if (!project) throw new Error("No project was made.");
			await scope.rates.insert({
				kind: "billable",
				projectId: project.id,
				userId: null,
				taskId: null,
				amountMinor: 1 + Math.floor(random() * 20_000),
				currency: "GBP",
				effectiveFrom: "2000-01-01",
			});
			const entries = Math.floor(random() * 5);
			for (let each = 0; each < entries; each++) {
				await track(project.id, people.member, {
					hoursAgo: 1 + Math.floor(random() * 24 * 40),
					hours: Math.max(0.25, Math.round(random() * 16) / 4),
					billable: random() < 0.8,
				});
			}
			const now = Date.now();
			const listed = (await listedBudgets(scope, owner, [project.id], now)).get(project.id);
			const page = await projectPage(scope, owner, project.id, { everyone: true }, now, "en-GB");
			expect(listed?.percent, `round ${round}`).toBe(page?.budget?.whole?.percent);
			expect(listed?.spent, `round ${round}`).toBe(page?.budget?.whole?.spent);
		}
	});

	it("is left off an archived project", async () => {
		await env.DB.prepare("update projects set archived_at = ? where id = ?")
			.bind(Date.now(), site)
			.run();
		const listed = await listedBudgets(scope, await membership(people.owner), [site], Date.now());
		expect(listed.size).toBe(0);
		expect(await value("select count(*) from projects where id = ?", site)).toBe(1);
	});
});
