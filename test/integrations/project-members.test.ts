import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { makeToken } from "~/integrations/api-tokens.server";
import { API_SCOPES, type ApiScope } from "~/integrations/scopes";
import { NAMES_LEADS_ONLY, type TeamRole } from "~/projects/teams";
import { assignToTeam } from "~/projects/teams.server";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, seedTeam } from "../organisations/harness";
import { type Person, person } from "../pages/harness";
import { seedEntry, seedProject } from "../pages/periods-seed";

// The API's project members (TS-115c, docs/decisions.md entry 75): the
// stretches of people on projects' teams, read with projects:read and written
// with projects:write. Each role sees and changes a team as the project's Team
// tab lets it: the whole team to owners, admins, Finance, managers of teams,
// the client's account managers and the project's delivery managers, anyone
// else their own stretches; owners, admins, account managers and delivery
// managers assign people, and only the first three name a delivery manager.

let mailbox: Mailbox;
let scope: OrganisationScope;
let acme: { id: string };
let ada: Person;
let alan: Person;
let fay: Person;
let amy: Person;
let dee: Person;
let lin: Person;
let mem: Person;
let con: Person;
let apollo: string;
let zeus: string;
/** The stretches set up: the delivery manager's, the member's and the contractor's on Apollo, the member's on Zeus. */
let stretches: { dee: string; mem: string; con: string; memZeus: string };

/** A person of `role` in Acme named `name`. */
async function memberOfAcme(role: Role, email: string, name: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	await env.DB.prepare("update users set name = ? where id = ?").bind(name, who.user.id).run();
	return who;
}

async function assigned(projectId: string, who: Person, role: TeamRole, startsOn: string) {
	const change = await assignToTeam(
		scope,
		{ userId: ada.user.id },
		{ projectId, userId: who.user.id, role, startsOn, endsOn: null },
	);
	if (!change?.ok) throw new Error("seed failed");
	return change.id;
}

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	scope = organisationScope(env.DB, acme.id);
	alan = await memberOfAcme("admin", "alan@example.com", "Alan Admin");
	fay = await memberOfAcme("finance", "fay@example.com", "Fay Finance");
	amy = await memberOfAcme("member", "amy@example.com", "Amy Account");
	dee = await memberOfAcme("member", "dee@example.com", "Dee Delivery");
	lin = await memberOfAcme("member", "lin@example.com", "Lin Line");
	mem = await memberOfAcme("member", "mem@example.com", "Mem Member");
	con = await memberOfAcme("member", "con@example.com", "Con Contractor");
	await env.DB.prepare(
		"update memberships set is_contractor = 1 where organisation_id = ? and user_id = ?",
	)
		.bind(acme.id, con.user.id)
		.run();
	const [initech] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!initech) throw new Error("seed failed");
	await env.DB.prepare(
		"insert into client_managers (organisation_id, client_id, user_id, created_at) values (?, ?, ?, ?)",
	)
		.bind(acme.id, initech.id, amy.user.id, Date.now())
		.run();
	apollo = await seedProject(acme.id, "Apollo");
	await env.DB.prepare("update projects set client_id = ? where id = ?")
		.bind(initech.id, apollo)
		.run();
	zeus = await seedProject(acme.id, "Zeus");
	await seedTeam(acme.id, "Delivery", { managers: [lin.user.id], members: [mem.user.id] });
	stretches = {
		dee: await assigned(apollo, dee, "delivery_manager", "2026-01-01"),
		mem: await assigned(apollo, mem, "member", "2026-01-01"),
		con: await assigned(apollo, con, "member", "2026-01-01"),
		memZeus: await assigned(zeus, mem, "member", "2026-01-01"),
	};
}, 60_000);

