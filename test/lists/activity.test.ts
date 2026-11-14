import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { uuidv7 } from "~/db";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { open, pageBody, textOf } from "../pages/harness";
import { kindOf } from "../pages/leave-seed";
import { type Crowd, MANAGED, seedCrowd } from "./crowd";

// The Activity log and its export when a page names many things (TS-112).
// Before TS-112 the log looked every id on its page up in every table, in a
// parameter each: 100 distinct things on a page answered 500, and the export
// ended after its header (`research/corporate/scale-test.md`, D2). Now each
// table is asked only for the ids that can be its own, as one JSON value.

let crowd: Crowd;
/** How many records the log holds, all of them in the export. */
let recorded: number;

const NOW = Date.now();

async function insert(sql: string, ...values: unknown[]) {
	await env.DB.prepare(sql)
		.bind(...values)
		.run();
}

/** One thing of every kind the log names, beside the projects. */
async function seedThings(organisationId: string) {
	const ids = {
		client: uuidv7(),
		task: uuidv7(),
		tag: uuidv7(),
		category: uuidv7(),
		schedule: uuidv7(),
		invoice: uuidv7(),
		estimate: uuidv7(),
	};
	const named = (table: string, id: string, name: string) =>
		insert(
			`insert into ${table} (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, ?, ?, 0, 0)`,
			id,
			organisationId,
			name,
			name.toLowerCase(),
		);
	await named("clients", ids.client, "Globex");
	await named("tasks", ids.task, "Design");
	await named("tags", ids.tag, "Urgent");
	await named("expense_categories", ids.category, "Travel");
	await named("work_schedules", ids.schedule, "Nights");
	await insert(
		"insert into invoices (id, organisation_id, number, client_id, currency, issued_on, due_on, created_at, updated_at) values (?, ?, 'INV-0042', ?, 'GBP', '2026-01-05', '2026-02-04', 0, 0)",
		ids.invoice,
		organisationId,
		ids.client,
	);
	await insert(
		"insert into estimates (id, organisation_id, number, client_id, currency, issued_on, created_at, updated_at) values (?, ?, 'EST-0042', ?, 'GBP', '2026-01-05', 0, 0)",
		ids.estimate,
		organisationId,
		ids.client,
	);
	return ids;
}

interface Record {
	actor: string;
	owner: string | null;
	action: string;
	type: string;
	subject: string;
	summary?: object;
}

async function seedRecords(organisationId: string, records: Record[]) {
	await env.DB.batch(
		records.map((r, i) =>
			env.DB.prepare(
				"insert into activity_records (id, organisation_id, actor_id, source, action, subject_type, subject_id, owner_id, summary, created_at) values (?, ?, ?, 'web', ?, ?, ?, ?, ?, ?)",
			).bind(
				uuidv7(),
				organisationId,
				r.actor,
				r.action,
				r.type,
				r.subject,
				r.owner,
				JSON.stringify(r.summary ?? {}),
				// The first the newest, a second apart.
				NOW - i * 1000,
			),
		),
	);
}

beforeEach(async () => {
	await freshDatabase();
	crowd = await seedCrowd(captureEmail());
	const { acme, others, projects } = crowd;
	const things = await seedThings(acme.id);
	const annual = await kindOf(acme.id, "annual");
	const actor = (i: number) => others[i % others.length] ?? "";
	// 150 distinct things, newest: 140 projects and one of each other kind.
	const named: Record[] = [
		...projects.slice(0, 140).map((subject, i) => ({
			actor: actor(i),
			owner: null,
			action: "project.renamed",
			type: "project",
			subject,
			summary: { before: { name: "Old" }, after: { name: "New" } },
		})),
		{
			actor: actor(140),
			owner: null,
			action: "client.renamed",
			type: "client",
			subject: things.client,
		},
		{ actor: actor(141), owner: null, action: "task.archived", type: "task", subject: things.task },
		{ actor: actor(142), owner: null, action: "tag.archived", type: "tag", subject: things.tag },
		{
			actor: actor(143),
			owner: null,
			action: "expense_category.archived",
			type: "expense_category",
			subject: things.category,
		},
		{
			actor: actor(144),
			owner: null,
			action: "work_schedule.archived",
			type: "work_schedule",
			subject: things.schedule,
		},
		{
			actor: actor(145),
			owner: null,
			action: "invoice.sent",
			type: "invoice",
			subject: things.invoice,
		},
		{
			actor: actor(146),
			owner: null,
			action: "estimate.sent",
			type: "estimate",
			subject: things.estimate,
		},
		{
			actor: actor(0),
			owner: actor(0),
			action: "leave.requested",
			type: "leave",
			subject: uuidv7(),
			summary: { after: { kindId: annual } },
		},
		{
			actor: actor(1),
			owner: actor(1),
			action: "time_entry.updated",
			type: "time_entry",
			subject: uuidv7(),
			summary: {
				before: { projectId: projects[149], taskId: null },
				after: { projectId: projects[148], taskId: things.task },
			},
		},
		{
			actor: crowd.owner.user.id,
			owner: null,
			action: "team.renamed",
			type: "team",
			subject: crowd.team,
		},
	];
	// Older: an entry changed by each of the people the manager manages, each moved between two of the projects.
	const entries: Record[] = crowd.managed.map((person, i) => ({
		actor: person,
		owner: person,
		action: "time_entry.updated",
		type: "time_entry",
		subject: uuidv7(),
		summary: { before: { projectId: projects[i] }, after: { projectId: projects[i + 1] } },
	}));
	await seedRecords(acme.id, [...named, ...entries]);
	recorded = named.length + entries.length;
}, 60_000);

describe("the Activity log naming 150 things", () => {
	it("names every kind of thing on an owner's page", async () => {
		const response = await open("/app/acme/activity", crowd.owner);
		expect(response.status).toBe(200);
		const text = textOf(await pageBody(response));
		expect(text).toContain("Renamed project Project 001");
		expect(text).toContain("Renamed project Project 140");
		expect(text).toContain("Renamed client Globex");
		expect(text).toContain("Renamed team Many");
		expect(text).toContain("Archived task Design");
		expect(text).toContain("Archived tag Urgent");
		expect(text).toContain("Archived expense category Travel");
		expect(text).toContain("Archived work schedule Nights");
		expect(text).toContain("Sent invoice INV-0042");
		expect(text).toContain("Sent estimate EST-0042");
		expect(text).toContain("Annual leave");
		expect(text).toContain("Project 150 → Project 149");
		expect(text).toContain("Project: Project 150 → Project 149 · Task: Design");
		expect(text).toContain("Person 147");
	});

	it(`opens for a manager of ${MANAGED}, naming the projects of their people's entries`, async () => {
		const response = await open("/app/acme/activity", crowd.manager);
		expect(response.status).toBe(200);
		const text = textOf(await pageBody(response));
		expect(text).toContain("Project 001 → Project 002");
		expect(text).toContain("Project 120 → Project 121");
		expect(text).not.toContain("Renamed project");
	});

	it("exports every record, each named", async () => {
		const response = await open("/app/acme/activity/export", crowd.owner);
		expect(response.status).toBe(200);
		const csv = await response.text();
		const lines = csv.split("\r\n").filter((line) => line !== "");
		// The header and every record.
		expect(lines).toHaveLength(recorded + 1);
		expect(csv).toContain("Renamed project Project 140");
		expect(csv).toContain("Sent invoice INV-0042");
		expect(csv).toContain("Project 120 → Project 121");
	});
});
