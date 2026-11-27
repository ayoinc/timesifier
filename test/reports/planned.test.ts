import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "~/db";
import type { Membership } from "~/organisations/membership.server";
import { planDifference } from "~/reports/planned.server";
import { loader } from "~/routes/app/reports.planned";

import { freshDatabase } from "../db/database";
import { type Role, seedMember, seedOrganisation, seedTeam } from "../organisations/harness";
import { seedEntry, seedProject } from "../pages/periods-seed";
import { seedDefaultWeek } from "../pages/schedule-seed";
import { loaded } from "./company";

// The Planned view of Reports (TS-116, decision 78): each person's time
// shares against what they tracked over the range, by person and by project,
// with totals that are the sums of their lines. Everyone works eight hours a
// day, Monday to Friday, so a week has 40 hours to share. The week of 5
// October 2026 holds no public holiday, and the report is read a fortnight
// later, so no entry is running.

const NOW = Date.parse("2026-10-20T12:00:00Z");
const WEEK = "range=week&from=2026-10-05";
const EIGHT_HOURS = [480, 480, 480, 480, 480, 0, 0];

interface Organisation {
	id: string;
	slug: string;
}

function membership(
	organisation: Organisation,
	userId: string,
	role: Role,
	managesTeams = false,
): Membership {
	return {
		organisation: {
			id: organisation.id,
			name: organisation.slug,
			slug: organisation.slug,
			timeZone: "UTC",
			weekStartsOn: 1,
			workModel: "client_projects",
			internalTerm: "Work codes",
			keepsBilling: true,
			logoVersion: null,
			signIn: { kind: "any" },
		},
		role,
		managesTeams,
		user: { id: userId, name: "", email: `${userId}@example.com` },
	} as Membership;
}

async function seedPerson(organisationId: string, role: Role, name: string): Promise<string> {
	const { userId } = await seedMember(
		organisationId,
		role,
		`${name.toLowerCase()}-${uuidv7().slice(-6)}@example.com`,
	);
	await env.DB.prepare("update users set name = ? where id = ?").bind(name, userId).run();
	return userId;
}

async function seedPackage(organisationId: string, projectId: string, code: string, name: string) {
	const id = uuidv7();
	const now = Date.now();
	await env.DB.prepare(
		"insert into work_packages (id, organisation_id, project_id, code, code_key, name, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(id, organisationId, projectId, code, code.toLowerCase(), name, now, now)
		.run();
	return id;
}

/** A time share of `amount` hundredths of `unit` a week, from 1 October 2026 with no end. */
async function seedShare(
	organisationId: string,
	userId: string,
	projectId: string,
	amount: number,
	unit: "days" | "hours" | "percent",
	workPackageId: string | null = null,
) {
	const now = Date.now();
	await env.DB.prepare(
		"insert into allocations (id, organisation_id, user_id, project_id, work_package_id, starts_on, ends_on, amount, unit, created_at, updated_at) values (?, ?, ?, ?, ?, '2026-10-01', null, ?, ?, ?, ?)",
	)
		.bind(uuidv7(), organisationId, userId, projectId, workPackageId, amount, unit, now, now)
		.run();
}

/** An entry of `minutes` from 09:00 on `day`, on `workPackageId` when given. */
async function seedTime(
	organisationId: string,
	userId: string,
	projectId: string,
	day: string,
	minutes: number,
	workPackageId: string | null = null,
) {
	const from = Date.parse(`${day}T09:00:00Z`);
	const id = await seedEntry(organisationId, userId, projectId, from, from + minutes * 60_000);
	if (workPackageId) {
		await env.DB.prepare("update time_entries set work_package_id = ? where id = ?")
			.bind(workPackageId, id)
			.run();
	}
}

/** A line of the page, as the loader hands it to the page. */
interface Line {
	planned: string;
	tracked: string;
	difference: string;
}

interface View {
	people: (Line & { name: string })[];
	work: (Line & { label: string; shared: boolean })[];
	total: Line;
}

function planned(who: Membership, query = WEEK) {
	return loaded(loader, who, `/app/${who.organisation.slug}/reports/planned?${query}`);
}

async function viewOf(who: Membership, query = WEEK): Promise<View> {
	const { view } = await planned(who, query);
	if (!view) throw new Error("The report made no view.");
	return view;
}

/** Minutes from "h:mm". */
function minutes(text: string): number {
	const [hours, rest] = text.split(":");
	return Number(hours) * 60 + Number(rest);
}

/** The person lines as name → [planned, tracked, difference]. */
function byPerson(view: View) {
	return Object.fromEntries(view.people.map((p) => [p.name, [p.planned, p.tracked, p.difference]]));
}

function byWork(view: View) {
	return Object.fromEntries(view.work.map((w) => [w.label, [w.planned, w.tracked, w.difference]]));
}

/** Each grouping's lines add up to the total, planned and tracked alike. */
function expectTotalsAreSums(view: View) {
	for (const lines of [view.people, view.work]) {
		expect(lines.reduce((sum, line) => sum + minutes(line.planned), 0)).toBe(
			minutes(view.total.planned),
		);
		expect(lines.reduce((sum, line) => sum + minutes(line.tracked), 0)).toBe(
			minutes(view.total.tracked),
		);
	}
}

beforeAll(async () => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	await freshDatabase();
}, 60_000);

