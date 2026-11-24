import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { makeToken } from "~/integrations/api-tokens.server";
import { API_SCOPES } from "~/integrations/scopes";
import { organisationMoney, pricingOf } from "~/projects/money.server";
import { lineKey } from "~/projects/work-packages";
import {
	createWorkPackage,
	setWorkPackageArchived,
	setWorkPackageState,
	type WorkPackageInput,
	workPackageProgress,
} from "~/projects/work-packages.server";
import { CSV_COLUMNS } from "~/reports/csv";
import { totalsOf } from "~/reports/report";
import { sumsOf } from "~/reports/sums.server";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, row, seedMembership, seedTeam, value } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "../pages/harness";
import { seedEntry, seedProject } from "../pages/periods-seed";

// Work packages (TS-115b, docs/decisions.md entry 73): a project's parts, each
// with a code unique in the project whatever its case. While a project has an
// open one, every new or changed entry names one, open and of that project, on
// every path an entry is written by; a closed one takes no new time and keeps
// what it has; entries from before are left as they are. The database refuses
// another project's work package even when the Worker is not asked.

const TIMESHEET = "/app/acme?index";
const HOUR = 3_600_000;
/** Wednesday 11 November 2026, 15:00 in London: the server's clock. */
const NOW = Date.parse("2026-11-11T15:00:00Z");

let mailbox: Mailbox;
let ada: Person;
let grace: Person;
let acme: { id: string };
let scope: OrganisationScope;
let globex: string;
let site: string;
let other: string;
let wp1: string;
let wp2: string;
let otherWp: string;

const input = (code: string, name: string, more: Partial<WorkPackageInput> = {}) => ({
	code,
	name,
	startsOn: null,
	endsOn: null,
	budget: { kind: "none" as const, amount: null },
	billable: true,
	...more,
});

async function made(projectId: string, code: string, name: string, more = {}) {
	const result = await createWorkPackage(scope, ada.user.id, projectId, input(code, name, more));
	if (!result.ok) throw new Error(result.problem);
	return result.id;
}

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
	await env.DB.prepare(
		"update projects set client_id = ?, code = 'GLX-001', code_key = 'glx-001' where id = ?",
	)
		.bind(globex, site)
		.run();
	other = await seedProject(acme.id, "Other");
	wp1 = await made(site, "WP1", "Discovery");
	wp2 = await made(site, "WP2", "Build");
	otherWp = await made(other, "OX1", "Elsewhere");
}, 30_000);

