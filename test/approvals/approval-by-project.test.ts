import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approveAll } from "~/approvals/approvals.server";
import { weekStatusOf } from "~/approvals/parts";
import { planParts, projectPartsOf, weekKey } from "~/approvals/parts.server";
import { type OrganisationScope, organisationScope, waitingFor } from "~/db";
import { submitUnsubmitted } from "~/locks/locks.server";
import { mayDecidePartOf } from "~/organisations/access";
import { lockedDays } from "~/periods/locks.server";
import { canSee } from "~/shell/destinations";
import { peopleOf } from "~/teams/people.server";
import type { Day } from "~/time/calendar";
import { setCellHours } from "~/time/manual.server";

import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, row, seedMembership, seedTeam, value } from "../organisations/harness";
import { open, type Person, person, submit, textOf } from "../pages/harness";
import { seedLeave } from "../pages/leave-seed";
import { seedEntry, seedProject } from "../pages/periods-seed";

// Approval by project (TS-117, docs/decisions.md entry 79). A week with time
// on a client project that has a delivery manager is held in parts: a part
// for each such project, decided by its delivery managers, and the line part,
// the rest, decided by the person's line manager. The week is approved when
// every part is; a part is returned alone, corrected and submitted again; an
// approved part is locked. Nobody approves their own time (D5), a manager on
// leave is skipped (D6), and an organisation without delivery managers
// approves whole weeks exactly as before.

const TIMESHEET = "/app/acme?index";
const APPROVALS = "/app/acme/approvals";
/** Wednesday 18 November 2026, 15:00 in London: the server's clock. */
const NOW = Date.parse("2026-11-18T15:00:00Z");
/** The week before: Monday 9 to Sunday 15 November 2026. */
const MONDAY = "2026-11-09";
const NOT_ALLOWED = 403;

let mailbox: Mailbox;
let acme: { id: string; slug: string };
let scope: OrganisationScope;
/** Every role of the card: owner, admin, Finance, account manager, delivery managers, line manager, member, contractor, stranger. */
let ada: Person;
let grace: Person;
let katherine: Person;
let kim: Person;
let dora: Person;
let dan: Person;
let mona: Person;
let linus: Person;
let carl: Person;
let mallory: Person;
let site: string;
let brand: string;
let ops: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	const member = async (email: string, role: "admin" | "finance" | "member" = "member") => {
		const who = await person(mailbox, email);
		await seedMembership(acme.id, who.user.id, role);
		return who;
	};
	grace = await member("grace@example.com", "admin");
	katherine = await member("katherine@example.com", "finance");
	kim = await member("kim@example.com");
	dora = await member("dora@example.com");
	dan = await member("dan@example.com");
	mona = await member("mona@example.com");
	linus = await member("linus@example.com");
	carl = await member("carl@example.com");
	await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
		.bind(carl.user.id)
		.run();
	for (const [who, name] of [
		[ada, "Ada"],
		[grace, "Grace"],
		[katherine, "Katherine"],
		[kim, "Kim"],
		[dora, "Dora"],
		[dan, "Dan"],
		[mona, "Mona"],
		[linus, "Linus"],
		[carl, "Carl"],
	] as const) {
		await env.DB.prepare("update users set name = ? where id = ?").bind(name, who.user.id).run();
	}
	mallory = await person(mailbox, "mallory@example.com");
	await createOrganisation(mallory.cookie, "Initech");
	// Mona manages Design: Linus, Carl, Dora and Dan are in it.
	await seedTeam(acme.id, "Design", {
		members: [linus.user.id, carl.user.id, dora.user.id, dan.user.id],
		managers: [mona.user.id],
	});
	const [globex] = await scope.clients.insert({ name: "Globex", nameKey: "globex" });
	if (!globex) throw new Error("seed failed");
	// Kim is Globex's account manager (decision 42), who decides nothing here.
	await scope.clientManagers.insert({ clientId: globex.id, userId: kim.user.id });
	site = await seedProject(acme.id, "Site");
	brand = await seedProject(acme.id, "Brand");
	ops = await seedProject(acme.id, "Ops");
	await env.DB.prepare("update projects set client_id = ? where id in (?, ?)")
		.bind(globex.id, site, brand)
		.run();
	// Signing in reads the real clock; the weeks from here read this one.
	vi.spyOn(Date, "now").mockReturnValue(NOW);
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** Makes `who` a delivery manager of `projectId` from 1 November. */
async function lead(who: Person, projectId: string, endsOn: string | null = null) {
	await scope.projectMembers.insert({
		projectId,
		userId: who.user.id,
		role: "delivery_manager",
		startsOn: "2026-11-01",
		endsOn,
	});
}

