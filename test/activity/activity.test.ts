import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ACTIVITY_RETENTION_DAYS,
	activityExpiry,
	changes,
	deleteExpiredActivity,
	REDACTED,
	record,
	recordStatement,
} from "~/activity/activity.server";
import { type OrganisationScope, organisationScope, organisations, users, uuidv7 } from "~/db";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation } from "../organisations/harness";
import { type Person, person, submit } from "../pages/harness";

// The activity log (TS-064): one row for each change, saying who made it, to
// what, whose record it is about and what changed; never the text a person
// typed. Rows go after two years. The second half posts the pages' own forms
// through the Worker and reads what each one recorded.

const DAY = 24 * 60 * 60 * 1000;

/** A row of the log as D1 holds it, with its summary parsed. */
interface Stored {
	organisationId: string;
	actorId: string | null;
	source: string;
	action: string;
	subjectType: string;
	subjectId: string;
	ownerId: string | null;
	summary: string;
}

async function stored() {
	const { results } = await env.DB.prepare(
		`select organisation_id as organisationId, actor_id as actorId, source, action,
		subject_type as subjectType, subject_id as subjectId, owner_id as ownerId, summary
		from activity_records order by rowid`,
	).all<Stored>();
	return results.map((row) => ({ ...row, summary: JSON.parse(row.summary) as unknown }));
}

/** Every row's summary as it is stored, to search for text that must not be there. */
async function storedText() {
	const { results } = await env.DB.prepare("select summary from activity_records").all<{
		summary: string;
	}>();
	return results.map((row) => row.summary).join("\n");
}

