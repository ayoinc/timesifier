import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SignedIn } from "~/auth/auth.server";
import { organisationScope, users, uuidv7 } from "~/db";
import {
	NO_CLIENT_TITLE,
	type PickerProject,
	projectSections,
	RECENT_TITLE,
} from "~/projects/ProjectPicker";
import { trackChoices } from "~/tasks/track.server";
import { instantAt } from "~/time/calendar";
import { CLIENT_PROJECT_TERMS, termsOf, type WorkModel } from "~/workspace/work-model";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, membershipIn } from "../organisations/harness";
import { open, type Person, pageBody, person, textOf } from "./harness";
import { entryDay } from "./periods-seed";

// Codes on the Timesheet (TS-115a): a project's code comes before its name,
// and its client's before the client's, in the Day view, the Week grid, the
// calendar and the Track time picker, where typing a code finds it; under
// Both the work codes are a section of their own; under Internal work no word
// of the page says project or client.

const PAGE = "/app/acme";
const LONDON = "Europe/London";
/** A Wednesday, 10:00 in London. */
const T0 = Date.parse("2026-11-11T10:00:00Z");

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	await env.DB.prepare("update users set time_zone = ? where id = ?")
		.bind(LONDON, ada.user.id)
		.run();
	vi.spyOn(Date, "now").mockReturnValue(T0);
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

function setWorkModel(model: WorkModel) {
	return env.DB.prepare("update organisations set work_model = ? where id = ?")
		.bind(model, acme.id)
		.run();
}

async function seedClient(name: string, code: string | null) {
	const id = uuidv7();
	await env.DB.prepare(
		"insert into clients (id, organisation_id, name, name_key, code, code_key, created_at, updated_at) values (?, ?, ?, ?, ?, lower(?), 0, 0)",
	)
		.bind(id, acme.id, name, name.toLowerCase(), code, code)
		.run();
	return id;
}

async function seedProject(
	name: string,
	{ code = null as string | null, clientId = null as string | null, billingType = "hourly" } = {},
) {
	const id = uuidv7();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, code, code_key, client_id, billing_type, created_at, updated_at) values (?, ?, ?, ?, ?, lower(?), ?, ?, 0, 0)",
	)
		.bind(id, acme.id, name, name.toLowerCase(), code, code, clientId, billingType)
		.run();
	return id;
}

/** An hour of Ada's on the Wednesday, from 09:00 in London. */
async function seedHour(projectId: string) {
	const startedAt = instantAt("2026-11-11", 9 * 60, LONDON);
	await env.DB.prepare(
		"insert into time_entries (id, organisation_id, user_id, project_id, started_at, spent_on, ended_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 0, 0)",
	)
		.bind(
			uuidv7(),
			acme.id,
			ada.user.id,
			projectId,
			startedAt,
			await entryDay(acme.id, ada.user.id, startedAt),
			startedAt + 3_600_000,
		)
		.run();
}

async function textAt(path: string) {
	const response = await open(path, ada);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
}

const VIEWS = {
	day: PAGE,
	week: `${PAGE}?view=week&start=2026-11-09`,
	calendar: `${PAGE}?view=calendar&date=2026-11-11`,
	month: `${PAGE}?view=calendar&scale=month&date=2026-11-11`,
};

describe("a project's code on the Timesheet (TS-115a)", () => {
	it("comes before the project's name in the Day view, the Week grid and the calendar", async () => {
		const globex = await seedClient("Globex", "GLX");
		const website = await seedProject("Website", { code: "ACME-001", clientId: globex });
		await seedHour(website);

		expect(await textAt(VIEWS.day)).toContain("ACME-001 · Website");
		expect(await textAt(VIEWS.week)).toContain("ACME-001 · Website");
		expect(await textAt(VIEWS.calendar)).toContain("ACME-001 · Website");
	});

	it("is given to the picker with the client's code, and which projects are work codes", async () => {
		await setWorkModel("both");
		const globex = await seedClient("Globex", "GLX");
		const website = await seedProject("Website", { code: "ACME-001", clientId: globex });
		const admin = await seedProject("Admin", { code: "INT-01", billingType: "non_billable" });
		const pitch = await seedProject("Pitch");

		const [user] = await drizzle(env.DB).select().from(users).where(eq(users.id, ada.user.id));
		const membership = await membershipIn(user as SignedIn["user"], "acme");
		const choices = await trackChoices(organisationScope(env.DB, acme.id), membership, [], T0);
		expect(choices.projects).toEqual({
			[website]: { code: "ACME-001", client: { name: "Globex", code: "GLX" }, workCode: false },
			[admin]: { code: "INT-01", client: null, workCode: true },
			[pitch]: { code: null, client: null, workCode: false },
		});
	});

	it("gives the picker no clients where the organisation works internally", async () => {
		const globex = await seedClient("Globex", "GLX");
		const website = await seedProject("Website", { code: "ACME-001", clientId: globex });
		await setWorkModel("internal");

		const [user] = await drizzle(env.DB).select().from(users).where(eq(users.id, ada.user.id));
		const membership = await membershipIn(user as SignedIn["user"], "acme");
		const choices = await trackChoices(organisationScope(env.DB, acme.id), membership, [], T0);
		expect(choices.projects[website]).toEqual({ code: "ACME-001", client: null, workCode: false });
	});
});