/** Three hours each on Site on Monday, Ops on Tuesday and Brand on Wednesday of the week. */
async function logWeek(who: Person) {
	await seedEntry(acme.id, who.user.id, site, "2026-11-09T09:00:00Z", "2026-11-09T12:00:00Z");
	await seedEntry(acme.id, who.user.id, ops, "2026-11-10T09:00:00Z", "2026-11-10T12:00:00Z");
	await seedEntry(acme.id, who.user.id, brand, "2026-11-11T09:00:00Z", "2026-11-11T11:00:00Z");
}

async function post(path: string, fields: Record<string, string>, who: Person) {
	return (await submit(path, fields, who, { byScript: true })).status;
}

async function submitWeek(who: Person) {
	return post(TIMESHEET, { intent: "submit", startsOn: MONDAY }, who);
}

async function periodOf(who: Person) {
	return (await row<{ id: string; status: string; comment: string | null }>(
		"select id, status, comment from periods where user_id = ?",
		who.user.id,
	)) as { id: string; status: string; comment: string | null };
}

/** The parts of `who`'s week, by project id ("line" for the line part), with their status. */
async function partsOf(who: Person): Promise<Record<string, string>> {
	const { results } = await env.DB.prepare(
		"select p.project_id, p.status from period_parts p join periods w on w.id = p.period_id where w.user_id = ?",
	)
		.bind(who.user.id)
		.all<{ project_id: string | null; status: string }>();
	return Object.fromEntries(results.map((r) => [r.project_id ?? "line", r.status]));
}

/** The titles of the notifications `who` has, oldest first. */
async function toldTo(who: Person): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"select title from notifications where user_id = ? order by created_at, id",
	)
		.bind(who.user.id)
		.all<{ title: string }>();
	return results.map((r) => r.title);
}

const approvePart = (who: Person, periodId: string, projectId: string) =>
	post(APPROVALS, { intent: "approve-part", periodId, projectId }, who);
const returnPart = (who: Person, periodId: string, projectId: string, comment = "Wrong day") =>
	post(APPROVALS, { intent: "return-part", periodId, projectId, comment }, who);
const approveRest = (who: Person, periodId: string) =>
	post(APPROVALS, { intent: "approve", periodId }, who);
const returnRest = (who: Person, periodId: string, comment = "Ops was Thursday") =>
	post(APPROVALS, { intent: "return", periodId, comment }, who);

describe("a week's parts", () => {
	it("holds the time on each client project with a delivery manager apart, and the rest as the line part", async () => {
		await lead(dora, site);
		await logWeek(linus);
		expect(await submitWeek(linus)).toBe(200);
		// Site has a delivery manager; Brand, a client project without one, and Ops, a work code, are the line part's.
		expect(await partsOf(linus)).toEqual({ line: "submitted", [site]: "submitted" });
		expect((await periodOf(linus)).status).toBe("submitted");

		const found = await projectPartsOf(scope, [
			{ userId: linus.user.id, startsOn: MONDAY as Day, endsOn: "2026-11-15" as Day },
		]);
		expect(
			Object.fromEntries(
				found.get(
					weekKey({ userId: linus.user.id, startsOn: MONDAY as Day, endsOn: "2026-11-15" as Day }),
				) ?? [],
			),
		).toEqual({
			[site]: [dora.user.id],
		});
	});

	it("leaves out a delivery manager whose stretch ended before the week", async () => {
		await lead(dora, site, "2026-11-06");
		await logWeek(linus);
		expect(await submitWeek(linus)).toBe(200);
		expect(await partsOf(linus)).toEqual({});
	});

	it("is approved when every part is, returned while any is, submitted otherwise", () => {
		expect(weekStatusOf([{ status: "approved" }, { status: "approved" }])).toBe("approved");
		expect(weekStatusOf([{ status: "approved" }, { status: "submitted" }])).toBe("submitted");
		expect(weekStatusOf([{ status: "returned" }, { status: "submitted" }])).toBe("returned");
		expect(weekStatusOf([{ status: "approved" }, { status: "returned" }])).toBe("returned");
	});
});

