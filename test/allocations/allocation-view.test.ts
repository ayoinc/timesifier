import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setShare } from "~/allocations/allocations.server";
import { type OrganisationScope, organisationScope } from "~/db";
import { assignToTeam } from "~/projects/teams.server";
import type { Day } from "~/time/calendar";

import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	seedMember,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "../pages/harness";
import { seedEntry, seedProject } from "../pages/periods-seed";

// Time shares on a project's Team tab and Team › Allocation (TS-116,
// docs/decisions.md entry 78). Owners, admins, the client's account managers
// and the project's delivery managers set them; the view shows owners and
// admins everyone, a line manager their teams, and a delivery manager or
// account manager the people on their projects, of other projects only what
// they plan in all. It pages at 50 and reads a fixed number of statements.

/** Wednesday 11 November 2026, 15:00 in London. */
const NOW = Date.parse("2026-11-11T15:00:00Z");
const VIEW = "/app/acme/team/allocation";

let mailbox: Mailbox;
let ada: Person;
let grace: Person;
let acme: { id: string };
let scope: OrganisationScope;
let globex: string;
let site: string;
let other: string;
let clock: { mockRestore(): void };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	grace = await person(mailbox, "grace@example.com");
	await seedMembership(acme.id, grace.user.id, "member");
	const [client] = await scope.clients.insert({ name: "Globex", nameKey: "globex" });
	if (!client) throw new Error("seed failed");
	globex = client.id;
	site = await seedProject(acme.id, "Site");
	await env.DB.prepare("update projects set client_id = ? where id = ?").bind(globex, site).run();
	other = await seedProject(acme.id, "Other");
	clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

type Who =
	| "owner"
	| "admin"
	| "finance"
	| "account manager"
	| "delivery manager"
	| "line manager"
	| "member"
	| "contractor"
	| "stranger";

/** Someone in each place the rules tell apart; the delivery manager leads Site from 1 November. */
async function as(who: Who): Promise<Person> {
	if (who === "owner") return ada;
	if (who === "member") return grace;
	// Signing in keeps the real clock.
	clock.mockRestore();
	const someone = await person(mailbox, `${who.replaceAll(" ", "-")}@example.com`);
	clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
	if (who === "stranger") {
		await createOrganisation(someone.cookie, "Initech");
		return someone;
	}
	await seedMembership(
		acme.id,
		someone.user.id,
		who === "admin" || who === "finance" ? who : "member",
	);
	if (who === "account manager") {
		await scope.clientManagers.insert({ clientId: globex, userId: someone.user.id });
	}
	if (who === "delivery manager") {
		await assignToTeam(
			scope,
			{ userId: ada.user.id },
			{
				projectId: site,
				userId: someone.user.id,
				role: "delivery_manager",
				startsOn: "2026-11-01",
				endsOn: null,
			},
		);
	}
	if (who === "line manager") {
		await seedTeam(acme.id, "Design", { members: [grace.user.id], managers: [someone.user.id] });
	}
	if (who === "contractor") {
		await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
			.bind(someone.user.id)
			.run();
	}
	return someone;
}

/** Gives `userId` a share, as an owner would. */
async function share(
	userId: string,
	projectId: string,
	amount: number,
	unit: "days" | "hours" | "percent",
	startsOn: Day = "2026-11-02",
) {
	const made = await setShare(
		scope,
		{ userId: ada.user.id },
		{ projectId, workPackageId: null, userId, startsOn, endsOn: null, amount, unit },
	);
	if (!made?.ok) throw new Error(`no share: ${JSON.stringify(made)}`);
	return made.id;
}

async function viewText(who: Person, query = "") {
	const response = await open(`${VIEW}${query}`, who);
	return {
		status: response.status,
		text: response.status === 200 ? textOf(await pageBody(response)) : "",
	};
}

