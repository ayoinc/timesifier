import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { SHARE_PROBLEMS } from "~/allocations/allocations";
import { setShare } from "~/allocations/allocations.server";
import { type OrganisationScope, organisationScope } from "~/db";
import { makeToken } from "~/integrations/api-tokens.server";
import { API_SCOPES, type ApiScope } from "~/integrations/scopes";
import { assignToTeam } from "~/projects/teams.server";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership, seedTeam } from "../organisations/harness";
import { type Person, person } from "../pages/harness";
import { seedProject } from "../pages/periods-seed";

// The API's time shares (TS-116, docs/decisions.md entry 78): read with
// projects:read and written with projects:write. Each role sees the shares
// the Team page and the project's Team tab show it: owners and admins every
// share; anyone else their own, those of the people in teams they manage,
// and every share on the projects they lead as delivery manager or whose
// client they are account manager of. Owners, admins, the client's account
// managers and the project's delivery managers set them.

/** A fixed past instant: Monday 16 November 2026, midday in London. */
const NOW = Date.parse("2026-11-16T12:00:00Z");
/** The fixed clock, set once the people have signed in. */
let clock: MockInstance<() => number>;

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
/** Apollo is Initech's, which Amy is account manager of, and Dee leads; Zeus is nobody's client's. */
let apollo: string;
let zeus: string;
/** A work package of Apollo, and one of Zeus. */
let apolloWp: string;
let zeusWp: string;
/** The shares set up. */
let shares: {
	memApollo: string;
	memZeus: string;
	conApollo: string;
	fayZeus: string;
	alanZeus: string;
};

/** A person of `role` in Acme named `name`. */
async function memberOfAcme(role: Role, email: string, name: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	await env.DB.prepare("update users set name = ? where id = ?").bind(name, who.user.id).run();
	return who;
}

async function workPackage(projectId: string, code: string): Promise<string> {
	const [added] = await scope.workPackages.insert({
		projectId,
		code,
		codeKey: code.toLowerCase(),
		name: `Package ${code}`,
	});
	if (!added) throw new Error("seed failed");
	return added.id;
}