describe("an organisation with no delivery managers", () => {
	it("approves and returns whole weeks exactly as before, with no tabs on Approvals", async () => {
		await logWeek(linus);
		expect(await submitWeek(linus)).toBe(200);
		expect(await partsOf(linus)).toEqual({});
		const { id } = await periodOf(linus);
		expect(await toldTo(mona)).toEqual(["Linus submitted their timesheet for 9–15 November 2026."]);
		expect(await waitingFor(env.DB, acme.id, mona.user.id, false)).toBe(1);

		for (const who of [ada, mona]) {
			const page = await open(`${APPROVALS}?week=${MONDAY}`, who);
			expect(page.status).toBe(200);
			const html = await page.text();
			expect(html).not.toContain('aria-label="Approve by"');
			expect(textOf(html)).not.toContain("Time on Site");
		}
		expect((await open(`${APPROVALS}?view=projects`, mona)).status).toBe(200);

		expect(await returnRest(mona, id)).toBe(200);
		expect(await periodOf(linus)).toMatchObject({
			status: "returned",
			comment: "Ops was Thursday",
		});
		expect(await submitWeek(linus)).toBe(200);
		expect(await approveRest(mona, id)).toBe(200);
		expect((await periodOf(linus)).status).toBe("approved");
		expect(await value("select count(*) from period_parts")).toBe(0);
		expect(await toldTo(linus)).toEqual([
			"Your timesheet for 9–15 November 2026 was returned to you.",
			"Your timesheet for 9–15 November 2026 was approved.",
		]);
	});
});

describe("who decides each part", () => {
	beforeEach(async () => {
		await lead(dora, site);
		await lead(dan, site);
		await logWeek(linus);
		await logWeek(carl);
		expect(await submitWeek(linus)).toBe(200);
		expect(await submitWeek(carl)).toBe(200);
	});

	it("a project part: its delivery managers, owners and admins; nobody else, whatever their role", async () => {
		const { id } = await periodOf(linus);
		// A line manager may open Approvals and is refused; the rest are not shown it at all.
		expect(await approvePart(mona, id, site)).toBe(NOT_ALLOWED);
		for (const who of [kim, katherine, linus, carl, mallory]) {
			expect(await approvePart(who, id, site)).toBe(404);
		}
		expect(await partsOf(linus)).toMatchObject({ [site]: "submitted" });
		expect(await approvePart(dora, id, site)).toBe(200);
		expect(await partsOf(linus)).toMatchObject({ [site]: "approved", line: "submitted" });

		const contractor = (await periodOf(carl)).id;
		expect(await approvePart(grace, contractor, site)).toBe(200);
		expect(await partsOf(carl)).toMatchObject({ [site]: "approved" });
	});

	it("the line part: the line manager, owners and admins, never a delivery manager as such", async () => {
		const { id } = await periodOf(linus);
		expect(await approveRest(dora, id)).toBe(NOT_ALLOWED);
		for (const who of [kim, katherine, carl, linus, mallory]) {
			expect(await approveRest(who, id)).toBe(404);
		}
		expect(await approveRest(mona, id)).toBe(200);
		expect(await partsOf(linus)).toEqual({ line: "approved", [site]: "submitted" });
		expect((await periodOf(linus)).status).toBe("submitted");
		expect(await approveRest(ada, (await periodOf(carl)).id)).toBe(200);
	});

	it("follows mayDecidePartOf for every role", () => {
		const access = (
			userId: string,
			role: "owner" | "admin" | "finance" | "member",
			managed: string[] = [],
		) => ({
			userId,
			role,
			managed: new Set(managed),
		});
		const leads = new Set([site]);
		const none = new Set<string>();
		expect(mayDecidePartOf(access("o", "owner"), "p", site, none)).toBe(true);
		expect(mayDecidePartOf(access("a", "admin"), "p", site, none)).toBe(true);
		expect(mayDecidePartOf(access("f", "finance"), "p", site, none)).toBe(false);
		expect(mayDecidePartOf(access("d", "member"), "p", site, leads)).toBe(true);
		expect(mayDecidePartOf(access("d", "member"), "d", site, leads)).toBe(false);
		expect(mayDecidePartOf(access("o", "owner"), "o", site, none)).toBe(false);
		expect(mayDecidePartOf(access("m", "member", ["p"]), "p", site, none)).toBe(false);
		expect(mayDecidePartOf(access("m", "member", ["p"]), "p", null, none)).toBe(true);
		expect(mayDecidePartOf(access("d", "member"), "p", null, leads)).toBe(false);
	});
});

