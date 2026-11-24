import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { NEW_PROJECT_NO_TEAM, NOT_ON_TEAM } from "~/import/import.server";
import { makeToken } from "~/integrations/api-tokens.server";
import {
	JOIN_INTENT,
	NAMES_LEADS_ONLY,
	NOT_JOINABLE,
	type ProjectTracking,
	TEAM_PROBLEMS,
	TEAM_REFUSAL,
	type TeamRole,
} from "~/projects/teams";
import { assignToTeam, changeStretch } from "~/projects/teams.server";
import type { Day } from "~/time/calendar";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, row, seedMembership, seedTeam, value } from "../organisations/harness";
import { open, openData, type Person, person, submit, textOf } from "../pages/harness";
import { seedEntry, seedProject } from "../pages/periods-seed";

// Project teams and assigned-only tracking (TS-115c, docs/decisions.md entry
// 75). A project's team is its people's stretches, from a day to a day or on,
// never two of one person on one project sharing a day. Where the
// organisation's `project_tracking` is `assigned`, time on a day goes to a
// project only from a person on its team that day, on every path an entry is
// written by; where it is `anyone`, as every organisation was before, it goes
// as it did. Owners, admins and the project's delivery managers add
// themselves in one step; nobody else is let in, and nobody silently.

const TIMESHEET = "/app/acme?index";
const HOUR = 3_600_000;
/** Wednesday 11 November 2026, 15:00 in London: the server's clock. */
const NOW = Date.parse("2026-11-11T15:00:00Z");
const TODAY = "2026-11-11";
const YESTERDAY = "2026-11-10";

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
	await env.DB.prepare(
		"update projects set client_id = ?, code = 'GLX-001', code_key = 'glx-001' where id = ?",
	)
		.bind(globex, site)
		.run();
	other = await seedProject(acme.id, "Other");
	clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function tracking(to: ProjectTracking) {
	await env.DB.prepare("update organisations set project_tracking = ? where id = ?")
		.bind(to, acme.id)
		.run();
}

/** Puts `userId` on `projectId`'s team, as an owner would. */
async function assign(
	userId: string,
	projectId: string,
	startsOn: Day,
	endsOn: Day | null = null,
	role: TeamRole = "member",
): Promise<string> {
	const made = await assignToTeam(
		scope,
		{ userId: ada.user.id },
		{ projectId, userId, role, startsOn, endsOn },
	);
	if (!made?.ok) throw new Error(`not assigned: ${JSON.stringify(made)}`);
	return made.id;
}