describe("the project picker's list with codes (TS-115a)", () => {
	const PROJECTS: PickerProject[] = [
		{ id: "web", name: "Website", code: "ACME-001", clientName: "Globex", clientCode: "GLX" },
		{ id: "app", name: "App", code: "ACME-002", clientName: "Globex", clientCode: "GLX" },
		{ id: "pitch", name: "Pitch", code: null, clientName: null, clientCode: null },
		{ id: "admin", name: "Admin", code: "INT-01", clientName: null, workCode: true },
		{ id: "leave", name: "Training", code: "INT-02", clientName: null, workCode: true },
	];

	const shape = (query: string, model: WorkModel = "both", recent: string[] = []) =>
		projectSections(PROJECTS, recent, query, termsOf(model, "Cost centres")).map((section) => [
			section.title,
			section.projects.map((project) => project.id),
		]);

	it("names each client by its code first, and sorts projects by code", () => {
		expect(shape("")).toEqual([
			["GLX · Globex", ["web", "app"]],
			[NO_CLIENT_TITLE, ["pitch"]],
			["Cost centres", ["admin", "leave"]],
		]);
	});

	it("finds a project by its code, in any case", () => {
		expect(shape("acme-002")).toEqual([["GLX · Globex", ["app"]]]);
		expect(shape("INT-0")).toEqual([["Cost centres", ["admin", "leave"]]]);
	});

	it("finds a client's projects by the client's code or name", () => {
		expect(shape("glx")).toEqual([["GLX · Globex", ["web", "app"]]]);
		expect(shape("globex")).toEqual([["GLX · Globex", ["web", "app"]]]);
	});

	it("keeps work codes with the projects that have no client outside Both", () => {
		expect(
			projectSections(PROJECTS, [], "", CLIENT_PROJECT_TERMS).map((section) => section.title),
		).toEqual(["GLX · Globex", NO_CLIENT_TITLE]);
	});

	it("puts every project in one section of the organisation's term under Internal work, recent first", () => {
		expect(shape("", "internal", ["admin"])).toEqual([
			[RECENT_TITLE, ["admin"]],
			["Cost centres", ["web", "app", "leave", "pitch"]],
		]);
		// No client is shown there, so no client's name or code finds anything.
		expect(shape("glx", "internal")).toEqual([]);
	});
});

describe("the Timesheet under Internal work (TS-115a)", () => {
	const PROJECT_WORD = /\bprojects?\b/i;
	const CLIENT_WORD = /\bclients?\b/i;

	beforeEach(() => setWorkModel("internal"));

	it("says neither project nor client before there is anything to track", async () => {
		for (const path of Object.values(VIEWS)) {
			const text = await textAt(path);
			expect(text, path).not.toMatch(PROJECT_WORD);
			expect(text, path).not.toMatch(CLIENT_WORD);
		}
		expect(await textAt(VIEWS.day)).toContain("No work code to track yet");
	});

	it("says neither project nor client with time tracked, and shows the code first", async () => {
		const admin = await seedProject("Admin", { code: "INT-01", billingType: "non_billable" });
		await seedHour(admin);
		for (const path of Object.values(VIEWS)) {
			const text = await textAt(path);
			expect(text, path).not.toMatch(PROJECT_WORD);
			expect(text, path).not.toMatch(CLIENT_WORD);
		}
		expect(await textAt(VIEWS.week)).toContain("Work code");
		expect(await textAt(VIEWS.day)).toContain("INT-01 · Admin");
	});
});