describe("nobody approves their own time (D5), and a manager on leave is skipped (D6)", () => {
	it("a delivery manager's own time on their project goes to another delivery manager of it", async () => {
		await lead(dora, site);
		await lead(dan, site);
		await logWeek(dora);
		expect(await submitWeek(dora)).toBe(200);
		const { id } = await periodOf(dora);
		expect(await toldTo(dan)).toEqual([
			"Dora submitted their time on Site for 9–15 November 2026.",
		]);
		expect(await toldTo(dora)).toEqual([]);
		expect(await approvePart(dora, id, site)).toBe(NOT_ALLOWED);
		expect(await waitingFor(env.DB, acme.id, dora.user.id, false)).toBe(0);
		expect(await waitingFor(env.DB, acme.id, dan.user.id, false)).toBe(1);
		expect(await approvePart(dan, id, site)).toBe(200);
	});

	it("with no other delivery manager, to the owners and admins", async () => {
		await lead(dora, site);
		await logWeek(dora);
		expect(await submitWeek(dora)).toBe(200);
		expect(await toldTo(ada)).toContain(
			"Dora submitted their time on Site for 9–15 November 2026.",
		);
		expect(await toldTo(grace)).toContain(
			"Dora submitted their time on Site for 9–15 November 2026.",
		);
		expect(await approvePart(grace, (await periodOf(dora)).id, site)).toBe(200);
	});

	it("skips a delivery manager on leave today, telling the owners and admins instead", async () => {
		await lead(dora, site);
		await seedLeave(acme.id, dora.user.id, "annual", "2026-11-18", "2026-11-18");
		await logWeek(linus);
		expect(await submitWeek(linus)).toBe(200);
		expect(await toldTo(dora)).toEqual([]);
		expect(await toldTo(ada)).toContain(
			"Linus submitted their time on Site for 9–15 November 2026.",
		);
		const page = textOf(
			await (await open(`${APPROVALS}?view=projects&week=${MONDAY}`, ada)).text(),
		);
		expect(page).toContain("Dora is on leave, so this waits for an owner or admin.");
	});

	it("approves alone, as it is submitted, a part nobody else may decide", async () => {
		// Ada, the only owner and admin here, leads Site alone and logs time on it.
		await env.DB.prepare("delete from memberships where user_id = ?").bind(grace.user.id).run();
		await lead(ada, site);
		await logWeek(ada);
		expect(await submitWeek(ada)).toBe(200);
		expect(await partsOf(ada)).toEqual({ line: "approved", [site]: "approved" });
		expect((await periodOf(ada)).status).toBe("approved");
	});
});