afterAll(() => {
	vi.restoreAllMocks();
});

describe("planned against tracked", () => {
	let acme: Organisation;
	let owner: string;
	let ann: string;
	let ben: string;
	let max: string;
	let zed: string;

	beforeAll(async () => {
		acme = await seedOrganisation("Acme", "acme");
		await seedDefaultWeek(acme.id, EIGHT_HOURS);
		owner = await seedPerson(acme.id, "owner", "Ola");
		ann = await seedPerson(acme.id, "member", "Ann");
		ben = await seedPerson(acme.id, "member", "Ben");
		max = await seedPerson(acme.id, "member", "Max");
		zed = await seedPerson(acme.id, "member", "Zed");
		// Max line-manages Ben; nobody line-manages Ann or Zed.
		await seedTeam(acme.id, "Delivery", { members: [ben], managers: [max] });

		const site = await seedProject(acme.id, "Site");
		const build = await seedProject(acme.id, "Build");
		const wp2 = await seedPackage(acme.id, build, "WP2", "Build");

		// Ann: 2.5 days a week on Site (20:00) and 7.5 hours a week on Build's WP2 (7:30).
		await seedShare(acme.id, ann, site, 250, "days");
		await seedShare(acme.id, ann, build, 750, "hours", wp2);
		// Ben: half his schedule on Site (20:00). Max: a day a week on Build (8:00). Zed: a day on Site.
		await seedShare(acme.id, ben, site, 5000, "percent");
		await seedShare(acme.id, max, build, 100, "days");
		await seedShare(acme.id, zed, site, 100, "days");

		// Ann tracks 7:00 on Site, 2:00 on WP2 and 0:30 on Build outside WP2.
		await seedTime(acme.id, ann, site, "2026-10-05", 240);
		await seedTime(acme.id, ann, site, "2026-10-06", 180);
		await seedTime(acme.id, ann, build, "2026-10-07", 120, wp2);
		await seedTime(acme.id, ann, build, "2026-10-08", 30);
		await seedTime(acme.id, ben, site, "2026-10-05", 480);
		await seedTime(acme.id, max, build, "2026-10-06", 180);
		// Ola has no share and tracks an hour; Zed tracks two.
		await seedTime(acme.id, owner, site, "2026-10-09", 60);
		await seedTime(acme.id, zed, site, "2026-10-09", 120);
		// Outside the week, so not counted.
		await seedTime(acme.id, ann, site, "2026-10-12", 300);
	}, 60_000);

	it("shows an owner every person and every project, the totals the sums of the lines", async () => {
		const view = await viewOf(membership(acme, owner, "owner"));
		expect(byPerson(view)).toEqual({
			Ann: ["27:30", "9:30", "18:00 under plan"],
			Ben: ["20:00", "8:00", "12:00 under plan"],
			Max: ["8:00", "3:00", "5:00 under plan"],
			Ola: ["0:00", "1:00", "1:00 over plan"],
			Zed: ["8:00", "2:00", "6:00 under plan"],
		});
		expect(byWork(view)).toEqual({
			Build: ["8:00", "3:30", "4:30 under plan"],
			"Build › WP2 Build": ["7:30", "2:00", "5:30 under plan"],
			Site: ["48:00", "18:00", "30:00 under plan"],
		});
		expect(view.total).toEqual({
			planned: "63:30",
			tracked: "23:30",
			difference: "40:00 under plan",
		});
		expect(view.work.find((w) => w.label === "Build")?.shared).toBe(true);
		expectTotalsAreSums(view);
	});

	it("shows a line manager themselves and the people they manage, and nobody else's time", async () => {
		const view = await viewOf(membership(acme, max, "member", true));
		expect(byPerson(view)).toEqual({
			Ben: ["20:00", "8:00", "12:00 under plan"],
			Max: ["8:00", "3:00", "5:00 under plan"],
		});
		expect(byWork(view)).toEqual({
			Build: ["8:00", "3:00", "5:00 under plan"],
			Site: ["20:00", "8:00", "12:00 under plan"],
		});
		expect(view.total).toEqual({
			planned: "28:00",
			tracked: "11:00",
			difference: "17:00 under plan",
		});
		expectTotalsAreSums(view);
	});

	it("shows a member their own shares and time alone", async () => {
		const view = await viewOf(membership(acme, ann, "member"));
		expect(byPerson(view)).toEqual({ Ann: ["27:30", "9:30", "18:00 under plan"] });
		expect(byWork(view)).toEqual({
			Build: ["0:00", "0:30", "0:30 over plan"],
			"Build › WP2 Build": ["7:30", "2:00", "5:30 under plan"],
			Site: ["20:00", "7:00", "13:00 under plan"],
		});
		// Build is a line of her time alone: she has no share of the whole of it.
		expect(view.work.find((w) => w.label === "Build")?.shared).toBe(false);
		expectTotalsAreSums(view);
	});

	it("narrows to a person and a day, and says a line that meets its plan is on plan", async () => {
		const owns = membership(acme, owner, "owner");
		// Ben on the Monday: half of eight hours planned, eight tracked.
		const monday = await viewOf(owns, `range=custom&from=2026-10-05&to=2026-10-05&person=${ben}`);
		expect(byPerson(monday)).toEqual({ Ben: ["4:00", "8:00", "4:00 over plan"] });
		// Max on the Tuesday: a fifth of eight hours planned, three tracked.
		const tuesday = await viewOf(owns, `range=custom&from=2026-10-06&to=2026-10-06&person=${max}`);
		expect(byPerson(tuesday)).toEqual({ Max: ["1:36", "3:00", "1:24 over plan"] });
		expect(planDifference({ plannedMinutes: 96, trackedMinutes: 96 })).toBe("On plan");
		expect(planDifference({ plannedMinutes: 0, trackedMinutes: 0 })).toBe("On plan");
		expect(planDifference({ plannedMinutes: 330, trackedMinutes: 180 })).toBe("2:30 under plan");
	});
});