function api(
	path: string,
	token: string,
	{ method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<Response> {
	const headers = new Headers({ Authorization: `Bearer ${token}` });
	if (body !== undefined) headers.set("Content-Type", "application/json");
	return exports.default.fetch(
		new Request(`${ORIGIN}/api/v1${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

/** A token for `who` in Acme, with every scope unless named. */
function tokenFor(who: Person, scopes: readonly ApiScope[] = API_SCOPES) {
	return makeToken(scope, who.user.id, "Test", scopes);
}

type Stretch = {
	id: string;
	project_id: string;
	user: { id: string; name: string | null };
	role: string;
	starts_on: string;
	ends_on: string | null;
	source: string;
};

/** The ids of the stretches `who` is shown of `projectId`'s team, sorted. */
async function shownOf(who: Person, projectId: string): Promise<string[]> {
	const response = await api(`/project_members?project_id=${projectId}`, await tokenFor(who));
	expect(response.status).toBe(200);
	const { data } = (await response.json()) as { data: Stretch[] };
	return data.map((stretch) => stretch.id).sort();
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
	return ((await response.json()) as { error: { code: string; message: string } }).error;
}

/** What `who` is answered putting Alan on Apollo's team as `role`. */
async function assigns(who: Person, role: TeamRole = "member", projectId = apollo) {
	return api("/project_members", await tokenFor(who), {
		method: "POST",
		body: { project_id: projectId, user_id: alan.user.id, role, starts_on: "2026-12-01" },
	});
}

describe("reading a project's team", () => {
	it("shows the whole team to owners, admins, Finance, managers of teams, account managers and delivery managers", async () => {
		const whole = [stretches.dee, stretches.mem, stretches.con].sort();
		for (const who of [ada, alan, fay, lin, amy, dee]) {
			expect(await shownOf(who, apollo)).toEqual(whole);
		}
	});

	it("shows a member and a contractor their own stretches alone", async () => {
		expect(await shownOf(mem, apollo)).toEqual([stretches.mem]);
		expect(await shownOf(con, apollo)).toEqual([stretches.con]);
		// Across projects too: the member's own on both, the contractor's own on one.
		const { data } = (await (await api("/project_members", await tokenFor(mem))).json()) as {
			data: Stretch[];
		};
		expect(data.map((s) => s.id).sort()).toEqual([stretches.mem, stretches.memZeus].sort());
		// One they may not see answers as one that is not there.
		expect((await api(`/project_members/${stretches.dee}`, await tokenFor(mem))).status).toBe(404);
	});

	it("shows an account manager and a delivery manager only their own on a project they do not oversee", async () => {
		expect(await shownOf(amy, zeus)).toEqual([]);
		expect(await shownOf(dee, zeus)).toEqual([]);
		expect(await shownOf(lin, zeus)).toEqual([stretches.memZeus]);
	});

	it("answers each stretch with its person, role, days and source, and pages by id", async () => {
		const token = await tokenFor(ada);
		const one = await api(`/project_members/${stretches.dee}`, token);
		expect(one.status).toBe(200);
		expect(await one.json()).toEqual({
			id: stretches.dee,
			project_id: apollo,
			user: { id: dee.user.id, name: "Dee Delivery" },
			role: "delivery_manager",
			starts_on: "2026-01-01",
			ends_on: null,
			source: "manual",
		});
		const first = (await (await api("/project_members?per_page=3", token)).json()) as {
			data: Stretch[];
			next_cursor: string | null;
		};
		expect(first.data).toHaveLength(3);
		expect(first.next_cursor).not.toBeNull();
		const next = (await (
			await api(`/project_members?per_page=3&cursor=${first.next_cursor}`, token)
		).json()) as { data: Stretch[]; next_cursor: string | null };
		expect(next.data).toHaveLength(1);
		expect(next.next_cursor).toBeNull();
		const filtered = (await (
			await api(`/project_members?user_id=${mem.user.id}`, token)
		).json()) as { data: Stretch[] };
		expect(filtered.data.map((s) => s.id).sort()).toEqual(
			[stretches.mem, stretches.memZeus].sort(),
		);
	});

	it("answers 404 to another organisation's token for this organisation's project and stretches", async () => {
		const eve = await person(mailbox, "eve@example.com");
		const globex = await createOrganisation(eve.cookie, "Globex");
		const token = await makeToken(
			organisationScope(env.DB, globex.id),
			eve.user.id,
			"Eve",
			API_SCOPES,
		);
		expect((await api(`/project_members?project_id=${apollo}`, token)).status).toBe(404);
		expect((await api(`/project_members/${stretches.mem}`, token)).status).toBe(404);
		expect(
			((await (await api("/project_members", token)).json()) as { data: unknown[] }).data,
		).toEqual([]);
		const posted = await api("/project_members", token, {
			method: "POST",
			body: { project_id: apollo, user_id: eve.user.id, role: "member", starts_on: "2026-12-01" },
		});
		expect(posted.status).toBe(404);
		expect(
			(await api(`/project_members/${stretches.mem}`, token, { method: "DELETE" })).status,
		).toBe(404);
	});
});

describe("changing a project's team", () => {
	it("lets owners, admins, the client's account managers and delivery managers assign a member", async () => {
		for (const who of [ada, alan, amy, dee]) {
			const answer = await assigns(who);
			expect(answer.status, who.user.email).toBe(201);
			const made = (await answer.json()) as Stretch;
			expect(made).toMatchObject({
				project_id: apollo,
				user: { id: alan.user.id, name: "Alan Admin" },
				role: "member",
				starts_on: "2026-12-01",
				ends_on: null,
				source: "manual",
			});
			expect(answer.headers.get("Location")).toBe(`/api/v1/project_members/${made.id}`);
			// Taken away again, so the next may add it.
			const removed = await api(`/project_members/${made.id}`, await tokenFor(ada), {
				method: "DELETE",
			});
			expect(removed.status).toBe(204);
		}
	});

	it("refuses Finance, a manager of a team, a member and a contractor with 403", async () => {
		for (const who of [fay, lin, mem, con]) {
			const answer = await assigns(who);
			expect(answer.status, who.user.email).toBe(403);
			expect((await errorOf(answer)).code).toBe("forbidden");
		}
		// Not their own stretch either.
		const own = await api(`/project_members/${stretches.mem}`, await tokenFor(mem), {
			method: "PATCH",
			body: { ends_on: "2026-12-31" },
		});
		expect(own.status).toBe(403);
		const removed = await api(`/project_members/${stretches.con}`, await tokenFor(con), {
			method: "DELETE",
		});
		expect(removed.status).toBe(403);
		const seen = await api(`/project_members/${stretches.con}`, await tokenFor(fay), {
			method: "PATCH",
			body: { ends_on: "2026-12-31" },
		});
		expect(seen.status).toBe(403);
	});

	it("refuses an account manager on another client's project", async () => {
		expect((await assigns(amy, "member", zeus)).status).toBe(403);
	});

	it("refuses a delivery manager naming a delivery manager, or changing one's stretch", async () => {
		const named = await assigns(dee, "delivery_manager");
		expect(named.status).toBe(403);
		expect(await errorOf(named)).toEqual({ code: "forbidden", message: NAMES_LEADS_ONLY });
		const token = await tokenFor(dee);
		const promoted = await api(`/project_members/${stretches.mem}`, token, {
			method: "PATCH",
			body: { role: "delivery_manager", from: "2026-12-01" },
		});
		expect(promoted.status).toBe(403);
		const ended = await api(`/project_members/${stretches.dee}`, token, {
			method: "PATCH",
			body: { ends_on: "2026-12-31" },
		});
		expect(ended.status).toBe(403);
		expect((await errorOf(ended)).message).toBe(NAMES_LEADS_ONLY);
		// The ones who name delivery managers do.
		expect((await assigns(amy, "delivery_manager")).status).toBe(201);
		const asAdmin = await api(`/project_members/${stretches.dee}`, await tokenFor(alan), {
			method: "PATCH",
			body: { ends_on: "2026-12-31" },
		});
		expect(asAdmin.status).toBe(200);
		expect(((await asAdmin.json()) as Stretch).ends_on).toBe("2026-12-31");
	});

	it("lets a delivery manager end a member's stretch, and a role changed from a later day starts a new stretch", async () => {
		const ended = await api(`/project_members/${stretches.con}`, await tokenFor(dee), {
			method: "PATCH",
			body: { ends_on: "2026-11-30" },
		});
		expect(ended.status).toBe(200);
		expect(((await ended.json()) as Stretch).ends_on).toBe("2026-11-30");
		const promoted = await api(`/project_members/${stretches.mem}`, await tokenFor(ada), {
			method: "PATCH",
			body: { role: "delivery_manager", from: "2026-12-01" },
		});
		expect(promoted.status).toBe(200);
		const next = (await promoted.json()) as Stretch;
		expect(next.id).not.toBe(stretches.mem);
		expect(next).toMatchObject({
			role: "delivery_manager",
			starts_on: "2026-12-01",
			ends_on: null,
		});
		const before = (await (
			await api(`/project_members/${stretches.mem}`, await tokenFor(ada))
		).json()) as Stretch;
		expect(before).toMatchObject({ role: "member", ends_on: "2026-11-30" });
	});

	it("answers 409 overlaps for a stretch that shares a day with another of the person's", async () => {
		const answer = await api("/project_members", await tokenFor(ada), {
			method: "POST",
			body: { project_id: apollo, user_id: mem.user.id, role: "member", starts_on: "2026-12-01" },
		});
		expect(answer.status).toBe(409);
		expect((await errorOf(answer)).code).toBe("overlaps");
	});

	it("answers 422 for a stretch ending before it starts, a person not of the organisation, or a body it cannot use", async () => {
		const token = await tokenFor(ada);
		const post = (body: unknown) => api("/project_members", token, { method: "POST", body });
		const backwards = await post({
			project_id: apollo,
			user_id: alan.user.id,
			role: "member",
			starts_on: "2026-12-01",
			ends_on: "2026-11-01",
		});
		expect(backwards.status).toBe(422);
		expect((await errorOf(backwards)).code).toBe("ends_before_start");
		const stranger = await post({
			project_id: apollo,
			user_id: "nobody",
			role: "member",
			starts_on: "2026-12-01",
		});
		expect(stranger.status).toBe(422);
		expect((await errorOf(stranger)).code).toBe("not_member");
		const unknownRole = await post({
			project_id: apollo,
			user_id: alan.user.id,
			role: "boss",
			starts_on: "2026-12-01",
		});
		expect(unknownRole.status).toBe(422);
		expect((await errorOf(unknownRole)).code).toBe("invalid");
		const both = await api(`/project_members/${stretches.mem}`, token, {
			method: "PATCH",
			body: { ends_on: "2026-12-31", role: "member", from: "2026-12-01" },
		});
		expect(both.status).toBe(422);
		const roleAlone = await api(`/project_members/${stretches.mem}`, token, {
			method: "PATCH",
			body: { role: "delivery_manager" },
		});
		expect(roleAlone.status).toBe(422);
		const unknownProject = await post({
			project_id: "nothing",
			user_id: alan.user.id,
			role: "member",
			starts_on: "2026-12-01",
		});
		expect(unknownProject.status).toBe(404);
		expect((await api("/project_members/nothing", token, { method: "DELETE" })).status).toBe(404);
	});

	it("answers 409 has_time for a stretch in which its person tracked time, and takes away one with none", async () => {
		await seedEntry(acme.id, mem.user.id, apollo, "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z");
		const token = await tokenFor(ada);
		const kept = await api(`/project_members/${stretches.mem}`, token, { method: "DELETE" });
		expect(kept.status).toBe(409);
		expect((await errorOf(kept)).code).toBe("has_time");
		expect((await api(`/project_members/${stretches.mem}`, token)).status).toBe(200);
		expect(
			(await api(`/project_members/${stretches.con}`, token, { method: "DELETE" })).status,
		).toBe(204);
		expect((await api(`/project_members/${stretches.con}`, token)).status).toBe(404);
	});

	it("needs projects:write: a token with projects:read alone reads, and is answered 403 insufficient_scope", async () => {
		const token = await tokenFor(ada, ["projects:read"]);
		expect((await api(`/project_members/${stretches.mem}`, token)).status).toBe(200);
		const write = await api("/project_members", token, {
			method: "POST",
			body: { project_id: apollo, user_id: alan.user.id, role: "member", starts_on: "2026-12-01" },
		});
		expect(write.status).toBe(403);
		expect((await errorOf(write)).code).toBe("insufficient_scope");
		const read = await api("/project_members", await tokenFor(ada, ["projects:write"]));
		expect(read.status).toBe(403);
		expect((await errorOf(read)).code).toBe("insufficient_scope");
	});

	it("records each change in the activity log with the source api", async () => {
		const made = (await (await assigns(ada)).json()) as Stretch;
		const token = await tokenFor(ada);
		await api(`/project_members/${made.id}`, token, {
			method: "PATCH",
			body: { ends_on: "2026-12-31" },
		});
		await api(`/project_members/${made.id}`, token, { method: "DELETE" });
		const recorded = await env.DB.prepare(
			"select action, source, subject_type, subject_id, actor_id from activity_records where organisation_id = ? and action like 'project.member_%' and source = 'api' order by created_at, id",
		)
			.bind(acme.id)
			.all<{
				action: string;
				source: string;
				subject_type: string;
				subject_id: string;
				actor_id: string;
			}>();
		expect(recorded.results.map((r) => r.action)).toEqual([
			"project.member_added",
			"project.member_changed",
			"project.member_removed",
		]);
		for (const record of recorded.results) {
			expect(record).toMatchObject({
				source: "api",
				subject_type: "project",
				subject_id: apollo,
				actor_id: ada.user.id,
			});
		}
	});
});