describe("returning one part and submitting it again", () => {
	it("sends back the returned part alone, keeps the approved, and approves the week once every part is", async () => {
		await lead(dora, site);
		await logWeek(linus);
		expect(await submitWeek(linus)).toBe(200);
		const { id } = await periodOf(linus);

		expect(await returnPart(dora, id, site, "Monday was Brand")).toBe(200);
		expect(await partsOf(linus)).toEqual({ line: "submitted", [site]: "returned" });
		expect(await periodOf(linus)).toMatchObject({
			status: "returned",
			comment: "Monday was Brand",
		});
		// The line manager decides the rest meanwhile.
		expect(await approveRest(mona, id)).toBe(200);
		expect(await partsOf(linus)).toEqual({ line: "approved", [site]: "returned" });
		expect((await periodOf(linus)).status).toBe("returned");

		// Only the returned part is open: Site changes, the approved rest does not.
		const zone = "Europe/London";
		expect(
			await setCellHours(scope, linus.user.id, {
				projectId: site,
				day: MONDAY as Day,
				minutes: 120,
				zone,
				now: NOW,
			}),
		).toMatchObject({ ok: true });
		expect(
			await setCellHours(scope, linus.user.id, {
				projectId: ops,
				day: "2026-11-10" as Day,
				minutes: 60,
				zone,
				now: NOW,
			}),
		).toMatchObject({ ok: false, reason: "locked" });

		const timesheet = textOf(
			await (await open(`/app/acme?view=week&start=${MONDAY}`, linus)).text(),
		);
		expect(timesheet).toContain("Time on Site: Returned, “Monday was Brand”");
		expect(timesheet).toContain("The rest of the week: Approved");

		expect(await submitWeek(linus)).toBe(200);
		expect(await partsOf(linus)).toEqual({ line: "approved", [site]: "submitted" });
		expect((await periodOf(linus)).status).toBe("submitted");
		expect(await approvePart(dora, id, site)).toBe(200);
		expect((await periodOf(linus)).status).toBe("approved");

		expect(await toldTo(linus)).toEqual([
			"Your time on Site for 9–15 November 2026 was returned to you.",
			"The rest of your timesheet for 9–15 November 2026 was approved.",
			"Your time on Site for 9–15 November 2026 was approved, so your timesheet is approved.",
		]);
		expect(await toldTo(dora)).toEqual([
			"Linus submitted their time on Site for 9–15 November 2026.",
			"Linus submitted their time on Site for 9–15 November 2026.",
		]);
		expect(await toldTo(mona)).toEqual(["Linus submitted their timesheet for 9–15 November 2026."]);
		const events = await env.DB.prepare(
			"select action, part, project_id from period_events where period_id = ? order by created_at, id",
		)
			.bind(id)
			.all<{ action: string; part: string; project_id: string | null }>();
		expect(events.results).toEqual([
			{ action: "submitted", part: "week", project_id: null },
			{ action: "returned", part: "project", project_id: site },
			{ action: "approved", part: "line", project_id: null },
			{ action: "submitted", part: "week", project_id: null },
			{ action: "approved", part: "project", project_id: site },
		]);
	});

	it("an owner or admin reopening an approved week returns every part of it", async () => {
		await lead(dora, site);
		await logWeek(linus);
		expect(await submitWeek(linus)).toBe(200);
		const { id } = await periodOf(linus);
		expect(await approvePart(dora, id, site)).toBe(200);
		expect(await approveRest(mona, id)).toBe(200);
		expect(await post(APPROVALS, { intent: "reopen", periodId: id, comment: "Audit" }, mona)).toBe(
			NOT_ALLOWED,
		);
		expect(await post(APPROVALS, { intent: "reopen", periodId: id, comment: "Audit" }, ada)).toBe(
			200,
		);
		expect(await partsOf(linus)).toEqual({ line: "returned", [site]: "returned" });
		expect((await periodOf(linus)).status).toBe("returned");
	});
});

