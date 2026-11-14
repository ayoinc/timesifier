import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, openData, type Person, person, submit, textOf } from "./harness";
import { seedLeave } from "./leave-seed";

// Review > Activity log and an entry's history (TS-072): the records each
// role reads (`activityScopeOf`), the filters, the CSV, and the records the
// pages write for entries, periods, leave and the lock date. Descriptions are
// never shown, only that they changed.

let mailbox: Mailbox;
let ada: Person;
let grace: Person;
let alan: Person;
let acme: { id: string; slug: string };
let site: string;
let log: string;
let sheet: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	await env.DB.prepare("update users set name = 'Ada Lovelace' where id = ?")
		.bind(ada.user.id)
		.run();
	grace = await joined("grace@example.com", "member", "Grace Hopper");
	alan = await joined("alan@example.com", "member", "Alan Turing");
	site = uuidv7();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Site', 'site', 0, 0)",
	)
		.bind(site, acme.id)
		.run();
	log = `/app/${acme.slug}/activity`;
	sheet = `/app/${acme.slug}?index`;
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function joined(email: string, role: Role, name: string) {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	await env.DB.prepare("update users set name = ? where id = ?").bind(name, who.user.id).run();
	return who;
}

async function post(path: string, fields: Record<string, string>, who: Person) {
	return (await submit(path, fields, who, { byScript: true })).status;
}

/** Each of Grace and Alan tracks an hour with a description, and Ada creates a project. */
async function someWork() {
	expect(
		await post(
			sheet,
			{
				intent: "track",
				projectId: site,
				day: "2026-11-10",
				hours: "1",
				description: "Secret plans",
			},
			grace,
		),
	).toBe(200);
	expect(
		await post(sheet, { intent: "track", projectId: site, day: "2026-11-10", hours: "2" }, alan),
	).toBe(200);
	expect(await post(`/app/${acme.slug}/projects`, { intent: "create", name: "Launch" }, ada)).toBe(
		200,
	);
}

const entryOf = (who: Person) =>
	value<string>("select id from time_entries where user_id = ?", who.user.id);

describe("who reads what", () => {
	it.each(["owner", "admin", "finance"] as const)(
		"%s reads every record, the organisation's own too",
		async (role) => {
			await someWork();
			const reader =
				role === "owner" ? ada : await joined(`${role}@example.com`, role, `${role} person`);
			const text = textOf(await (await open(log, reader)).text());
			expect(text).toContain("Grace Hopper");
			expect(text).toContain("Alan Turing");
			expect(text).toContain("Created project Launch");
			expect(text).not.toContain("Secret plans");
		},
	);

	it("a manager reads their teams' people's records and their own, and nothing of the organisation's", async () => {
		await someWork();
		const kath = await joined("kath@example.com", "member", "Katherine Johnson");
		await seedTeam(acme.id, "Survey", { members: [grace.user.id], managers: [kath.user.id] });
		const text = textOf(await (await open(log, kath)).text());
		expect(text).toContain("Grace Hopper");
		expect(text).not.toContain("Alan Turing");
		expect(text).not.toContain("Created project Launch");
		const csv = await (await open(`${log}/export`, kath)).text();
		expect(csv).toContain("Grace Hopper");
		expect(csv).not.toContain("Alan Turing");
	});

	it("a member is not shown the log, nor its export", async () => {
		expect((await open(log, grace)).status).toBe(404);
		expect((await openData(log, grace)).status).toBe(404);
		expect((await open(`${log}/export`, grace)).status).toBe(404);
	});
});

describe("the filters and the export", () => {
	it("narrows by kind, project, performed by, owned by and range", async () => {
		await someWork();
		const only = async (search: string) =>
			textOf(await (await open(`${log}?${search}`, ada)).text());
		expect(await only("kind=project")).not.toContain("Started the timer");
		expect(await only("kind=project")).toContain("Created project Launch");
		expect(await only(`project=${site}`)).not.toContain("Created project Launch");
		// The page names everyone in its filters, so who is in the records is read from the export.
		const csv = async (search: string) => (await open(`${log}/export?${search}`, ada)).text();
		expect(await csv(`actor=${grace.user.id}`)).toContain("Grace Hopper");
		expect(await csv(`actor=${grace.user.id}`)).not.toContain("Alan Turing");
		expect(await csv(`owner=${alan.user.id}`)).toContain("Alan Turing");
		expect(await csv(`owner=${alan.user.id}`)).not.toContain("Grace Hopper");
		expect(await only("actor=system")).toContain("No records in this range");
		expect(await only("from=2026-10-01&to=2026-10-31")).toContain("No records in this range");
	});

	it("exports the same records as CSV, never their descriptions", async () => {
		await someWork();
		const response = await open(`${log}/export?kind=time_entry`, ada);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Disposition")).toMatch(
			/^attachment; filename="acme-activity-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}-exported-\d{4}-\d{2}-\d{2}\.csv"$/,
		);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const csv = await response.text();
		const lines = csv.trim().split("\r\n");
		expect(lines[0]).toBe(
			"recorded_at,performed_by,source,action,what,owned_by,subject_type,subject_id,changes",
		);
		expect(lines).toHaveLength(3);
		expect(csv).toContain("time_entry.created");
		expect(csv).not.toContain("Secret plans");
		expect((await open(`${log}/export?from=2026-11-12&to=2026-11-01`, ada)).status).toBe(400);
	});
});