async function shared(
	who: Person,
	projectId: string,
	amount: number,
	unit: "days" | "hours" | "percent",
	startsOn: string,
	endsOn: string | null = null,
) {
	const change = await setShare(
		scope,
		{ userId: ada.user.id },
		{ projectId, workPackageId: null, userId: who.user.id, startsOn, endsOn, amount, unit },
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
	// Signing in reads the real clock; from here on the day is fixed, so the
	// delivery manager leads Apollo on a known day.
	clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
	const [initech] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	if (!initech) throw new Error("seed failed");
	await env.DB.prepare(
		"insert into client_managers (organisation_id, client_id, user_id, created_at) values (?, ?, ?, ?)",
	)
		.bind(acme.id, initech.id, amy.user.id, NOW)
		.run();
	apollo = await seedProject(acme.id, "Apollo");
	await env.DB.prepare("update projects set client_id = ? where id = ?")
		.bind(initech.id, apollo)
		.run();
	zeus = await seedProject(acme.id, "Zeus");
	apolloWp = await workPackage(apollo, "WP1");
	zeusWp = await workPackage(zeus, "WP9");
	await seedTeam(acme.id, "Delivery", { managers: [lin.user.id], members: [mem.user.id] });
	const lead = await assignToTeam(
		scope,
		{ userId: ada.user.id },
		{
			projectId: apollo,
			userId: dee.user.id,
			role: "delivery_manager",
			startsOn: "2026-01-01",
			endsOn: null,
		},
	);
	if (!lead?.ok) throw new Error("seed failed");
	shares = {
		memApollo: await shared(mem, apollo, 250, "days", "2026-01-01"),
		memZeus: await shared(mem, zeus, 5000, "percent", "2026-06-01"),
		conApollo: await shared(con, apollo, 2250, "hours", "2026-01-01"),
		fayZeus: await shared(fay, zeus, 100, "days", "2026-01-01", "2026-03-31"),
		alanZeus: await shared(alan, zeus, 1000, "hours", "2026-01-01"),
	};
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

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

type Allocation = {
	id: string;
	user_id: string;
	project_id: string;
	work_package_id: string | null;
	starts_on: string;
	ends_on: string | null;
	amount: number;
	unit: string;
	amount_text: string;
};

/** The ids of the shares `who` is shown at `path`, sorted. */
async function shownTo(who: Person, path = "/allocations"): Promise<string[]> {
	const response = await api(path, await tokenFor(who));
	expect(response.status).toBe(200);
	const { data } = (await response.json()) as { data: Allocation[] };
	return data.map((share) => share.id).sort();
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
	return ((await response.json()) as { error: { code: string; message: string } }).error;
}

/** What `who` is answered giving Alan a share of `projectId` from 1 December. */
async function allocates(who: Person, projectId = apollo, body: Record<string, unknown> = {}) {
	return api("/allocations", await tokenFor(who), {
		method: "POST",
		body: {
			user_id: alan.user.id,
			project_id: projectId,
			starts_on: "2026-12-01",
			amount: 2.5,
			unit: "days",
			...body,
		},
	});
}

describe("reading time shares", () => {
	it("shows owners and admins every share", async () => {
		const every = Object.values(shares).sort();
		expect(await shownTo(ada)).toEqual(every);
		expect(await shownTo(alan)).toEqual(every);
	});

	it("shows Finance, a member and a contractor their own alone", async () => {
		expect(await shownTo(fay)).toEqual([shares.fayZeus]);
		expect(await shownTo(mem)).toEqual([shares.memApollo, shares.memZeus].sort());
		expect(await shownTo(con)).toEqual([shares.conApollo]);
		// One they may not see answers as one that is not there.
		expect((await api(`/allocations/${shares.conApollo}`, await tokenFor(mem))).status).toBe(404);
		expect((await api(`/allocations/${shares.memApollo}`, await tokenFor(fay))).status).toBe(404);
	});

	it("shows the account manager and the delivery manager every share on the project, and a line manager their team's", async () => {
		const onApollo = [shares.memApollo, shares.conApollo].sort();
		expect(await shownTo(amy)).toEqual(onApollo);
		expect(await shownTo(dee)).toEqual(onApollo);
		expect(await shownTo(lin)).toEqual([shares.memApollo, shares.memZeus].sort());
		expect((await api(`/allocations/${shares.memZeus}`, await tokenFor(amy))).status).toBe(404);
		expect((await api(`/allocations/${shares.memZeus}`, await tokenFor(lin))).status).toBe(200);
	});

	it("answers each share with its amount in its unit and in words, filters, and pages by id", async () => {
		const token = await tokenFor(ada);
		const one = await api(`/allocations/${shares.conApollo}`, token);
		expect(one.status).toBe(200);
		expect(await one.json()).toEqual({
			id: shares.conApollo,
			user_id: con.user.id,
			project_id: apollo,
			work_package_id: null,
			starts_on: "2026-01-01",
			ends_on: null,
			amount: 22.5,
			unit: "hours",
			amount_text: "22:30 a week",
		});
		const first = (await (await api("/allocations?per_page=3", token)).json()) as {
			data: Allocation[];
			next_cursor: string | null;
		};
		expect(first.data).toHaveLength(3);
		expect(first.next_cursor).not.toBeNull();
		const next = (await (
			await api(`/allocations?per_page=3&cursor=${first.next_cursor}`, token)
		).json()) as { data: Allocation[]; next_cursor: string | null };
		expect(next.data).toHaveLength(2);
		expect(next.next_cursor).toBeNull();
		expect(await shownTo(ada, `/allocations?user_id=${mem.user.id}`)).toEqual(
			[shares.memApollo, shares.memZeus].sort(),
		);
		expect(await shownTo(ada, `/allocations?project_id=${zeus}`)).toEqual(
			[shares.memZeus, shares.fayZeus, shares.alanZeus].sort(),
		);
		// From and to keep the shares that run on a day between them.
		expect(await shownTo(ada, "/allocations?from=2026-07-01")).toEqual(
			[shares.memApollo, shares.memZeus, shares.conApollo, shares.alanZeus].sort(),
		);
		expect(await shownTo(ada, "/allocations?from=2026-02-01&to=2026-05-31")).toEqual(
			[shares.memApollo, shares.conApollo, shares.fayZeus, shares.alanZeus].sort(),
		);
		// The filters narrow what the caller sees, never widen it.
		expect(await shownTo(con, `/allocations?user_id=${mem.user.id}`)).toEqual([]);
		expect((await api("/allocations?from=2026-12-01&to=2026-11-01", token)).status).toBe(422);
		expect((await api("/allocations?project_id=nothing", token)).status).toBe(404);
	});

	it("shows another organisation's token nothing of this organisation", async () => {
		// Signing in reads the real clock, so it runs before the day is fixed again.
		clock.mockRestore();
		const eve = await person(mailbox, "eve@example.com");
		const globex = await createOrganisation(eve.cookie, "Globex");
		clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
		const token = await makeToken(
			organisationScope(env.DB, globex.id),
			eve.user.id,
			"Eve",
			API_SCOPES,
		);
		expect(((await (await api("/allocations", token)).json()) as { data: unknown[] }).data).toEqual(
			[],
		);
		expect((await api(`/allocations?project_id=${apollo}`, token)).status).toBe(404);
		expect((await api(`/allocations/${shares.memApollo}`, token)).status).toBe(404);
		const posted = await api("/allocations", token, {
			method: "POST",
			body: {
				user_id: eve.user.id,
				project_id: apollo,
				starts_on: "2026-12-01",
				amount: 1,
				unit: "days",
			},
		});
		expect(posted.status).toBe(404);
		const changed = await api(`/allocations/${shares.memApollo}`, token, {
			method: "PATCH",
			body: { ends_on: "2026-12-31" },
		});
		expect(changed.status).toBe(404);
		expect(
			(await api(`/allocations/${shares.memApollo}`, token, { method: "DELETE" })).status,
		).toBe(404);
	});
});

describe("setting time shares", () => {
	it("lets owners, admins, the client's account manager and the project's delivery manager set one", async () => {
		for (const who of [ada, alan, amy, dee]) {
			const answer = await allocates(who);
			expect(answer.status, who.user.email).toBe(201);
			const made = (await answer.json()) as Allocation;
			expect(made).toMatchObject({
				user_id: alan.user.id,
				project_id: apollo,
				work_package_id: null,
				starts_on: "2026-12-01",
				ends_on: null,
				amount: 2.5,
				unit: "days",
				amount_text: "2.5 days a week",
			});
			expect(answer.headers.get("Location")).toBe(`/api/v1/allocations/${made.id}`);
			// Removed again, so the next may set it.
			const removed = await api(`/allocations/${made.id}`, await tokenFor(who), {
				method: "DELETE",
			});
			expect(removed.status, who.user.email).toBe(204);
		}
	});

	it("refuses Finance, a line manager, a member and a contractor with 403", async () => {
		for (const who of [fay, lin, mem, con]) {
			const answer = await allocates(who);
			expect(answer.status, who.user.email).toBe(403);
			expect((await errorOf(answer)).code).toBe("forbidden");
		}
		// Not a share they see either: their own, or their team's.
		const own = await api(`/allocations/${shares.memApollo}`, await tokenFor(mem), {
			method: "PATCH",
			body: { ends_on: "2026-12-31" },
		});
		expect(own.status).toBe(403);
		const team = await api(`/allocations/${shares.memZeus}`, await tokenFor(lin), {
			method: "DELETE",
		});
		expect(team.status).toBe(403);
		// The account manager and the delivery manager on a project they do not oversee.
		expect((await allocates(amy, zeus)).status).toBe(403);
		expect((await allocates(dee, zeus)).status).toBe(403);
	});

	it("keeps 2.5 days, 22:30 hours as 22.5 and 50% as they were sent", async () => {
		const token = await tokenFor(ada);
		const sent = [
			{ project_id: apollo, amount: 2.5, unit: "days", text: "2.5 days a week" },
			{
				project_id: apollo,
				work_package_id: apolloWp,
				amount: 22.5,
				unit: "hours",
				text: "22:30 a week",
			},
			{ project_id: zeus, amount: 50, unit: "percent", text: "50% of their schedule" },
		];
		for (const { text, ...body } of sent) {
			const answer = await api("/allocations", token, {
				method: "POST",
				body: { user_id: dee.user.id, starts_on: "2026-12-01", ...body },
			});
			expect(answer.status, text).toBe(201);
			const made = (await answer.json()) as Allocation;
			expect(made).toMatchObject({
				amount: body.amount,
				unit: body.unit,
				amount_text: text,
				work_package_id: body.work_package_id ?? null,
			});
			expect(await (await api(`/allocations/${made.id}`, token)).json()).toEqual(made);
			const [stored] = await scope.allocations.select((a) => eq(a.id, made.id));
			expect(stored?.amount).toBe(Math.round(body.amount * 100));
		}
	});

	it("refuses a share that overlaps, ends before it starts, is out of range, names a foreign work package or someone not a member", async () => {
		const token = await tokenFor(ada);
		const post = (body: Record<string, unknown>) =>
			api("/allocations", token, {
				method: "POST",
				body: {
					user_id: alan.user.id,
					project_id: apollo,
					starts_on: "2026-12-01",
					amount: 1,
					unit: "days",
					...body,
				},
			});
		const overlapping = await post({ user_id: mem.user.id });
		expect(overlapping.status).toBe(409);
		expect(await errorOf(overlapping)).toEqual({
			code: "overlaps",
			message: SHARE_PROBLEMS.overlaps,
		});
		const backwards = await post({ ends_on: "2026-11-01" });
		expect(backwards.status).toBe(422);
		expect(await errorOf(backwards)).toEqual({
			code: "ends_before_start",
			message: SHARE_PROBLEMS["ends-before-start"],
		});
		for (const [amount, unit] of [
			[8, "days"],
			[168.01, "hours"],
			[101, "percent"],
			[0, "days"],
			[-1, "hours"],
		] as const) {
			const out = await post({ amount, unit });
			expect(out.status, `${amount} ${unit}`).toBe(422);
			expect(await errorOf(out)).toEqual({ code: "amount", message: SHARE_PROBLEMS.amount });
		}
		const foreign = await post({ work_package_id: zeusWp });
		expect(foreign.status).toBe(422);
		expect(await errorOf(foreign)).toEqual({
			code: "work_package",
			message: SHARE_PROBLEMS["work-package"],
		});
		const stranger = await post({ user_id: "nobody" });
		expect(stranger.status).toBe(422);
		expect(await errorOf(stranger)).toEqual({
			code: "not_member",
			message: SHARE_PROBLEMS["not-member"],
		});
		// A body it cannot use: a third decimal place, an unknown unit, a field it does not know.
		for (const body of [{ amount: 2.555 }, { unit: "weeks" }, { role: "member" }]) {
			const unusable = await post(body);
			expect(unusable.status, JSON.stringify(body)).toBe(422);
			expect((await errorOf(unusable)).code).toBe("invalid");
		}
		expect(await shownTo(ada, `/allocations?user_id=${alan.user.id}`)).toEqual([shares.alanZeus]);
	});
});

describe("changing and removing time shares", () => {
	it("splits a share changed from a later day, so the weeks before keep their plan", async () => {
		const token = await tokenFor(dee);
		const changed = await api(`/allocations/${shares.memApollo}`, token, {
			method: "PATCH",
			body: { amount: 3, unit: "days", from: "2026-12-01" },
		});
		expect(changed.status).toBe(200);
		const next = (await changed.json()) as Allocation;
		expect(next.id).not.toBe(shares.memApollo);
		expect(next).toMatchObject({
			user_id: mem.user.id,
			project_id: apollo,
			starts_on: "2026-12-01",
			ends_on: null,
			amount: 3,
			unit: "days",
			amount_text: "3 days a week",
		});
		const before = (await (
			await api(`/allocations/${shares.memApollo}`, token)
		).json()) as Allocation;
		expect(before).toMatchObject({ starts_on: "2026-01-01", ends_on: "2026-11-30", amount: 2.5 });
	});

	it("changes a share's own amount from its first day when no day is given, and ends one", async () => {
		const token = await tokenFor(amy);
		const own = await api(`/allocations/${shares.conApollo}`, token, {
			method: "PATCH",
			body: { amount: 50, unit: "percent" },
		});
		expect(own.status).toBe(200);
		expect(await own.json()).toMatchObject({
			id: shares.conApollo,
			starts_on: "2026-01-01",
			amount: 50,
			unit: "percent",
			amount_text: "50% of their schedule",
		});
		const ended = await api(`/allocations/${shares.conApollo}`, token, {
			method: "PATCH",
			body: { ends_on: "2026-12-31" },
		});
		expect(ended.status).toBe(200);
		expect(((await ended.json()) as Allocation).ends_on).toBe("2026-12-31");
		const backwards = await api(`/allocations/${shares.conApollo}`, token, {
			method: "PATCH",
			body: { ends_on: "2025-12-31" },
		});
		expect(backwards.status).toBe(422);
		expect((await errorOf(backwards)).code).toBe("ends_before_start");
		const tooMuch = await api(`/allocations/${shares.conApollo}`, token, {
			method: "PATCH",
			body: { amount: 8, unit: "days", from: "2026-12-01" },
		});
		expect(tooMuch.status).toBe(422);
		expect((await errorOf(tooMuch)).code).toBe("amount");
		for (const body of [
			{ ends_on: "2026-12-31", amount: 1, unit: "days" },
			{ amount: 1 },
			{ from: "2026-12-01" },
		]) {
			const unusable = await api(`/allocations/${shares.conApollo}`, token, {
				method: "PATCH",
				body,
			});
			expect(unusable.status, JSON.stringify(body)).toBe(422);
			expect((await errorOf(unusable)).code).toBe("invalid");
		}
	});

	it("removes a share, all of its days", async () => {
		const token = await tokenFor(alan);
		expect((await api(`/allocations/${shares.memZeus}`, token, { method: "DELETE" })).status).toBe(
			204,
		);
		expect((await api(`/allocations/${shares.memZeus}`, token)).status).toBe(404);
		expect((await api(`/allocations/${shares.memZeus}`, token, { method: "DELETE" })).status).toBe(
			404,
		);
		expect((await api("/allocations/nothing", token, { method: "DELETE" })).status).toBe(404);
	});

	it("needs projects:write to change, and projects:read to read", async () => {
		const token = await tokenFor(ada, ["projects:read"]);
		expect((await api(`/allocations/${shares.memApollo}`, token)).status).toBe(200);
		const write = await api("/allocations", token, {
			method: "POST",
			body: {
				user_id: alan.user.id,
				project_id: apollo,
				starts_on: "2026-12-01",
				amount: 1,
				unit: "days",
			},
		});
		expect(write.status).toBe(403);
		expect((await errorOf(write)).code).toBe("insufficient_scope");
		const read = await api("/allocations", await tokenFor(ada, ["projects:write"]));
		expect(read.status).toBe(403);
		expect((await errorOf(read)).code).toBe("insufficient_scope");
	});

	it("records each change in the activity log with the source api", async () => {
		const made = (await (await allocates(dee)).json()) as Allocation;
		const token = await tokenFor(dee);
		await api(`/allocations/${made.id}`, token, {
			method: "PATCH",
			body: { ends_on: "2026-12-31" },
		});
		await api(`/allocations/${made.id}`, token, { method: "DELETE" });
		const recorded = await env.DB.prepare(
			"select action, source, subject_type, subject_id, actor_id from activity_records where organisation_id = ? and action like 'project.share_%' and source = 'api'",
		)
			.bind(acme.id)
			.all<{
				action: string;
				source: string;
				subject_type: string;
				subject_id: string;
				actor_id: string;
			}>();
		// The clock stands still in these tests, so the records are compared as a set.
		expect(recorded.results.map((r) => r.action).sort()).toEqual([
			"project.share_changed",
			"project.share_removed",
			"project.share_set",
		]);
		for (const record of recorded.results) {
			expect(record).toMatchObject({
				source: "api",
				subject_type: "project",
				subject_id: apollo,
				actor_id: dee.user.id,
			});
		}
	});
});