/** The server's clock at `NOW` for each test of the describe it is called in; signing in keeps the real one. */
function clockAtNow() {
	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

async function ask(who: Person, fields: Record<string, string>) {
	const response = await submit(TIMESHEET, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

/** Grace's entries, oldest first, with their work packages. */
async function entries() {
	const { results } = await env.DB.prepare(
		"select id, project_id, work_package_id, started_at, ended_at, description from time_entries where user_id = ? order by started_at",
	)
		.bind(grace.user.id)
		.all<{
			id: string;
			project_id: string;
			work_package_id: string | null;
			started_at: number;
			ended_at: number | null;
			description: string | null;
		}>();
	return results;
}

const NEEDS_ONE = "Choose an open work package of this project";
const CLOSED = "That work package is closed";

describe("the database", () => {
	it("keeps a code unique in its project whatever its case, and lets another project use it", async () => {
		const again = await createWorkPackage(scope, ada.user.id, site, input("wp1", "Again"));
		expect(again).toEqual({ ok: false, problem: "code-taken" });
		await expect(
			env.DB.prepare(
				"insert into work_packages (id, organisation_id, project_id, code, code_key, name, created_at, updated_at) values ('x', ?, ?, 'Wp1', 'wp1', 'Raw', 0, 0)",
			)
				.bind(acme.id, site)
				.run(),
		).rejects.toThrow(/UNIQUE/);
		const elsewhere = await createWorkPackage(scope, ada.user.id, other, input("WP1", "Same code"));
		expect(elsewhere.ok).toBe(true);
	});

	it("refuses an entry on another project's work package, on insert and on update", async () => {
		const insert = env.DB.prepare(
			"insert into time_entries (id, organisation_id, user_id, project_id, work_package_id, started_at, spent_on, ended_at, created_at, updated_at) values ('e1', ?, ?, ?, ?, ?, '2026-11-11', ?, 0, 0)",
		);
		await expect(
			insert.bind(acme.id, grace.user.id, site, otherWp, NOW - 2 * HOUR, NOW - HOUR).run(),
		).rejects.toThrow(/its own project/);
		await insert.bind(acme.id, grace.user.id, site, wp1, NOW - 2 * HOUR, NOW - HOUR).run();
		await expect(
			env.DB.prepare("update time_entries set work_package_id = ? where id = 'e1'")
				.bind(otherWp)
				.run(),
		).rejects.toThrow(/its own project/);
		await expect(
			env.DB.prepare("update time_entries set project_id = ? where id = 'e1'").bind(other).run(),
		).rejects.toThrow(/its own project/);
		await expect(
			env.DB.prepare("update work_packages set project_id = ? where id = ?").bind(other, wp1).run(),
		).rejects.toThrow(/stays in its project/);
		expect(await value("select work_package_id from time_entries where id = 'e1'")).toBe(wp1);
	});

	it("refuses another organisation's work package", async () => {
		const bob = await person(mailbox, "bob@example.com");
		const initech = await createOrganisation(bob.cookie, "Initech");
		const theirs = await seedProject(initech.id, "Theirs");
		await expect(
			env.DB.prepare(
				"insert into time_entries (id, organisation_id, user_id, project_id, work_package_id, started_at, spent_on, ended_at, created_at, updated_at) values ('e2', ?, ?, ?, ?, ?, '2026-11-11', ?, 0, 0)",
			)
				.bind(initech.id, bob.user.id, theirs, wp1, NOW - 2 * HOUR, NOW - HOUR)
				.run(),
		).rejects.toThrow(/its own project/);
	});
});

describe("tracking by hand and in a calendar slot", () => {
	clockAtNow();

	it("needs an open work package of the project while it has one", async () => {
		const track = { intent: "track", projectId: site, day: "2026-11-11", hours: "1" };
		const none = await ask(grace, track);
		expect(none.status).toBe(400);
		expect(none.said).toContain(NEEDS_ONE);
		expect((await ask(grace, { ...track, workPackageId: otherWp })).status).toBe(400);
		expect((await ask(grace, { ...track, workPackageId: wp1 })).status).toBe(200);
		expect((await ask(grace, { ...track, start: "09:00", workPackageId: wp2 })).status).toBe(200);
		expect((await entries()).map((e) => e.work_package_id).sort()).toEqual([wp1, wp2].sort());
		// A project with none takes time as before.
		expect((await ask(grace, { ...track, projectId: other, workPackageId: otherWp })).status).toBe(
			200,
		);
	});

	it("takes no new time on a closed work package, and needs none on a project whose work packages are all closed", async () => {
		await setWorkPackageState(scope, ada.user.id, site, wp1, "closed");
		const track = { intent: "track", projectId: site, day: "2026-11-11", hours: "1" };
		const closed = await ask(grace, { ...track, workPackageId: wp1 });
		expect(closed.status).toBe(409);
		expect(closed.said).toContain(CLOSED);
		await setWorkPackageArchived(scope, ada.user.id, site, wp2, true, NOW);
		expect((await ask(grace, { ...track, workPackageId: wp2 })).status).toBe(400);
		expect((await ask(grace, track)).status).toBe(200);
	});
});

describe("the timer", () => {
	clockAtNow();

	it("starts only on an open work package of the project, and stops with it", async () => {
		const start = { intent: "track", projectId: site, day: "2026-11-11" };
		expect((await ask(grace, start)).status).toBe(400);
		await setWorkPackageState(scope, ada.user.id, site, wp2, "closed");
		expect((await ask(grace, { ...start, workPackageId: wp2 })).status).toBe(409);
		expect((await ask(grace, { ...start, workPackageId: wp1 })).status).toBe(200);
		vi.spyOn(Date, "now").mockReturnValue(NOW + HOUR);
		expect((await ask(grace, { intent: "stop" })).status).toBe(200);
		expect(await entries()).toEqual([
			expect.objectContaining({ work_package_id: wp1, ended_at: NOW + HOUR }),
		]);
	});
});

describe("a cell of the Week grid", () => {
	clockAtNow();

	it("is a project and a work package: each line its own entry", async () => {
		const cell = { intent: "cell", projectId: site, day: "2026-11-10", hours: "2" };
		expect((await ask(grace, cell)).status).toBe(400);
		expect((await ask(grace, { ...cell, workPackageId: wp1 })).status).toBe(200);
		expect((await ask(grace, { ...cell, workPackageId: wp2, hours: "1" })).status).toBe(200);
		expect((await ask(grace, { ...cell, workPackageId: wp1, hours: "3" })).status).toBe(200);
		const shown = await entries();
		expect(
			shown.map((e) => [e.work_package_id, (Number(e.ended_at) - e.started_at) / HOUR]),
		).toEqual(
			expect.arrayContaining([
				[wp1, 3],
				[wp2, 1],
			]),
		);
		expect(shown).toHaveLength(2);
	});

	it("trims a closed work package's time and adds none to it", async () => {
		const cell = { intent: "cell", projectId: site, day: "2026-11-10", workPackageId: wp1 };
		await ask(grace, { ...cell, hours: "2" });
		await setWorkPackageState(scope, ada.user.id, site, wp1, "closed");
		expect((await ask(grace, { ...cell, hours: "3" })).status).toBe(409);
		expect((await ask(grace, { ...cell, hours: "1" })).status).toBe(200);
		const [entry] = await entries();
		expect((Number(entry?.ended_at) - Number(entry?.started_at)) / HOUR).toBe(1);
	});
});

describe("changing an entry", () => {
	clockAtNow();

	async function tracked(workPackageId: string) {
		await ask(grace, {
			intent: "track",
			projectId: site,
			day: "2026-11-10",
			start: "09:00",
			hours: "1",
			workPackageId,
		});
		const [entry] = await entries();
		if (!entry) throw new Error("not tracked");
		return {
			intent: "edit",
			entryId: entry.id,
			projectId: site,
			date: "2026-11-10",
			start: "09:00",
			end: "10:00",
		};
	}

	it("names an open work package of the project, or keeps its own", async () => {
		const edit = await tracked(wp1);
		expect((await ask(grace, { ...edit, workPackageId: "" })).status).toBe(400);
		expect((await ask(grace, { ...edit, workPackageId: otherWp })).status).toBe(400);
		// Left out, it keeps its own.
		expect((await ask(grace, { ...edit, description: "Kept" })).status).toBe(200);
		expect((await ask(grace, { ...edit, workPackageId: wp2 })).status).toBe(200);
		expect((await entries())[0]?.work_package_id).toBe(wp2);
		// Moved to a project with none, it has none.
		expect((await ask(grace, { ...edit, projectId: other, workPackageId: otherWp })).status).toBe(
			200,
		);
		expect((await entries())[0]).toMatchObject({ project_id: other, work_package_id: otherWp });
	});

	it("keeps time on a closed work package, changeable so long as it adds none", async () => {
		const edit = { ...(await tracked(wp1)), workPackageId: wp1, description: "Notes" };
		await setWorkPackageState(scope, ada.user.id, site, wp1, "closed");
		expect((await ask(grace, { ...edit, description: "Notes" })).status).toBe(200);
		expect((await ask(grace, { ...edit, end: "09:30" })).status).toBe(200);
		expect((await ask(grace, { ...edit, end: "11:00" })).status).toBe(409);
		expect((await entries())[0]).toMatchObject({ work_package_id: wp1, description: "Notes" });
		// Another entry may not move onto it.
		await ask(grace, {
			intent: "track",
			projectId: site,
			day: "2026-11-10",
			start: "13:00",
			hours: "1",
			workPackageId: wp2,
		});
		const moved = (await entries())[1];
		expect(
			(
				await ask(grace, {
					intent: "edit",
					entryId: moved?.id ?? "",
					projectId: site,
					date: "2026-11-10",
					start: "13:00",
					end: "14:00",
					workPackageId: wp1,
				})
			).status,
		).toBe(409);
	});

	it("leaves entries from before a project had work packages as they are", async () => {
		const old = await seedEntry(acme.id, grace.user.id, other, NOW - 3 * HOUR, NOW - 2 * HOUR);
		const fresh = await made(other, "OX2", "Later");
		expect(fresh).toBeTruthy();
		expect(await value("select work_package_id from time_entries where id = ?", old)).toBeNull();
		expect(await value("select count(*) from time_entries where work_package_id is not null")).toBe(
			0,
		);
	});
});

describe("copy and undo", () => {
	clockAtNow();

	it("copies a day onto the same work packages, and nothing onto a closed one", async () => {
		await ask(grace, {
			intent: "track",
			projectId: site,
			day: "2026-11-09",
			start: "09:00",
			hours: "1",
			workPackageId: wp1,
		});
		await setWorkPackageState(scope, ada.user.id, site, wp1, "closed");
		const refused = await ask(grace, { intent: "copy-day", day: "2026-11-10" });
		expect(refused.status).not.toBe(200);
		expect(await entries()).toHaveLength(1);
		await setWorkPackageState(scope, ada.user.id, site, wp1, "open");
		expect((await ask(grace, { intent: "copy-day", day: "2026-11-10" })).status).toBe(200);
		expect((await entries()).map((e) => e.work_package_id)).toEqual([wp1, wp1]);
	});

	it("puts a deleted entry back on its work package, while it takes time", async () => {
		await ask(grace, {
			intent: "track",
			projectId: site,
			day: "2026-11-10",
			start: "09:00",
			hours: "1",
			workPackageId: wp2,
		});
		const [entry] = await entries();
		const deleted = await ask(grace, { intent: "delete", entryId: entry?.id ?? "" });
		const token = /[A-Za-z0-9_-]{20,}\.[0-9a-f]{64}/.exec(deleted.said)?.[0] ?? "";
		await setWorkPackageState(scope, ada.user.id, site, wp2, "closed");
		expect((await ask(grace, { intent: "undo", token })).status).toBe(409);
		await setWorkPackageState(scope, ada.user.id, site, wp2, "open");
		expect((await ask(grace, { intent: "undo", token })).status).toBe(200);
		expect(await entries()).toEqual([
			expect.objectContaining({ id: entry?.id, work_package_id: wp2 }),
		]);
	});
});

function api(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
	return exports.default.fetch(
		new Request(`${ORIGIN}/api/v1${path}`, {
			method: init.method ?? "GET",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		}),
	);
}

describe("the API", () => {
	it("lists work packages, hiding a budget in fees from those who do not see money", async () => {
		await env.DB.prepare(
			"update work_packages set budget_kind = 'fees', budget_amount = 500000 where id = ?",
		)
			.bind(wp2)
			.run();
		await env.DB.prepare(
			"update work_packages set budget_kind = 'hours', budget_amount = 600 where id = ?",
		)
			.bind(wp1)
			.run();
		const own = await makeToken(scope, ada.user.id, "Test", API_SCOPES);
		const theirs = await makeToken(organisationScope(env.DB, acme.id), grace.user.id, "Test", [
			"projects:read",
		]);
		type Listed = { id: string; code: string; budget: unknown; state: string }[];
		const asOwner = (
			(await (await api(`/work_packages?project_id=${site}`, own)).json()) as {
				data: Listed;
			}
		).data;
		expect(asOwner.map((wp) => wp.code)).toEqual(["WP1", "WP2"]);
		expect(asOwner[1]?.budget).toEqual({ kind: "fees", amount: 500000 });
		const asMember = ((await (await api("/work_packages", theirs)).json()) as { data: Listed })
			.data;
		expect(asMember).toHaveLength(3);
		expect(asMember.find((wp) => wp.id === wp2)?.budget).toBeNull();
		expect(asMember.find((wp) => wp.id === wp1)?.budget).toEqual({ kind: "hours", amount: 600 });
	});

	it("needs an open work package of the project on a new entry and keeps it on a change", async () => {
		const token = await makeToken(scope, grace.user.id, "Test", ["time:read", "time:write"]);
		const body = { project_id: site, spent_date: "2026-11-10", hours: 1 };
		const none = await api("/time_entries", token, { method: "POST", body });
		expect(none.status).toBe(422);
		expect(((await none.json()) as { error: { code: string } }).error.code).toBe(
			"work_package_required",
		);
		await setWorkPackageState(scope, ada.user.id, site, wp2, "closed");
		const closed = await api("/time_entries", token, {
			method: "POST",
			body: { ...body, work_package_id: wp2 },
		});
		expect(closed.status).toBe(409);
		const added = await api("/time_entries", token, {
			method: "POST",
			body: { ...body, work_package_id: wp1 },
		});
		expect(added.status).toBe(201);
		const entry = (await added.json()) as {
			id: string;
			work_package_id: string;
			work_package: unknown;
		};
		expect(entry.work_package_id).toBe(wp1);
		expect(entry.work_package).toEqual({ id: wp1, name: "Discovery", code: "WP1" });
		const changed = await api(`/time_entries/${entry.id}`, token, {
			method: "PATCH",
			body: { description: "Kept" },
		});
		expect(changed.status).toBe(200);
		expect(await value("select work_package_id from time_entries where id = ?", entry.id)).toBe(
			wp1,
		);
		const moved = await api(`/time_entries/${entry.id}`, token, {
			method: "PATCH",
			body: { work_package_id: otherWp },
		});
		expect(moved.status).toBe(422);
	});
});

describe("the CSV import", () => {
	const IMPORT = "/app/acme/integrations/import";

	async function upload(text: string) {
		const body = new FormData();
		body.set("intent", "upload");
		body.set("kind", "time");
		body.set("file", new File([text], "time.csv", { type: "text/csv" }));
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}${IMPORT}?kind=time`, {
				method: "POST",
				headers: { Origin: ORIGIN, Cookie: ada.cookie, "CF-Connecting-IP": ada.client },
				body,
				redirect: "manual",
			}),
		);
		expect(response.status).toBe(302);
		return response.headers.get("Location") ?? "";
	}

	it("finds a work package by its code within the row's project, and skips a row it cannot place", async () => {
		await setWorkPackageState(scope, ada.user.id, site, wp2, "closed");
		const csv = [
			"Date,Project,Work package code,Hours,Email",
			"2026-10-05,GLX-001,wp1,1,ada@example.com",
			"2026-10-06,GLX-001,,1,ada@example.com",
			"2026-10-07,GLX-001,OX1,1,ada@example.com",
			"2026-10-08,GLX-001,WP2,1,ada@example.com",
			"2026-10-09,Other,ox1,1,ada@example.com",
		].join("\r\n");
		const location = await upload(csv);
		const page = textOf(await (await open(location, ada)).text());
		expect(page).toContain(
			"No work package code: this project's time goes to one of its work packages.",
		);
		expect(page).toContain("This project has no work package with the code OX1.");
		expect(page).toContain("Work package WP2 is closed, so it takes no new time.");
		const id = new URL(location, ORIGIN).searchParams.get("import") ?? "";
		const imported = await submit(`${IMPORT}?kind=time`, { intent: "import", importId: id }, ada);
		expect(imported.status).toBe(302);
		const { results } = await env.DB.prepare(
			"select project_id, work_package_id from time_entries where import_id = ? order by spent_on",
		)
			.bind(id)
			.all<{ project_id: string; work_package_id: string }>();
		expect(results).toEqual([
			{ project_id: site, work_package_id: wp1 },
			{ project_id: other, work_package_id: otherWp },
		]);
	});
});

describe("budget progress and reports", () => {
	async function seedOn(
		workPackageId: string | null,
		projectId: string,
		from: number,
		minutes: number,
	) {
		const id = await seedEntry(acme.id, grace.user.id, projectId, from, from + minutes * 60_000);
		await env.DB.prepare("update time_entries set work_package_id = ?, billable = 1 where id = ?")
			.bind(workPackageId, id)
			.run();
	}

	beforeEach(async () => {
		const day = Date.parse("2026-11-02T09:00:00Z");
		for (let at = 0; at < 9; at++) {
			const wp = [wp1, wp2, null][at % 3] ?? null;
			await seedOn(wp, site, day + at * 24 * HOUR, 25 + at * 7);
		}
		await seedOn(otherWp, other, day, 61);
		await env.DB.prepare(
			"update work_packages set budget_kind = 'hours', budget_amount = 120 where id = ?",
		)
			.bind(wp1)
			.run();
	});

	it("shows each work package's progress as the sum of its entries", async () => {
		const packages = await scope.workPackages.select();
		const money = await organisationMoney(acme.id);
		const progress = await workPackageProgress(
			scope,
			site,
			packages.filter((wp) => wp.projectId === site),
			{ now: NOW, money, pricing: await pricingOf(scope, money.currency) },
		);
		for (const id of [wp1, wp2]) {
			const summed = await value<number>(
				"select sum((ended_at - started_at) / 60000) from time_entries where work_package_id = ?",
				id,
			);
			expect(progress.get(id)?.minutes).toBe(summed);
		}
		expect(progress.get(wp1)?.budget).toMatchObject({
			kind: "hours",
			amount: 120,
			status: { spent: progress.get(wp1)?.minutes },
		});
		expect(progress.get(wp2)?.budget).toBeNull();
	});

	it("totals a report by work package as its entries add up", async () => {
		const { sums } = await sumsOf({
			scope,
			days: { first: "2026-11-01", last: "2026-11-30" },
			people: { everyone: true },
			now: NOW,
		});
		const totals = totalsOf(sums, "work-package");
		const { results } = await env.DB.prepare(
			"select project_id, work_package_id, sum((ended_at - started_at) / 60000) as minutes from time_entries group by project_id, work_package_id",
		).all<{ project_id: string; work_package_id: string | null; minutes: number }>();
		expect(Object.fromEntries(totals.groups.map((group) => [group.key, group.minutes]))).toEqual(
			Object.fromEntries(results.map((r) => [lineKey(r.project_id, r.work_package_id), r.minutes])),
		);
		expect(totals.groups.find((g) => g.key === lineKey(site, wp1))?.label).toBe(
			"GLX-001 · Site › WP1 Discovery",
		);
		expect(totals.minutes).toBe(results.reduce((sum, r) => sum + r.minutes, 0));
	});

	it("exports each entry's work package code", async () => {
		const response = await open(
			"/app/acme/reports/export?range=custom&from=2026-11-01&to=2026-11-30",
			ada,
		);
		expect(response.status).toBe(200);
		const [header, ...lines] = (await response.text())
			.replace(/^\uFEFF/, "")
			.trim()
			.split("\r\n");
		expect(header).toBe(CSV_COLUMNS.join(","));
		const at = CSV_COLUMNS.indexOf("work_package_code");
		const codes = lines.map((line) => line.split(",")[at]);
		expect(codes.filter((code) => code === "WP1")).toHaveLength(3);
		expect(codes.filter((code) => code === "OX1")).toHaveLength(1);
		expect(codes.filter((code) => code === "")).toHaveLength(3);
	});
});

type Who =
	| "owner"
	| "admin"
	| "finance"
	| "account manager"
	| "other account manager"
	| "manager"
	| "member"
	| "contractor"
	| "stranger";

describe("who manages work packages", () => {
	async function as(who: Who): Promise<Person> {
		if (who === "owner") return ada;
		if (who === "member") return grace;
		const someone = await person(mailbox, `${who.replaceAll(" ", "-")}@example.com`);
		if (who === "stranger") return someone;
		await seedMembership(
			acme.id,
			someone.user.id,
			who === "admin" || who === "finance" ? who : "member",
		);
		if (who === "account manager" || who === "other account manager") {
			const clientId =
				who === "account manager"
					? globex
					: ((await scope.clients.insert({ name: "Umbrella", nameKey: "umbrella" }))[0]?.id ?? "");
			await scope.clientManagers.insert({ clientId, userId: someone.user.id });
		}
		if (who === "manager") await seedTeam(acme.id, "Design", { managers: [someone.user.id] });
		if (who === "contractor") {
			await env.DB.prepare("update memberships set is_contractor = 1 where user_id = ?")
				.bind(someone.user.id)
				.run();
		}
		return someone;
	}

	const tabPath = () => `/app/acme/projects/${site}?tab=work-packages`;

	it.each<[Who, number]>([
		["owner", 200],
		["admin", 200],
		["account manager", 200],
		["finance", 403],
		["other account manager", 403],
		["manager", 403],
		["member", 403],
		["contractor", 403],
		["stranger", 404],
	])("answers a %s adding, closing and archiving one with %i", async (who, status) => {
		const them = await as(who);
		const add = await submit(
			tabPath(),
			{ intent: "wp-save", code: "WP9", name: "Support", billable: "on" },
			them,
			{ byScript: true },
		);
		expect(add.status).toBe(status);
		expect(await value("select count(*) from work_packages where code = 'WP9'")).toBe(
			status === 200 ? 1 : 0,
		);
		const close = await submit(
			tabPath(),
			{ intent: "wp-state", workPackageId: wp1, state: "closed" },
			them,
			{ byScript: true },
		);
		expect(close.status).toBe(status);
		expect(await value("select state from work_packages where id = ?", wp1)).toBe(
			status === 200 ? "closed" : "open",
		);
		const archive = await submit(
			tabPath(),
			{ intent: "wp-archive", workPackageId: wp2, archived: "true" },
			them,
			{ byScript: true },
		);
		expect(archive.status).toBe(status);
	});

	it("lists work packages to every member, with Add for those who manage them alone", async () => {
		const page = async (who: Person) => {
			const response = await open(tabPath(), who);
			expect(response.status).toBe(200);
			return textOf((await pageBody(response)).match(/<main[\s\S]*<\/main>/)?.[0] ?? "");
		};
		expect(await page(ada)).toContain("Add a work package");
		const asMember = await page(grace);
		expect(asMember).toContain("WP1 Discovery");
		expect(asMember).not.toContain("Add a work package");
		expect(await page(await as("account manager"))).toContain("Add a work package");
	});

	it("refuses a second code of the project in any case, and an end before the start", async () => {
		const save = (fields: Record<string, string>) =>
			submit(tabPath(), { intent: "wp-save", name: "Again", ...fields }, ada, { byScript: true });
		expect((await save({ code: "wp2" })).status).toBe(409);
		expect((await save({ code: "WP3", startsOn: "2026-11-10", endsOn: "2026-11-01" })).status).toBe(
			409,
		);
		expect((await save({ code: "WP3", budgetKind: "hours", budgetAmount: "37.5" })).status).toBe(
			200,
		);
		expect(
			await row("select budget_kind, budget_amount from work_packages where code = 'WP3'"),
		).toEqual({
			budget_kind: "hours",
			budget_amount: 2250,
		});
	});

	it("keeps a budget in fees from a manager of work packages who does not see money", async () => {
		const manager = await as("account manager");
		await env.DB.prepare(
			"update work_packages set budget_kind = 'fees', budget_amount = 100000 where id = ?",
		)
			.bind(wp1)
			.run();
		const edit = (fields: Record<string, string>) =>
			submit(
				tabPath(),
				{ intent: "wp-save", workPackageId: wp1, code: "WP1", name: "Renamed", ...fields },
				manager,
				{ byScript: true },
			);
		expect((await edit({ budgetKind: "none" })).status).toBe(403);
		expect((await edit({})).status).toBe(200);
		expect(
			await row("select name, budget_kind, budget_amount from work_packages where id = ?", wp1),
		).toEqual({
			name: "Renamed",
			budget_kind: "fees",
			budget_amount: 100000,
		});
	});
});
