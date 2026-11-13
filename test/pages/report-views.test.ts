import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { dayOf } from "~/time/calendar";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam } from "../organisations/harness";
import { parseCsv } from "../reports/csv";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";
import { seedLeave } from "./leave-seed";

// The views of Reports beside Time (TS-068 Utilisation, TS-071 Profitability,
// TS-084 Leave, TS-080 Saved) and Dashboards (TS-086), through the Worker, for
// each role: an owner, an admin, a manager (a member who manages a team), a
// member, and Finance. Each view lists only the people the viewer may see,
// and the money views only to those who see rates.

const BASE = "/app/acme/reports";
const DASHBOARDS = "/app/acme/dashboards";
/** Monday 5 to Sunday 11 October 2026: a week in the past, so the clock does not move it. */
const WEEK = "range=custom&from=2026-10-05&to=2026-10-11";

let mailbox: Mailbox;
let acme: { id: string };
let scope: OrganisationScope;
let ada: Person;
let grace: Person;
let hedy: Person;
let linus: Person;
let fin: Person;

type RoleName = "owner" | "admin" | "manager" | "member" | "finance";
const ROLES = (): Record<RoleName, Person> => ({
	owner: ada,
	admin: grace,
	manager: hedy,
	member: linus,
	finance: fin,
});

async function track(who: Person, projectId: string, from: string, to: string, billable = true) {
	await scope.timeEntries.insert({
		userId: who.user.id,
		projectId,
		description: "Work",
		startedAt: new Date(from),
		spentOn: dayOf(Date.parse(from), "UTC"),
		endedAt: new Date(to),
		billable,
	});
}

/** The text of the page at `path` as `who` reads it, after checking it answered `status`. */
async function read(path: string, who: Person, status = 200): Promise<string> {
	const response = await open(path, who);
	expect(response.status).toBe(status);
	return textOf(await pageBody(response));
}

/** The figure a dashboard panel headed `label` shows beside its heading. */
function panel(text: string, label: string): string {
	const found = new RegExp(`\\b${label} (\\S+)`).exec(text)?.[1];
	if (found === undefined) throw new Error(`No ${label} panel`);
	return found;
}