async function ask(who: Person, fields: Record<string, string>) {
	const response = await submit(TIMESHEET, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

/** `userId`'s entries, oldest first. */
async function entriesOf(userId: string) {
	const { results } = await env.DB.prepare(
		"select id, project_id, spent_on, started_at, ended_at, description from time_entries where user_id = ? order by started_at",
	)
		.bind(userId)
		.all<{
			id: string;
			project_id: string;
			spent_on: string;
			started_at: number;
			ended_at: number | null;
			description: string | null;
		}>();
	return results;
}

function api(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
	return exports.default.fetch(
		new Request(`${ORIGIN}/api/v1${path}`, {
			method: init.method ?? "GET",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		}),
	);
}

type Who =
	| "owner"
	| "admin"
	| "finance"
	| "account manager"
	| "other account manager"
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
	if (who === "account manager" || who === "other account manager") {
		const clientId =
			who === "account manager"
				? globex
				: ((await scope.clients.insert({ name: "Umbrella", nameKey: "umbrella" }))[0]?.id ?? "");
		await scope.clientManagers.insert({ clientId, userId: someone.user.id });
	}
	if (who === "delivery manager") {
		await assign(someone.user.id, site, "2026-11-01", null, "delivery_manager");
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

describe("an organisation from before", () => {
	it("tracks as anyone, as every organisation did", async () => {
		expect(await value("select project_tracking from organisations where id = ?", acme.id)).toBe(
			"anyone",
		);
		const column = await row<{ dflt_value: string; notnull: number }>(
			"select dflt_value, \"notnull\" from pragma_table_info('organisations') where name = 'project_tracking'",
		);
		expect(column).toEqual({ dflt_value: "'anyone'", notnull: 1 });
		// Nobody is on any team, and every path takes time as before.
		const track = { intent: "track", projectId: site, day: YESTERDAY, hours: "1" };
		expect((await ask(grace, track)).status).toBe(200);
		expect((await ask(grace, { ...track, start: "13:00" })).status).toBe(200);
		expect(
			(await ask(grace, { intent: "cell", projectId: other, day: YESTERDAY, hours: "2" })).status,
		).toBe(200);
		expect((await ask(grace, { intent: "track", projectId: site, day: TODAY })).status).toBe(200);
		expect(await entriesOf(grace.user.id)).toHaveLength(4);
	});
});

describe("each path an entry is written by", () => {
	const refused = (answer: { status: number; said: string }) => {
		expect(answer.status).toBe(403);
		expect(answer.said).toContain(TEAM_REFUSAL);
	};

	describe.each<[string, Record<string, string>]>([
		["tracking hours", { intent: "track", projectId: "SITE", day: YESTERDAY, hours: "1" }],
		[
			"a calendar slot",
			{ intent: "track", projectId: "SITE", day: YESTERDAY, start: "09:00", hours: "1" },
		],
		["the timer", { intent: "track", projectId: "SITE", day: TODAY }],
		["a cell of the Week grid", { intent: "cell", projectId: "SITE", day: YESTERDAY, hours: "2" }],
	])("%s", (_path, given) => {
		const fields = () => ({ ...given, projectId: site });

		it("takes time from anyone where anyone tracks", async () => {
			expect((await ask(grace, fields())).status).toBe(200);
			expect(await entriesOf(grace.user.id)).toHaveLength(1);
		});

		it("takes time only from the team on its day where tracking is by assignment, owners too", async () => {
			await tracking("assigned");
			refused(await ask(grace, fields()));
			refused(await ask(ada, fields()));
			// A stretch that starts after the day does not cover it.
			await assign(grace.user.id, site, "2026-11-12");
			refused(await ask(grace, fields()));
			expect(await entriesOf(grace.user.id)).toEqual([]);
			await assign(grace.user.id, site, "2026-11-01", "2026-11-11");
			expect((await ask(grace, fields())).status).toBe(200);
			expect(await entriesOf(grace.user.id)).toHaveLength(1);
		});
	});

	describe("changing an entry", () => {
		async function tracked() {
			await assign(grace.user.id, site, "2026-11-01");
			const answer = await ask(grace, {
				intent: "track",
				projectId: site,
				day: YESTERDAY,
				start: "09:00",
				hours: "1",
			});
			expect(answer.status).toBe(200);
			const [entry] = await entriesOf(grace.user.id);
			if (!entry) throw new Error("not tracked");
			return {
				intent: "edit",
				entryId: entry.id,
				projectId: site,
				date: YESTERDAY,
				start: "09:00",
				end: "10:00",
			};
		}

		it("moves anywhere where anyone tracks", async () => {
			const edit = await tracked();
			expect((await ask(grace, { ...edit, projectId: other, end: "11:00" })).status).toBe(200);
		});

		it("adds time, moves day or project only onto the team, and is otherwise let be", async () => {
			const edit = await tracked();
			await tracking("assigned");
			const [stretch] = await scope.projectMembers.select();
			// Her stretch ends two days before: the entry stays hers to correct and trim.
			await changeStretch(scope, { userId: ada.user.id }, site, stretch?.id ?? "", {
				endsOn: "2026-11-08",
			});
			expect((await ask(grace, { ...edit, description: "Corrected" })).status).toBe(200);
			expect((await ask(grace, { ...edit, description: "Corrected", end: "09:30" })).status).toBe(
				200,
			);
			refused(await ask(grace, { ...edit, end: "11:00" }));
			refused(await ask(grace, { ...edit, projectId: other }));
			refused(await ask(grace, { ...edit, date: "2026-11-09", end: "09:30" }));
			expect(await entriesOf(grace.user.id)).toEqual([
				expect.objectContaining({
					project_id: site,
					spent_on: YESTERDAY,
					description: "Corrected",
				}),
			]);
		});
	});

	it("puts a deleted entry back only while its project's team takes it", async () => {
		await tracking("assigned");
		const stretch = await assign(grace.user.id, site, "2026-11-01");
		await ask(grace, {
			intent: "track",
			projectId: site,
			day: YESTERDAY,
			start: "09:00",
			hours: "1",
		});
		const [entry] = await entriesOf(grace.user.id);
		const deleted = await ask(grace, { intent: "delete", entryId: entry?.id ?? "" });
		const token = /[A-Za-z0-9_-]{20,}\.[0-9a-f]{64}/.exec(deleted.said)?.[0] ?? "";
		await changeStretch(scope, { userId: ada.user.id }, site, stretch, { endsOn: "2026-11-09" });
		refused(await ask(grace, { intent: "undo", token }));
		await changeStretch(scope, { userId: ada.user.id }, site, stretch, { endsOn: null });
		expect((await ask(grace, { intent: "undo", token })).status).toBe(200);
		expect(await entriesOf(grace.user.id)).toEqual([expect.objectContaining({ id: entry?.id })]);
	});

	it("is the API's too: a new entry, and a change that adds time", async () => {
		const token = await makeToken(scope, grace.user.id, "Test", ["time:read", "time:write"]);
		const body = { project_id: site, spent_date: YESTERDAY, hours: 1 };
		expect((await api("/time_entries", token, { method: "POST", body })).status).toBe(201);
		await tracking("assigned");
		const off = await api("/time_entries", token, { method: "POST", body });
		expect(off.status).toBe(403);
		expect(await off.json()).toMatchObject({
			error: { code: "not_assigned", message: TEAM_REFUSAL },
		});
		const stretch = await assign(grace.user.id, site, "2026-11-01");
		const added = await api("/time_entries", token, { method: "POST", body });
		expect(added.status).toBe(201);
		const { id } = (await added.json()) as { id: string };
		await changeStretch(scope, { userId: ada.user.id }, site, stretch, { endsOn: "2026-11-09" });
		const kept = await api(`/time_entries/${id}`, token, {
			method: "PATCH",
			body: { description: "Kept" },
		});
		expect(kept.status).toBe(200);
		const longer = await api(`/time_entries/${id}`, token, { method: "PATCH", body: { hours: 3 } });
		expect(longer.status).toBe(403);
	});

	it.each<Who>(["admin", "finance", "line manager", "contractor", "delivery manager"])(
		"holds a %s to it as anyone else",
		async (who) => {
			const them = await as(who);
			await tracking("assigned");
			const track = { intent: "track", projectId: other, day: YESTERDAY, hours: "1" };
			refused(await ask(them, track));
			await assign(them.user.id, other, YESTERDAY, YESTERDAY);
			expect((await ask(them, track)).status).toBe(200);
		},
	);
});

describe("a stretch on a team", () => {
	it("covers its first and last days and none outside them", async () => {
		await tracking("assigned");
		await assign(grace.user.id, site, "2026-11-05", "2026-11-09");
		const on = async (day: string) =>
			(await ask(grace, { intent: "track", projectId: site, day, hours: "1" })).status;
		expect(await on("2026-11-04")).toBe(403);
		expect(await on("2026-11-05")).toBe(200);
		expect(await on("2026-11-09")).toBe(200);
		expect(await on("2026-11-10")).toBe(403);
	});

	it("never shares a day with another of the same person on the same project, whoever writes it", async () => {
		await assign(grace.user.id, site, "2026-11-01", "2026-11-09");
		const overlapping = await assignToTeam(
			scope,
			{ userId: ada.user.id },
			{
				projectId: site,
				userId: grace.user.id,
				role: "member",
				startsOn: "2026-11-09",
				endsOn: null,
			},
		);
		expect(overlapping).toEqual({ ok: false, problem: "overlaps" });
		// The next day is free, and another project or person is never in the way.
		await assign(grace.user.id, site, "2026-11-10");
		await assign(grace.user.id, other, "2026-11-01");
		await assign(ada.user.id, site, "2026-11-01");
		const insert = env.DB.prepare(
			"insert into project_members (id, organisation_id, project_id, user_id, starts_on, ends_on, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 0, 0)",
		);
		await expect(
			insert.bind("raw1", acme.id, site, grace.user.id, "2026-12-01", null).run(),
		).rejects.toThrow(/never overlap/);
		await expect(
			insert.bind("raw2", acme.id, site, grace.user.id, "2026-10-01", "2026-11-01").run(),
		).rejects.toThrow(/never overlap/);
		await insert.bind("raw3", acme.id, site, grace.user.id, "2026-10-01", "2026-10-31").run();
		await expect(
			env.DB.prepare("update project_members set ends_on = '2026-11-03' where id = 'raw3'").run(),
		).rejects.toThrow(/never overlap/);
		await expect(
			env.DB.prepare("update project_members set ends_on = '2026-10-01' where id = 'raw3'").run(),
		).resolves.toBeTruthy();
		await expect(
			insert.bind("raw4", acme.id, site, grace.user.id, "2026-09-10", "2026-09-01").run(),
		).rejects.toThrow(/CHECK/);
		expect(
			await value("select count(*) from project_members where user_id = ?", grace.user.id),
		).toBe(4);
	});
});

describe("adding yourself from the picker", () => {
	const join = (who: Person, projectId = site, day = YESTERDAY) =>
		ask(who, { intent: JOIN_INTENT, projectId, day });

	it.each<[Who, number]>([
		["owner", 200],
		["admin", 200],
		["delivery manager", 200],
		["finance", 403],
		["account manager", 403],
		["line manager", 403],
		["member", 403],
		["contractor", 403],
		["stranger", 404],
	])("lets a %s in with %i", async (who, status) => {
		await tracking("assigned");
		const them = await as(who);
		// The delivery manager's own stretch ends before the day joined, so the
		// day needs one of its own.
		if (who === "delivery manager") {
			const [lead] = await scope.projectMembers.select();
			await env.DB.prepare(
				"update project_members set starts_on = '2026-11-11', ends_on = null where id = ?",
			)
				.bind(lead?.id ?? "")
				.run();
		}
		const before = await value("select count(*) from project_members");
		const answer = await join(them);
		expect(answer.status).toBe(status);
		if (status === 403) expect(answer.said).toContain(NOT_JOINABLE);
		expect(await value("select count(*) from project_members")).toBe(
			Number(before) + (status === 200 ? 1 : 0),
		);
		if (status !== 200) return;
		expect(
			await row(
				"select role, starts_on, ends_on, created_by from project_members where user_id = ? and starts_on = ?",
				them.user.id,
				YESTERDAY,
			),
		).toEqual({
			role: who === "delivery manager" ? "delivery_manager" : "member",
			starts_on: YESTERDAY,
			// The delivery manager's stretch from today follows; this one runs to it.
			ends_on: who === "delivery manager" ? YESTERDAY : null,
			created_by: them.user.id,
		});
		// It is recorded as their own doing, and the time then goes in.
		expect(
			await value(
				"select count(*) from activity_records where action = 'project.member_added' and actor_id = ?",
				them.user.id,
			),
		).toBe(1);
		expect(
			(await ask(them, { intent: "track", projectId: site, day: YESTERDAY, hours: "1" })).status,
		).toBe(200);
	});

	it("is not a delivery manager's once their stretch as one has ended", async () => {
		await tracking("assigned");
		const lead = await as("delivery manager");
		const [stretch] = await scope.projectMembers.select();
		await changeStretch(scope, { userId: ada.user.id }, site, stretch?.id ?? "", {
			endsOn: "2026-11-05",
		});
		const answer = await join(lead);
		expect(answer.status).toBe(403);
		expect(answer.said).toContain(NOT_JOINABLE);
	});

	it("adds nothing for someone already on the team that day, and refuses an archived project", async () => {
		await tracking("assigned");
		await assign(ada.user.id, site, "2026-11-01");
		expect((await join(ada)).status).toBe(200);
		expect(await value("select count(*) from project_members")).toBe(1);
		await env.DB.prepare("update projects set archived_at = 1 where id = ?").bind(other).run();
		expect((await join(ada, other)).status).toBe(400);
	});
});

describe("who manages a project's team", () => {
	const tabPath = () => `/app/acme/projects/${site}?tab=team`;
	const send = (who: Person, fields: Record<string, string>) =>
		submit(tabPath(), fields, who, { byScript: true });

	it.each<[Who, number]>([
		["owner", 200],
		["admin", 200],
		["account manager", 200],
		["delivery manager", 200],
		["finance", 403],
		["other account manager", 403],
		["line manager", 403],
		["member", 403],
		["contractor", 403],
		["stranger", 404],
	])("answers a %s assigning, ending, changing and removing with %i", async (who, status) => {
		const them = await as(who);
		const managed = status === 200;
		const assigned = await send(them, {
			intent: "team-assign",
			userId: grace.user.id,
			role: "member",
			startsOn: "2026-11-02",
		});
		expect(assigned.status).toBe(status);
		const stretch = managed
			? String(
					await value(
						"select id from project_members where user_id = ? and project_id = ?",
						grace.user.id,
						site,
					),
				)
			: await assign(grace.user.id, site, "2026-11-02");
		const ended = await send(them, {
			intent: "team-end",
			stretchId: stretch,
			endsOn: "2026-11-30",
		});
		expect(ended.status).toBe(status);
		expect(await value("select ends_on from project_members where id = ?", stretch)).toBe(
			managed ? "2026-11-30" : null,
		);
		const split = await send(them, {
			intent: "team-role",
			stretchId: stretch,
			role: "member",
			from: "2026-11-20",
		});
		expect(split.status).toBe(status);
		const removed = await send(them, { intent: "team-remove", stretchId: stretch });
		expect(removed.status).toBe(status);
		expect(await value("select count(*) from project_members where id = ?", stretch)).toBe(
			managed ? 0 : 1,
		);
	});

	it("leaves naming a delivery manager to owners, admins and the client's account managers", async () => {
		const lead = await as("delivery manager");
		const manager = await as("account manager");
		const name = (who: Person) =>
			send(who, {
				intent: "team-assign",
				userId: grace.user.id,
				role: "delivery_manager",
				startsOn: "2026-11-02",
			});
		const refused = await name(lead);
		expect(refused.status).toBe(403);
		expect(await refused.text()).toContain(NAMES_LEADS_ONLY);
		// Nor do they end or change a delivery manager's stretch, their own too.
		const own = String(
			await value("select id from project_members where user_id = ?", lead.user.id),
		);
		expect(
			(await send(lead, { intent: "team-end", stretchId: own, endsOn: "2026-11-30" })).status,
		).toBe(403);
		expect(
			(await send(lead, { intent: "team-role", stretchId: own, role: "member", from: TODAY }))
				.status,
		).toBe(403);
		expect((await name(manager)).status).toBe(200);
		expect(await value("select role from project_members where user_id = ?", grace.user.id)).toBe(
			"delivery_manager",
		);
	});

	it("splits a stretch where its role changes from a day, and records each change", async () => {
		const stretch = await assign(grace.user.id, site, "2026-11-02", "2026-11-30");
		expect(
			(
				await send(ada, {
					intent: "team-role",
					stretchId: stretch,
					role: "delivery_manager",
					from: "2026-11-16",
				})
			).status,
		).toBe(200);
		const { results } = await env.DB.prepare(
			"select role, starts_on, ends_on from project_members where user_id = ? order by starts_on",
		)
			.bind(grace.user.id)
			.all();
		expect(results).toEqual([
			{ role: "member", starts_on: "2026-11-02", ends_on: "2026-11-15" },
			{ role: "delivery_manager", starts_on: "2026-11-16", ends_on: "2026-11-30" },
		]);
		expect(
			await value(
				"select count(*) from activity_records where subject_type = 'project' and subject_id = ? and action like 'project.member_%'",
				site,
			),
		).toBe(3);
	});

	it("refuses an overlap, an end before the start, and removing a stretch with time", async () => {
		const stretch = await assign(grace.user.id, site, "2026-11-02");
		const again = await send(ada, {
			intent: "team-assign",
			userId: grace.user.id,
			role: "member",
			startsOn: "2026-11-20",
		});
		expect(again.status).toBe(400);
		expect(await again.text()).toContain(TEAM_PROBLEMS.overlaps);
		const early = await send(ada, { intent: "team-end", stretchId: stretch, endsOn: "2026-11-01" });
		expect(await early.text()).toContain(TEAM_PROBLEMS["ends-before-start"]);
		await seedEntry(acme.id, grace.user.id, site, NOW - 26 * HOUR, NOW - 25 * HOUR);
		const removed = await send(ada, { intent: "team-remove", stretchId: stretch });
		expect(await removed.text()).toContain(TEAM_PROBLEMS["has-time"]);
		expect(await value("select count(*) from project_members")).toBe(1);
		// Someone who is not a member of the organisation is not assigned.
		const outsider = await as("stranger");
		const theirs = await send(ada, {
			intent: "team-assign",
			userId: outsider.user.id,
			role: "member",
			startsOn: "2026-11-02",
		});
		expect(await theirs.text()).toContain(TEAM_PROBLEMS["not-member"]);
	});
});

describe("the Team tab", () => {
	const data = async (who: Person) => {
		const response = await openData(`/app/acme/projects/${site}?tab=team`, who);
		return { status: response.status, text: await response.text() };
	};

	it.each<[Who, "all" | "own" | 404]>([
		["owner", "all"],
		["admin", "all"],
		["finance", "all"],
		["account manager", "all"],
		["delivery manager", "all"],
		["line manager", "all"],
		["other account manager", "own"],
		["member", "own"],
		["contractor", "own"],
		["stranger", 404],
	])("shows a %s the team: %s", async (who, sees) => {
		const them = await as(who);
		const hers = await assign(grace.user.id, site, "2026-11-02");
		const theirs =
			who === "stranger" || who === "member"
				? null
				: await assign(them.user.id, site, "2026-10-01", "2026-10-31");
		const shown = await data(them);
		if (sees === 404) {
			expect(shown.status).toBe(404);
			return;
		}
		expect(shown.status).toBe(200);
		if (sees === "all") expect(shown.text).toContain(hers);
		else if (who === "member") expect(shown.text).toContain(hers);
		else expect(shown.text).not.toContain(hers);
		if (theirs) expect(shown.text).toContain(theirs);
	});
});

describe("copying time forward", () => {
	async function lastWeek() {
		// Monday 9 November: an hour on each project.
		await ask(grace, {
			intent: "track",
			projectId: site,
			day: "2026-11-09",
			start: "09:00",
			hours: "1",
		});
		await ask(grace, {
			intent: "track",
			projectId: other,
			day: "2026-11-09",
			start: "11:00",
			hours: "1",
		});
		expect(await entriesOf(grace.user.id)).toHaveLength(2);
	}

	it("copies everything where anyone tracks", async () => {
		await lastWeek();
		expect((await ask(grace, { intent: "copy-day", day: YESTERDAY })).status).toBe(200);
		expect((await entriesOf(grace.user.id)).filter((e) => e.spent_on === YESTERDAY)).toHaveLength(
			2,
		);
	});

	it("copies a day's entries only onto the teams that have the person, and says what it left", async () => {
		await assign(grace.user.id, site, "2026-11-01");
		await assign(grace.user.id, other, "2026-11-01", "2026-11-09");
		await lastWeek();
		await tracking("assigned");
		const copied = await ask(grace, { intent: "copy-day", day: YESTERDAY });
		expect(copied.status).toBe(200);
		expect(copied.said).toContain("Copied 1 entry");
		expect(copied.said).toContain(
			"1 entry was left out: you are not on its project's team on that day.",
		);
		expect(
			(await entriesOf(grace.user.id))
				.filter((e) => e.spent_on === YESTERDAY)
				.map((e) => e.project_id),
		).toEqual([site]);
	});

	it("copies nothing onto a day no entry's team has the person", async () => {
		await assign(grace.user.id, site, "2026-11-01", "2026-11-09");
		await assign(grace.user.id, other, "2026-11-01", "2026-11-09");
		await lastWeek();
		await tracking("assigned");
		const copied = await ask(grace, { intent: "copy-day", day: YESTERDAY });
		expect(copied.status).toBe(409);
		expect(copied.said).toContain("You are not on those entries' projects' teams on that day");
		expect(await entriesOf(grace.user.id)).toHaveLength(2);
	});

	it("names each day of a week it left an entry out of", async () => {
		await assign(grace.user.id, site, "2026-11-01");
		await assign(grace.user.id, other, "2026-11-01", "2026-11-08");
		// Monday 2 November, the week before.
		await ask(grace, {
			intent: "track",
			projectId: site,
			day: "2026-11-02",
			start: "09:00",
			hours: "1",
		});
		await ask(grace, {
			intent: "track",
			projectId: other,
			day: "2026-11-02",
			start: "11:00",
			hours: "1",
		});
		await tracking("assigned");
		const copied = await ask(grace, { intent: "copy-week", startsOn: "2026-11-09" });
		expect(copied.status).toBe(200);
		expect(copied.said).toContain(
			"1 entry was left out: you are not on its project's team on Mon 9.",
		);
		expect(
			(await entriesOf(grace.user.id))
				.filter((e) => e.spent_on === "2026-11-09")
				.map((e) => e.project_id),
		).toEqual([site]);
	});
});

describe("the CSV time import", () => {
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

	const CSV = [
		"Date,Project,Hours,Email",
		"2026-10-05,GLX-001,1,grace@example.com",
		"2026-10-20,GLX-001,1,grace@example.com",
		"2026-10-06,Other,1,ada@example.com",
		"2026-10-07,Brand new,1,grace@example.com",
	].join("\r\n");

	async function imported(location: string) {
		const id = new URL(location, ORIGIN).searchParams.get("import") ?? "";
		const done = await submit(`${IMPORT}?kind=time`, { intent: "import", importId: id }, ada);
		expect(done.status).toBe(302);
		const { results } = await env.DB.prepare(
			"select user_id, project_id, spent_on from time_entries where import_id = ? order by spent_on",
		)
			.bind(id)
			.all<{ user_id: string; project_id: string; spent_on: string }>();
		return results;
	}

	it("imports every row where anyone tracks", async () => {
		expect(await imported(await upload(CSV))).toHaveLength(4);
	});

	it("skips a row whose person is not on its project's team on its day, and one on a project it adds", async () => {
		await tracking("assigned");
		await assign(grace.user.id, site, "2026-10-01", "2026-10-15");
		const location = await upload(CSV);
		const page = textOf(await (await open(location, ada)).text());
		expect(page).toContain(NOT_ON_TEAM);
		expect(page).toContain(NEW_PROJECT_NO_TEAM);
		// Joined between the preview and the import, the owner is let in: the import works it out again.
		await assign(ada.user.id, other, "2026-10-01");
		expect(await imported(location)).toEqual([
			{ user_id: grace.user.id, project_id: site, spent_on: "2026-10-05" },
			{ user_id: ada.user.id, project_id: other, spent_on: "2026-10-06" },
		]);
		expect(await value("select count(*) from projects where name = 'Brand new'")).toBe(0);
	});
});