describe("statements", () => {
	/** An organisation of `count` people, each with a share of Site and an hour on it. */
	async function crowd(slug: string, count: number): Promise<Membership> {
		const organisation = await seedOrganisation(slug, slug);
		await seedDefaultWeek(organisation.id, EIGHT_HOURS);
		const site = await seedProject(organisation.id, "Site");
		const build = await seedProject(organisation.id, "Build");
		const wp = await seedPackage(organisation.id, build, "WP1", "Plan");
		let owner = "";
		for (let n = 0; n < count; n++) {
			const userId = await seedPerson(organisation.id, n === 0 ? "owner" : "member", `P${n}`);
			if (n === 0) owner = userId;
			await seedShare(organisation.id, userId, site, 100, "days");
			await seedShare(organisation.id, userId, build, 1000, "percent", wp);
			await seedTime(organisation.id, userId, site, "2026-10-05", 60);
			await seedTime(organisation.id, userId, build, "2026-10-06", 30, wp);
		}
		return membership(organisation, owner, "owner");
	}

	/** The statements D1 is asked to prepare while `run` runs. */
	async function statementsWhile(run: () => Promise<unknown>): Promise<string[]> {
		const prepare = vi.spyOn(env.DB, "prepare");
		try {
			await run();
			return prepare.mock.calls.map(([sql]) => String(sql));
		} finally {
			prepare.mockRestore();
		}
	}

	function reads(sql: string[], table: string): string[] {
		return sql.filter((s) => new RegExp(`(from|join) "${table}"`).test(s));
	}

	it("reads the same number of statements for 3 people as for 30, summing time in SQL", async () => {
		const few = await crowd("few", 3);
		const many = await crowd("many", 30);
		const fewSql = await statementsWhile(() => planned(few));
		const manySql = await statementsWhile(() => planned(many));

		for (const sql of [fewSql, manySql]) {
			expect(reads(sql, "allocations")).toHaveLength(1);
			const timeReads = reads(sql, "time_entries");
			expect(timeReads.length).toBeGreaterThan(0);
			// Tracked time is read as sums alone, never entry by entry.
			for (const statement of timeReads) expect(statement).toMatch(/sum\(/i);
		}
		expect(reads(manySql, "time_entries")).toHaveLength(reads(fewSql, "time_entries").length);
		expect(manySql).toHaveLength(fewSql.length);

		// And the totals are the sums of the lines: 30 people, an hour and a half each.
		const view = await viewOf(many);
		expect(view.people).toHaveLength(30);
		expect(view.total.tracked).toBe("45:00");
		// A day a week (8:00) and a tenth of 40 hours (4:00) each.
		expect(view.total.planned).toBe("360:00");
		expectTotalsAreSums(view);
	});
});