describe("an entry's history", () => {
	it("is read by the entry's person, their manager and those who read everything, and nobody else", async () => {
		await someWork();
		const id = await entryOf(grace);
		const kath = await joined("kath@example.com", "member", "Katherine Johnson");
		await seedTeam(acme.id, "Survey", { members: [grace.user.id], managers: [kath.user.id] });
		const history = `/app/${acme.slug}/history?entry=${id}`;
		for (const who of [grace, kath, ada]) expect((await open(history, who)).status).toBe(200);
		expect((await open(history, alan)).status).toBe(404);
		expect((await open(`/app/${acme.slug}/history?entry=${uuidv7()}`, grace)).status).toBe(404);
	});

	it("lists each change with old and new values, and stays after the entry is deleted", async () => {
		await someWork();
		const id = (await entryOf(grace)) as string;
		expect(
			await post(
				sheet,
				{
					intent: "edit",
					entryId: id,
					projectId: site,
					date: "2026-11-10",
					start: "08:00",
					end: "09:30",
					description: "Other words",
				},
				grace,
			),
		).toBe(200);
		expect(await post(sheet, { intent: "delete", entryId: id }, grace)).toBe(200);
		const text = textOf(await (await open(`/app/${acme.slug}/history?entry=${id}`, grace)).text());
		expect(text).toContain("Created a time entry");
		expect(text).toContain("Changed a time entry");
		expect(text).toContain("Description: added (not shown)");
		expect(text).toContain("Description: removed (not shown)");
		expect(text).toContain("Deleted a time entry");
		expect(text).toContain("since deleted");
		expect(text).not.toContain("Secret plans");
		expect(text).not.toContain("Other words");
	});
});

describe("the pages record", () => {
	const actions = async () => {
		const { results } = await env.DB.prepare(
			"select action, actor_id as actor, owner_id as owner from activity_records order by rowid",
		).all<{
			action: string;
			actor: string | null;
			owner: string | null;
		}>();
		return results;
	};

	it("a timer stopped, a week submitted, withdrawn, approved, reopened and returned", async () => {
		// A Wednesday and its Monday: a new organisation's week has no weekend,
		// which takes no time, so the timer is not started on the real clock.
		const wednesday = Date.parse("2026-11-11T10:00:00Z");
		const monday = "2026-11-09";
		vi.spyOn(Date, "now").mockReturnValue(wednesday);
		expect(await post(sheet, { intent: "track", projectId: site, day: "2026-11-11" }, grace)).toBe(
			200,
		);
		vi.spyOn(Date, "now").mockReturnValue(wednesday + 60_000);
		expect(await post(sheet, { intent: "stop" }, grace)).toBe(200);
		expect(await post(sheet, { intent: "submit", startsOn: monday }, grace)).toBe(200);
		expect(await post(sheet, { intent: "withdraw", startsOn: monday }, grace)).toBe(200);
		expect(await post(sheet, { intent: "submit", startsOn: monday }, grace)).toBe(200);
		const period = (await value<string>(
			"select id from periods where user_id = ?",
			grace.user.id,
		)) as string;
		const approvals = `/app/${acme.slug}/approvals`;
		expect(await post(approvals, { intent: "approve", periodId: period }, ada)).toBe(200);
		expect(
			await post(approvals, { intent: "reopen", periodId: period, comment: "Wrong project" }, ada),
		).toBe(200);
		expect(await post(sheet, { intent: "submit", startsOn: monday }, grace)).toBe(200);
		expect(
			await post(approvals, { intent: "return", periodId: period, comment: "Again" }, ada),
		).toBe(200);

		expect((await actions()).map((r) => r.action)).toEqual([
			"time_entry.started",
			"time_entry.stopped",
			"period.submitted",
			"period.withdrawn",
			"period.submitted",
			"period.approved",
			"period.reopened",
			"period.submitted",
			"period.returned",
		]);
		expect((await actions()).every((r) => r.owner === grace.user.id)).toBe(true);
	});

	it("leave asked for, approved, refused, withdrawn and cancelled, by who took each step", async () => {
		const timeOff = `/app/${acme.slug}/time-off`;
		const a = await seedLeave(acme.id, grace.user.id, "annual", "2026-11-23", "2026-11-23", {
			status: "pending",
		});
		const b = await seedLeave(acme.id, grace.user.id, "annual", "2026-11-24", "2026-11-24", {
			status: "pending",
		});
		const c = await seedLeave(acme.id, grace.user.id, "annual", "2026-11-25", "2026-11-25", {
			status: "pending",
		});
		expect(await post(timeOff, { intent: "approve", requestId: a }, ada)).toBe(200);
		expect(await post(timeOff, { intent: "refuse", requestId: b }, ada)).toBe(200);
		expect(await post(timeOff, { intent: "withdraw", requestId: c }, grace)).toBe(200);
		expect(
			await post(timeOff, { intent: "cancel", requestId: a, comment: "Needed on site" }, ada),
		).toBe(200);
		expect(await actions()).toEqual([
			{ action: "leave.approved", actor: ada.user.id, owner: grace.user.id },
			{ action: "leave.declined", actor: ada.user.id, owner: grace.user.id },
			{ action: "leave.withdrawn", actor: grace.user.id, owner: grace.user.id },
			{ action: "leave.cancelled", actor: ada.user.id, owner: grace.user.id },
		]);
		expect(
			await value("select count(*) from activity_records where summary like '%Needed on site%'"),
		).toBe(0);
	});

	it("the lock date, shown in the log with its reason", async () => {
		await post(
			`/app/${acme.slug}/settings`,
			{ intent: "lock-date", lockedThrough: "2026-11-05" },
			ada,
		);
		const text = textOf(await (await open(`${log}?kind=organisation`, ada)).text());
		expect(text).toContain("Changed the lock date");
		expect(text).toContain("Lock date: 5 November 2026");
	});
});