describe("setting a time share on the project's Team tab", () => {
	const tab = () => `/app/acme/projects/${site}?tab=team`;
	const setting = () => ({
		intent: "share-set",
		userId: grace.user.id,
		workPackageId: "",
		amount: "2.5",
		unit: "days",
		startsOn: "2026-11-16",
		endsOn: "",
	});

	it.each<[Who, number]>([
		["owner", 200],
		["admin", 200],
		["account manager", 200],
		["delivery manager", 200],
		["finance", 403],
		["line manager", 403],
		["member", 403],
		["contractor", 403],
		["stranger", 404],
	])("as %s answers %i", async (who, status) => {
		const response = await submit(tab(), setting(), await as(who), { byScript: true });
		expect(response.status).toBe(status);
		const made = await value("select count(*) from allocations where organisation_id = ?", acme.id);
		expect(made).toBe(status === 200 ? 1 : 0);
		if (status === 200) {
			expect(await response.text()).toContain("2.5 days a week from");
			expect(
				await value(
					"select count(*) from activity_records where action = 'project.share_set' and subject_id = ?",
					site,
				),
			).toBe(1);
		}
	});

	it("refuses an amount out of range and a share that overlaps another of the same line", async () => {
		const refused = await submit(tab(), { ...setting(), amount: "8" }, ada, { byScript: true });
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain("up to 7 days a week");
		expect((await submit(tab(), setting(), ada, { byScript: true })).status).toBe(200);
		const again = await submit(tab(), { ...setting(), startsOn: "2026-12-01" }, ada, {
			byScript: true,
		});
		expect(again.status).toBe(400);
		expect(await again.text()).toContain("already have a time share");
	});

	it("changes a share from a later day, keeping the weeks before, and ends and removes it", async () => {
		const id = await share(grace.user.id, site, 200, "days");
		const changed = await submit(
			tab(),
			{ intent: "share-change", shareId: id, amount: "50", unit: "percent", from: "2026-11-16" },
			ada,
			{ byScript: true },
		);
		expect(changed.status).toBe(200);
		const { results } = await env.DB.prepare(
			"select starts_on, ends_on, amount, unit from allocations where user_id = ? order by starts_on",
		)
			.bind(grace.user.id)
			.all();
		expect(results).toEqual([
			{ starts_on: "2026-11-02", ends_on: "2026-11-15", amount: 200, unit: "days" },
			{ starts_on: "2026-11-16", ends_on: null, amount: 5000, unit: "percent" },
		]);
		const [newer] = (
			await env.DB.prepare("select id from allocations where starts_on = '2026-11-16'").all<{
				id: string;
			}>()
		).results;
		const ended = await submit(
			tab(),
			{ intent: "share-end", shareId: newer?.id ?? "", endsOn: "2026-12-31" },
			ada,
			{ byScript: true },
		);
		expect(ended.status).toBe(200);
		const removed = await submit(tab(), { intent: "share-remove", shareId: id }, ada, {
			byScript: true,
		});
		expect(removed.status).toBe(200);
		expect(await value("select count(*) from allocations")).toBe(1);
	});

	it("lists every share to those who see the team, and a member their own", async () => {
		await share(grace.user.id, site, 250, "days");
		const owner = textOf(await pageBody(await open(tab(), ada)));
		expect(owner).toContain("2.5 days a week");
		// The week of 9 November on 5 days of 7:30: 2.5 days are 18:45.
		expect(owner).toContain("This week 18:45 planned");
		const member = textOf(await pageBody(await open(tab(), grace)));
		expect(member).toContain("2.5 days a week");
		const someone = await as("finance");
		const finance = textOf(await pageBody(await open(tab(), someone)));
		// Finance sees the whole team (decision 75) but no one's time share (decision 78).
		expect(finance).not.toContain("2.5 days a week");
	});
});