describe("locks", () => {
	beforeEach(async () => {
		await lead(dora, site);
		await logWeek(linus);
		expect(await submitWeek(linus)).toBe(200);
	});

	it("an approved part is locked while the week is back with its person", async () => {
		const { id } = await periodOf(linus);
		expect(await approvePart(dora, id, site)).toBe(200);
		expect(await returnRest(mona, id)).toBe(200);
		expect(await lockedDays(scope, linus.user.id, [MONDAY as Day], [site])).toEqual(
			new Set([MONDAY]),
		);
		expect(await lockedDays(scope, linus.user.id, ["2026-11-10" as Day], [ops])).toEqual(new Set());
		// Moving Ops time onto Site touches both parts, so it is refused.
		expect(await lockedDays(scope, linus.user.id, ["2026-11-10" as Day], [ops, site])).toEqual(
			new Set(["2026-11-10"]),
		);
	});

	it("a week with a part approved is not withdrawn", async () => {
		const { id } = await periodOf(linus);
		expect(await approvePart(dora, id, site)).toBe(200);
		expect(await post(TIMESHEET, { intent: "withdraw", startsOn: MONDAY }, linus)).toBe(409);
		expect((await periodOf(linus)).status).toBe("submitted");
	});

	it("a week withdrawn before any part is decided loses its parts", async () => {
		expect(await post(TIMESHEET, { intent: "withdraw", startsOn: MONDAY }, linus)).toBe(200);
		expect(await partsOf(linus)).toEqual({});
	});

	it("a part on days the lock date has reached is not returned", async () => {
		await env.DB.prepare("update organisations set locked_through = '2026-11-15' where id = ?")
			.bind(acme.id)
			.run();
		const { id } = await periodOf(linus);
		expect(await returnPart(dora, id, site)).toBe(409);
		expect(await approvePart(dora, id, site)).toBe(200);
	});

	it("the system submits a week the lock date reaches in parts, telling each part's deciders", async () => {
		await logWeek(carl);
		const organisation = { id: acme.id, timeZone: "Europe/London", weekStartsOn: 1 };
		expect(await submitUnsubmitted(organisation, null, "2026-11-15" as Day, NOW)).toBe(1);
		expect(await partsOf(carl)).toEqual({ line: "submitted", [site]: "submitted" });
		expect(await toldTo(dora)).toContain(
			"Carl's time on Site for 9–15 November 2026 was submitted by the system and waits for your approval.",
		);
	});
});

describe("Approve all acts on parts", () => {
	it("on People approves line parts and whole weeks; on Projects, the project parts the viewer leads", async () => {
		await lead(dora, site);
		await logWeek(linus);
		await logWeek(carl);
		expect(await submitWeek(linus)).toBe(200);
		expect(await submitWeek(carl)).toBe(200);

		expect(await post(APPROVALS, { intent: "approve-all", startsOn: MONDAY }, mona)).toBe(200);
		expect(await partsOf(linus)).toEqual({ line: "approved", [site]: "submitted" });
		expect(await partsOf(carl)).toEqual({ line: "approved", [site]: "submitted" });

		expect(await post(APPROVALS, { intent: "approve-all-parts", startsOn: MONDAY }, mona)).toBe(
			200,
		);
		expect(await partsOf(linus)).toMatchObject({ [site]: "submitted" });
		expect(await post(APPROVALS, { intent: "approve-all-parts", startsOn: MONDAY }, dora)).toBe(
			200,
		);
		expect(await partsOf(linus)).toEqual({ line: "approved", [site]: "approved" });
		expect((await periodOf(carl)).status).toBe("approved");

		const people = await peopleOf(scope, { timeZone: "UTC" });
		expect(
			await approveAll(
				scope,
				{ userId: mona.user.id, role: "member", managed: new Set([linus.user.id]) },
				people,
				MONDAY as Day,
			),
		).toEqual({ approved: 0, over: 0, running: 0 });
	});
});