beforeEach(async () => {
	await freshDatabase();
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the log", () => {
	let acme: OrganisationScope;
	let globex: OrganisationScope;
	let ada: string;

	beforeEach(async () => {
		const db = drizzle(env.DB);
		const [a, g] = await db
			.insert(organisations)
			.values([
				{ name: "Acme", slug: "acme" },
				{ name: "Globex", slug: "globex" },
			])
			.returning();
		const [u] = await db
			.insert(users)
			.values({ name: "Ada", email: "ada@example.com" })
			.returning();
		if (!a || !g || !u) throw new Error("seed failed");
		acme = organisationScope(env.DB, a.id);
		globex = organisationScope(env.DB, g.id);
		await acme.memberships.insert({ userId: u.id, role: "owner" });
		ada = u.id;
	});

	it("records an action with its actor, subject, owner and source", async () => {
		const entry = uuidv7();
		await record(
			acme,
			ada,
			"time_entry.updated",
			{ type: "time_entry", id: entry, ownerId: ada },
			{ before: { endedAt: 1 }, after: { endedAt: 2 } },
		);

		expect(await stored()).toEqual([
			{
				organisationId: acme.organisationId,
				actorId: ada,
				source: "web",
				action: "time_entry.updated",
				subjectType: "time_entry",
				subjectId: entry,
				ownerId: ada,
				summary: { before: { endedAt: 1 }, after: { endedAt: 2 } },
			},
		]);
	});

	it("records the system as no actor, and an organisation's own thing as nobody's", async () => {
		await record(
			acme,
			null,
			"lock_date.changed",
			{ type: "organisation", id: "acme" },
			{},
			"system",
		);

		expect(await stored()).toMatchObject([
			{ actorId: null, ownerId: null, source: "system", summary: {} },
		]);
	});

	it("writes a statement in the same batch as the change it records", async () => {
		const id = uuidv7();
		await acme.batch([
			acme.clients.statements.insert({ id, name: "Initech", nameKey: "initech" }),
			recordStatement(
				acme,
				ada,
				"client.created",
				{ type: "client", id },
				changes(null, { name: "Initech" }, ["name"]),
			),
		]);

		expect(await stored()).toMatchObject([
			{
				organisationId: acme.organisationId,
				actorId: ada,
				action: "client.created",
				subjectType: "client",
				subjectId: id,
				ownerId: null,
				summary: { after: { name: "Initech" } },
			},
		]);
	});

	it("leaves nothing behind when the batch fails", async () => {
		const id = uuidv7();
		await acme.clients.insert({ id, name: "Initech", nameKey: "initech" });

		await expect(
			acme.batch([
				acme.clients.statements.insert({ id: uuidv7(), name: "INITECH", nameKey: "initech" }),
				recordStatement(acme, ada, "client.created", { type: "client", id }),
			]),
		).rejects.toThrow();
		expect(await stored()).toEqual([]);
	});

	it("keeps each organisation's rows to itself", async () => {
		await record(globex, ada, "project.created", { type: "project", id: uuidv7() });

		expect(await acme.activityRecords.select()).toEqual([]);
		expect(await globex.activityRecords.select()).toHaveLength(1);
	});

	describe("changes", () => {
		it("keeps the changed fields only, a date as milliseconds", () => {
			const before = { projectId: "p1", startedAt: new Date(1_000), endedAt: new Date(2_000) };
			const after = { projectId: "p2", startedAt: new Date(1_000), endedAt: new Date(3_000) };

			expect(changes(before, after, ["projectId", "startedAt", "endedAt"])).toEqual({
				before: { projectId: "p1", endedAt: 2_000 },
				after: { projectId: "p2", endedAt: 3_000 },
			});
		});

		it("has only `after` for a thing created and only `before` for one deleted", () => {
			expect(changes(null, { name: "Site", clientId: null }, ["name", "clientId"])).toEqual({
				after: { name: "Site", clientId: null },
			});
			expect(changes({ name: "Site" }, null, ["name"])).toEqual({ before: { name: "Site" } });
		});

		it("records a changed description, note or comment as a marker, never its text", () => {
			const summary = changes(
				{ description: "Fixed the pump", notes: null, comment: "Add Friday" },
				{ description: "Fixed the valve", notes: "Taxi", comment: "Add Friday" },
				["description", "notes", "comment"],
			);

			expect(summary).toEqual({ after: { description: REDACTED, notes: REDACTED } });
			expect(JSON.stringify(summary)).not.toMatch(/pump|valve|Taxi|Friday/);
		});

		it("records a deleted description on the side that stood, and an empty one not at all", () => {
			expect(changes({ description: "Survey" }, null, ["description"])).toEqual({
				before: { description: REDACTED },
			});
			expect(changes({ description: null }, { description: "" }, ["description"])).toEqual({});
		});
	});

	it("never stores free text, even from a summary built by hand", async () => {
		await record(
			acme,
			ada,
			"time_entry.updated",
			{ type: "time_entry", id: uuidv7(), ownerId: ada },
			{ before: { description: "Fixed the pump" }, after: { description: "Fixed the valve" } },
		);

		expect((await stored())[0]?.summary).toEqual({
			before: { description: REDACTED },
			after: { description: REDACTED },
		});
		expect(await storedText()).not.toMatch(/pump|valve/);
	});

	describe("retention", () => {
		const NOW = new Date("2026-11-11T03:00:00Z");
		const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

		it("is two years", () => {
			expect(ACTIVITY_RETENTION_DAYS).toBe(730);
			expect(activityExpiry(NOW)).toEqual(daysAgo(730));
		});

		it("deletes the rows older than two years in every organisation, and keeps the rest", async () => {
			const row = (scope: OrganisationScope, days: number) =>
				scope.activityRecords.insert({
					actorId: ada,
					action: "project.created",
					subjectType: "project",
					subjectId: `${days}`,
					summary: {},
					createdAt: daysAgo(days),
				});
			await row(acme, 729);
			await row(acme, 731);
			await row(globex, 731);
			await row(globex, 1);

			expect(await deleteExpiredActivity(env.DB, NOW)).toBe(2);
			expect((await stored()).map((r) => r.subjectId).sort()).toEqual(["1", "729"]);
		});
	});
});