describe("Team › Allocation", () => {
	it.each<[Who, number]>([
		["owner", 200],
		["admin", 200],
		["account manager", 200],
		["delivery manager", 200],
		["line manager", 200],
		["finance", 404],
		["member", 404],
		["contractor", 404],
		["stranger", 404],
	])("as %s answers %i", async (who, status) => {
		expect((await viewText(await as(who))).status).toBe(status);
	});

	it("shows each week's schedule, plan and time, and flags over- and under-allocation in words", async () => {
		await share(grace.user.id, site, 300, "days");
		await share(grace.user.id, other, 300, "days");
		// Two hours on Site on Tuesday 10 November.
		await seedEntry(acme.id, grace.user.id, site, "2026-11-10T09:00:00Z", "2026-11-10T11:00:00Z");
		const { text } = await viewText(ada);
		expect(text).toContain("9–15 November 2026");
		expect(text).toContain("Schedule 37:30");
		// Six days a week of five: 45:00 planned of 37:30.
		expect(text).toContain("Over-allocated by 7:30");
		expect(text).toContain("Planned 45:00 · Tracked 2:00");
		expect(text).toContain("Site: 22:30 planned, 2:00 tracked");
		expect(text).toContain("Other: 22:30 planned, 0:00 tracked");
		// Ada has no share: under-allocated, said in words.
		expect(text).toContain("Under-allocated: nothing planned");
	});

	it("shows a line manager their team, and a delivery manager their project's people", async () => {
		const outsider = await seedMember(acme.id, "member", "outsider@example.com");
		await share(grace.user.id, other, 100, "days");
		await share(outsider.userId, site, 200, "days");

		const manager = await viewText(await as("line manager"));
		expect(manager.text).toContain("grace@example.com");
		expect(manager.text).not.toContain("outsider@example.com");
		expect(manager.text).toContain("Other: 7:30 planned");

		const lead = await viewText(await as("delivery manager"));
		expect(lead.text).toContain("outsider@example.com");
		expect(lead.text).toContain("Site: 15:00 planned");
		expect(lead.text).not.toContain("grace@example.com");

		// Grace joins Site's team: the lead sees her, and of Other only that it plans so much.
		await assignToTeam(
			scope,
			{ userId: ada.user.id },
			{
				projectId: site,
				userId: grace.user.id,
				role: "member",
				startsOn: "2026-11-01",
				endsOn: null,
			},
		);
		const later = await viewText(await as("account manager"));
		expect(later.text).toContain("grace@example.com");
		expect(later.text).toContain("Other projects: 7:30 planned");
		expect(later.text).not.toContain("Other: 7:30 planned");
	});

	it("filters by team, client and project", async () => {
		const outsider = await seedMember(acme.id, "member", "outsider@example.com");
		await share(outsider.userId, other, 100, "days");
		const team = await seedTeam(acme.id, "Design", { members: [grace.user.id] });
		const byTeam = await viewText(ada, `?team=${team}`);
		expect(byTeam.text).toContain("grace@example.com");
		expect(byTeam.text).not.toContain("outsider@example.com");
		const byProject = await viewText(ada, `?project=${other}`);
		expect(byProject.text).toContain("outsider@example.com");
		expect(byProject.text).not.toContain("grace@example.com");
		const byClient = await viewText(ada, `?client=${globex}`);
		expect(byClient.text).toContain("Nobody matches these filters.");
	});

	it("lists 50 people a page", async () => {
		for (let n = 0; n < 55; n++) {
			await seedMember(acme.id, "member", `person-${String(n).padStart(2, "0")}@example.com`);
		}
		const first = await viewText(ada);
		expect(first.text).toContain("1–50 of 57");
		expect(first.text).toContain("Next 7");
		const second = await viewText(ada, "?page=2");
		expect(second.text).toContain("51–57 of 57");
		expect(second.text).toContain("Previous 50");
	});
});

describe("what the view reads", () => {
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

	const reads = (sql: string[], table: string) =>
		sql.filter((s) => new RegExp(`(from|join) "${table}"`).test(s)).length;

	async function statementsOfView() {
		const sql = await statementsWhile(async () => {
			const response = await open(VIEW, ada);
			expect(response.status).toBe(200);
			await response.text();
		});
		return {
			total: sql.length,
			allocations: reads(sql, "allocations"),
			sums: sql.filter((s) => /from "time_entries"/.test(s) && /sum\(/.test(s)).length,
			entries: reads(sql, "time_entries"),
		};
	}

	it("sums the time and reads the shares once, however many people there are", async () => {
		await share(grace.user.id, site, 200, "days");
		await seedEntry(acme.id, grace.user.id, site, "2026-11-10T09:00:00Z", "2026-11-10T11:00:00Z");
		const few = await statementsOfView();
		for (let n = 0; n < 30; n++) {
			const { userId } = await seedMember(acme.id, "member", `crowd-${n}@example.com`);
			await share(userId, other, 100, "days");
			await seedEntry(acme.id, userId, other, "2026-11-10T09:00:00Z", "2026-11-10T10:00:00Z");
		}
		const many = await statementsOfView();
		expect(few.allocations).toBe(1);
		expect(few.sums).toBe(1);
		expect(many).toEqual(few);
	});
});