/** The figure read out as `label` in a view's headline. */
function headline(text: string, label: string): string {
	const found = new RegExp(`${label}: (\\S+)`).exec(text)?.[1];
	if (found === undefined) throw new Error(`No ${label} headline in: ${text.slice(0, 400)}`);
	return found;
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
	fin = await person(mailbox, "fin@example.com");
	await seedMembership(acme.id, grace.user.id, "admin");
	await seedMembership(acme.id, hedy.user.id, "member");
	await seedMembership(acme.id, linus.user.id, "member");
	await seedMembership(acme.id, fin.user.id, "finance");
	// Hedy manages Design, which Linus is in.
	await seedTeam(acme.id, "Design", { members: [linus.user.id], managers: [hedy.user.id] });

	const [site, launch] = await scope.projects.insert([
		{ name: "Site", nameKey: "site", billingType: "hourly", rateMode: "project" },
		// £3,000 over the 30 days of 1 to 30 October: £100 a day, £700 in the week.
		{
			name: "Launch",
			nameKey: "launch",
			billingType: "fixed_fee",
			feeMinor: 3000_00,
			startsOn: "2026-10-01",
			endsOn: "2026-10-30",
		},
	]);
	if (!site || !launch) throw new Error("seed failed");
	await scope.rates.insert([
		{
			kind: "billable",
			projectId: site.id,
			amountMinor: 100_00,
			currency: "GBP",
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

	// Ada: 3 billable hours on Site and 2 on Launch. Linus: 2 billable hours on Site.
	// Hedy: 1 non-billable hour on Site.
	await track(ada, site.id, "2026-10-05T09:00:00Z", "2026-10-05T12:00:00Z");
	await track(ada, launch.id, "2026-10-06T09:00:00Z", "2026-10-06T11:00:00Z");
	await track(linus, site.id, "2026-10-05T09:00:00Z", "2026-10-05T11:00:00Z");
	await track(hedy, site.id, "2026-10-05T13:00:00Z", "2026-10-05T14:00:00Z", false);
	// Linus is on approved annual leave for 3 of the week's 5 working days.
	await seedLeave(acme.id, linus.user.id, "annual", "2026-10-07", "2026-10-09");
}, 60_000);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("the tabs of Reports", () => {
	it.each([
		["owner", true],
		["admin", true],
		["finance", true],
		["manager", false],
		["member", false],
	] as const)("show Profitability to the %s: %s", async (role, shown) => {
		const html = await pageBody(await open(`${BASE}?${WEEK}`, ROLES()[role]));
		expect(html).toContain('aria-label="Report views"');
		expect(html.includes(`${BASE}/profitability?`)).toBe(shown);
		expect(html).toContain(`${BASE}/utilisation?`);
		expect(html).toContain(`${BASE}/leave?`);
	});
});

describe("Utilisation (TS-068)", () => {
	it.each([
		["owner", ["ada", "fin", "grace", "hedy", "linus"]],
		["admin", ["ada", "fin", "grace", "hedy", "linus"]],
		["manager", ["hedy", "linus"]],
		["member", ["linus"]],
		["finance", ["ada", "fin", "grace", "hedy", "linus"]],
	] as const)("lists to the %s only the people they may see", async (role, people) => {
		const text = await read(`${BASE}/utilisation?${WEEK}`, ROLES()[role]);
		const listed = ["ada", "fin", "grace", "hedy", "linus"].filter((name) =>
			text.includes(`${name}@example.com`),
		);
		expect(listed).toEqual(people);
	});

	it("measures time against capacity less approved leave", async () => {
		// Linus's capacity is 2 of 5 days (3 on leave): 15:00 at 7:30 a day; 2:00 tracked.
		const text = await read(`${BASE}/utilisation?${WEEK}&person=${linus.user.id}`, ada);
		expect(text).toContain("2:00 of 15:00 capacity");
		expect(headline(text, "Utilisation")).toBe("13%");
	});

	it("shows — for a person on leave all week", async () => {
		await seedLeave(acme.id, linus.user.id, "annual", "2026-10-12", "2026-10-16");
		const text = await read(
			`${BASE}/utilisation?range=custom&from=2026-10-12&to=2026-10-18&person=${linus.user.id}`,
			ada,
		);
		expect(text).toContain("0:00 of 0:00 capacity");
		expect(headline(text, "Utilisation")).toBe("—");
	});
});

describe("Profitability (TS-071)", () => {
	it.each(["manager", "member"] as const)("is a 404 to the %s", async (role) => {
		await read(`${BASE}/profitability?${WEEK}`, ROLES()[role], 404);
	});

	it.each(["owner", "admin", "finance"] as const)(
		"shows the %s Harvest's arithmetic",
		async (role) => {
			const text = await read(`${BASE}/profitability?${WEEK}`, ROLES()[role]);
			// Site: revenue 5 h × £100 = £500; cost 3 h × £40 + 2 h × £30 = £180, Hedy's hour no rate.
			// Launch: revenue 7 days × £100 = £700; cost 2 h × £40 = £80.
			// Profit: £1,200 − £260 = £940.
			expect(headline(text, "Profit")).toBe("£940.00");
			expect(text).toContain("on £1,200.00 revenue, £260.00 cost");
			// Hedy's hour has no cost rate, and the page says so.
			expect(text).toMatch(/costing nothing: hedy\S* \(1:00\)/);
		},
	);
});

describe("Cost rates (TS-071)", () => {
	it.each(["owner", "admin", "finance"] as const)(
		"the %s gives a person a cost rate from a date",
		async (role) => {
			const response = await submit(
				`${BASE}/profitability`,
				{ intent: "cost-rate", userId: hedy.user.id, amount: "25.00", effectiveFrom: "2026-10-01" },
				ROLES()[role],
				{ byScript: true },
			);
			expect(response.status).toBe(200);
			const found = await env.DB.prepare(
				"select amount_minor as amount, currency, effective_from as start from rates where kind = 'cost' and user_id = ?",
			)
				.bind(hedy.user.id)
				.first();
			expect(found).toEqual({ amount: 25_00, currency: "GBP", start: "2026-10-01" });
		},
	);

	it.each(["manager", "member"] as const)("refuses the %s with a 404", async (role) => {
		const response = await submit(
			`${BASE}/profitability`,
			{ intent: "cost-rate", userId: hedy.user.id, amount: "25.00", effectiveFrom: "2026-10-01" },
			ROLES()[role],
			{ byScript: true },
		);
		expect(response.status).toBe(404);
		expect(
			await env.DB.prepare("select count(*) as n from rates where user_id = ?")
				.bind(hedy.user.id)
				.first("n"),
		).toBe(0);
	});
});

describe("Leave balances (TS-084)", () => {
	it.each([
		["owner", ["ada", "fin", "grace", "hedy", "linus"]],
		["manager", ["hedy", "linus"]],
		["member", ["linus"]],
		["finance", ["fin"]],
	] as const)("lists to the %s only the people whose leave they may see", async (role, people) => {
		const who = ROLES()[role];
		const response = await open(`${BASE}/leave/export?year=2026`, who);
		expect(response.status).toBe(200);
		const [, ...rows] = parseCsv((await response.text()).replace(/^\uFEFF/, ""));
		expect([...new Set(rows.map((cells) => cells[1]?.split("@")[0]))].sort()).toEqual(people);
	});

	it("counts 3 days of a 5-day week, and the export adds up as the screen does", async () => {
		const text = await read(`${BASE}/leave?year=2026&person=${linus.user.id}`, ada);
		const response = await open(`${BASE}/leave/export?year=2026&person=${linus.user.id}`, ada);
		const [header, ...rows] = parseCsv((await response.text()).replace(/^\uFEFF/, ""));
		const column = (name: string) => header?.indexOf(name) ?? -1;
		const annual = rows.find((cells) => cells[column("kind")] === "Annual leave");
		expect(annual?.[column("taken_days")]).toBe("3");
		const taken = rows.reduce((sum, cells) => sum + Number(cells[column("taken_days")] || 0), 0);
		const booked = rows.reduce((sum, cells) => sum + Number(cells[column("booked_days")] || 0), 0);
		const pending = rows.reduce(
			(sum, cells) => sum + Number(cells[column("pending_days")] || 0),
			0,
		);
		expect([taken, booked, pending]).toEqual([3, 0, 0]);
		expect(text).toContain("3 days taken · 0 days booked · 0 days pending");
		const remaining = Number(annual?.[column("remaining_days")]);
		expect(text).toContain(`${remaining} days left`);
	});
});

describe("Team's week (TS-084)", () => {
	it("shows Expected, Leave and Logged: a 3-day leave in a 5-day week leaves 2/5 of capacity", async () => {
		const text = await read("/app/acme/team?week=2026-10-05", ada);
		expect(text).toMatch(/linus linus@example\.com .*?2:00 logged 15:00 expected · 22:30 leave/);
		expect(text).toMatch(/ada ada@example\.com .*?5:00 logged 37:30 expected/);
	});
});

describe("Saved and shared reports (TS-080)", () => {
	/** Saves the report at `query` of `view` as `who`, and returns its id. */
	async function save(who: Person, path: string, name: string): Promise<string> {
		const response = await submit(path, { intent: "save-report", name }, who);
		expect(response.status).toBeLessThan(400);
		const found = await env.DB.prepare(
			"select id from saved_reports where organisation_id = ? and name = ?",
		)
			.bind(acme.id, name)
			.first<{ id: string }>();
		if (!found) throw new Error("not saved");
		return found.id;
	}

	it("keeps the question, so Last week moves with the clock", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
		const id = await save(ada, `${BASE}?range=last-week`, "Last week");
		const opened = `${BASE}?range=last-week&saved=${id}`;
		const first = await read(opened, ada);
		expect(headline(first, "Total")).toBe("8:00");

		// A week later, the same saved report asks for the week after: nothing tracked.
		vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
		const saved = await read(`${BASE}/saved`, ada);
		expect(saved).toContain("Last week");
		const later = await read(opened, ada);
		expect(headline(later, "Total")).toBe("0:00");
	});

	it("shows a member opening an admin's shared report only their own hours", async () => {
		const id = await save(grace, `${BASE}?${WEEK}`, "Everyone's week");
		const shared = await submit(
			`${BASE}/saved`,
			{ intent: "share", reportId: id, userId: linus.user.id, access: "view" },
			grace,
		);
		expect(shared.status).toBeLessThan(400);
		expect(await read(`${BASE}/saved`, linus)).toContain("Everyone's week");
		// Grace sees everyone's 8 hours; Linus, opening the same report, his own 2.
		expect(headline(await read(`${BASE}?${WEEK}&saved=${id}`, grace), "Total")).toBe("8:00");
		expect(headline(await read(`${BASE}?${WEEK}&saved=${id}`, linus), "Total")).toBe("2:00");
	});

	it("is not listed to a member it was not shared with", async () => {
		await save(grace, `${BASE}?${WEEK}`, "Private");
		expect(await read(`${BASE}/saved`, hedy)).not.toContain("Private");
	});
});

describe("Dashboards (TS-086): each panel equals its report", () => {
	it("is not offered to a member", async () => {
		await read(`${DASHBOARDS}?${WEEK}`, linus, 404);
	});

	it.each(["owner", "admin", "manager", "finance"] as const)("for the %s", async (role) => {
		const who = ROLES()[role];
		const board = await read(`${DASHBOARDS}?${WEEK}`, who);
		const time = await read(`${BASE}?${WEEK}`, who);
		const utilisation = await read(`${BASE}/utilisation?${WEEK}`, who);
		expect(headline(board, "Total")).toBe(headline(time, "Total"));
		expect(panel(board, "Utilisation")).toBe(headline(utilisation, "Utilisation"));
		const seesMoney = role === "owner" || role === "admin" || role === "finance";
		if (seesMoney) {
			const profit = await read(`${BASE}/profitability?${WEEK}`, who);
			expect(panel(board, "Profit")).toBe(headline(profit, "Profit"));
		} else {
			expect(board).not.toMatch(/\bProfit £/);
		}
	});
});