describe("the pages record", () => {
	const ACTION = "/app/acme?index";
	const LONDON = "Europe/London";
	/** A Wednesday, 10:00 in London. */
	const T0 = Date.parse("2026-11-11T10:00:00Z");

	let mailbox: Mailbox;
	let ada: Person;
	let acme: { id: string };
	let site: string;

	beforeEach(async () => {
		mailbox = captureEmail();
		ada = await person(mailbox, "ada@example.com");
		acme = await createOrganisation(ada.cookie, "Acme");
		// What these tests count starts after the organisation was made, with the
		// system's records of its usual expense categories (TS-119).
		await env.DB.prepare("delete from activity_records").run();
		site = uuidv7();
		await env.DB.prepare(
			"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Site', 'site', 0, 0)",
		)
			.bind(site, acme.id)
			.run();
		await env.DB.prepare("update users set time_zone = ? where id = ?")
			.bind(LONDON, ada.user.id)
			.run();
		vi.spyOn(Date, "now").mockReturnValue(T0);
	}, 30_000);

	/** Posts one of a page's forms by script, as Ada unless said, and returns the status. */
	async function post(fields: Record<string, string>, path = ACTION) {
		return (await submit(path, fields, ada, { byScript: true })).status;
	}

	it("a timer started, by and about the person, without its description", async () => {
		expect(
			await post({ intent: "track", day: "2026-11-11", projectId: site, description: "Plans" }),
		).toBe(200);

		const rows = await stored();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "time_entry.started",
			subjectType: "time_entry",
			actorId: ada.user.id,
			ownerId: ada.user.id,
			summary: { after: { projectId: site, description: REDACTED, startedAt: T0 } },
		});
		expect(await storedText()).not.toContain("Plans");
	});

	it("an entry changed, with what it was and what it is, but no description", async () => {
		const id = uuidv7();
		await env.DB.prepare(
			"insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, ended_at, created_at, updated_at) values (?, ?, ?, ?, 'Survey', ?, ?, 0, 0)",
		)
			.bind(
				id,
				acme.id,
				ada.user.id,
				site,
				Date.parse("2026-11-10T13:00:00Z"),
				Date.parse("2026-11-10T14:00:00Z"),
			)
			.run();

		expect(
			await post({
				intent: "edit",
				entryId: id,
				projectId: site,
				date: "2026-11-10",
				start: "09:00",
				end: "10:30",
				description: "Survey of the north wall",
			}),
		).toBe(200);

		const rows = await stored();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "time_entry.updated",
			subjectId: id,
			actorId: ada.user.id,
			ownerId: ada.user.id,
			summary: {
				before: {
					startedAt: Date.parse("2026-11-10T13:00:00Z"),
					endedAt: Date.parse("2026-11-10T14:00:00Z"),
				},
				after: {
					description: REDACTED,
					startedAt: Date.parse("2026-11-10T09:00:00Z"),
					endedAt: Date.parse("2026-11-10T10:30:00Z"),
				},
			},
		});
		expect(await storedText()).not.toMatch(/Survey|north wall/);
	});

	it("a week submitted, by and about the person", async () => {
		expect(await post({ intent: "submit", startsOn: "2026-11-09" })).toBe(200);
		const period = await env.DB.prepare("select id from periods").first<{ id: string }>();

		const rows = await stored();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "period.submitted",
			subjectType: "period",
			subjectId: period?.id,
			actorId: ada.user.id,
			ownerId: ada.user.id,
			summary: { after: { status: "submitted" } },
		});
	});

	it("a project created, by the person, about the organisation", async () => {
		expect(await post({ intent: "create", name: "Design" }, "/app/acme/projects")).toBe(200);
		const project = await env.DB.prepare("select id from projects where name = 'Design'").first<{
			id: string;
		}>();

		const rows = await stored();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "project.created",
			subjectType: "project",
			subjectId: project?.id,
			actorId: ada.user.id,
			ownerId: null,
			summary: { after: { name: "Design", clientId: null } },
		});
	});

	it("a client created, by the person, about the organisation", async () => {
		expect(await post({ intent: "create", name: "Initech" }, "/app/acme/clients")).toBe(200);
		const client = await env.DB.prepare("select id from clients where name = 'Initech'").first<{
			id: string;
		}>();

		const rows = await stored();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "client.created",
			subjectType: "client",
			subjectId: client?.id,
			actorId: ada.user.id,
			ownerId: null,
			summary: { after: { name: "Initech" } },
		});
	});
});