describe("Approvals' tabs and the number on its link", () => {
	beforeEach(async () => {
		await lead(dora, site);
		await logWeek(linus);
		expect(await submitWeek(linus)).toBe(200);
	});

	it("shows Projects to delivery managers, People to line managers, both to owners and admins, and nothing to anyone else", async () => {
		const projects = `${APPROVALS}?view=projects&week=${MONDAY}`;
		const dorasPage = await open(projects, dora);
		expect(dorasPage.status).toBe(200);
		const dorasHtml = await dorasPage.text();
		expect(dorasHtml).not.toContain('aria-label="Approve by"');
		const dorasText = textOf(dorasHtml);
		expect(dorasText).toContain("Site");
		expect(dorasText).toContain("Linus");
		expect(dorasText).toContain("Mon 9 3:00");
		// Brand and Ops are the line part's: not on Dora's page.
		expect(dorasText).not.toContain("Brand");

		const monasText = textOf(await (await open(`${APPROVALS}?week=${MONDAY}`, mona)).text());
		expect(monasText).toContain("Time on Site: waiting for its delivery manager");

		for (const who of [ada, grace]) {
			const html = await (await open(projects, who)).text();
			expect(html).toContain('aria-label="Approve by"');
		}
		for (const who of [kim, katherine, linus, carl, mallory]) {
			expect((await open(APPROVALS, who)).status).toBe(404);
		}
		expect(
			canSee(
				{
					role: "member",
					managesTeams: false,
					leadsProjects: true,
					clientsEnabled: true,
					keepsBilling: true,
				},
				"approvals",
			),
		).toBe(true);
	});

	it("counts each part waiting for its own decider", async () => {
		expect(await waitingFor(env.DB, acme.id, dora.user.id, false)).toBe(1);
		expect(await waitingFor(env.DB, acme.id, mona.user.id, false)).toBe(1);
		expect(await waitingFor(env.DB, acme.id, ada.user.id, true)).toBe(2);
		expect(await waitingFor(env.DB, acme.id, kim.user.id, false)).toBe(0);
		const { id } = await periodOf(linus);
		expect(await approvePart(dora, id, site)).toBe(200);
		expect(await waitingFor(env.DB, acme.id, dora.user.id, false)).toBe(0);
		expect(await waitingFor(env.DB, acme.id, mona.user.id, false)).toBe(1);
	});
});

describe("planning parts", () => {
	it("keeps an approved part, waits a returned one again, adds a new one and drops one whose time has gone", async () => {
		await lead(dora, site);
		await lead(dora, brand);
		await seedEntry(acme.id, linus.user.id, site, "2026-11-09T09:00:00Z", "2026-11-09T12:00:00Z");
		expect(await submitWeek(linus)).toBe(200);
		const { id } = await periodOf(linus);
		await env.DB.prepare(
			"update period_parts set status = 'approved' where period_id = ? and project_id is null",
		)
			.bind(id)
			.run();
		await env.DB.prepare("update period_parts set status = 'returned' where project_id = ?")
			.bind(site)
			.run();
		await env.DB.prepare("delete from time_entries where project_id = ?").bind(site).run();
		await seedEntry(acme.id, linus.user.id, brand, "2026-11-10T09:00:00Z", "2026-11-10T12:00:00Z");
		const plan = await planParts(scope, {
			periodId: id,
			known: true,
			week: { userId: linus.user.id, startsOn: MONDAY as Day, endsOn: "2026-11-15" as Day },
			lineAlone: false,
			at: new Date(NOW),
		});
		expect(plan.held).toBe(true);
		expect(plan.parts).toEqual([
			{ projectId: null, status: "approved" },
			{ projectId: brand, status: "submitted" },
		]);
		expect(plan.waiting).toEqual([{ projectId: brand, deliveryManagers: [dora.user.id] }]);
		const [first, ...rest] = plan.statements;
		if (!first) throw new Error("nothing planned");
		await scope.batch([first, ...rest]);
		expect(await partsOf(linus)).toEqual({ line: "approved", [brand]: "submitted" });
	});
});
