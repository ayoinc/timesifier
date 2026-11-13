import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope, organisations, users } from "~/db";
import { accessOf } from "~/organisations/access.server";
import type { Membership } from "~/organisations/membership.server";
import { lockedDays } from "~/periods/locks.server";
import { activeProjects, findActiveProject } from "~/projects/projects.server";
import { managedPeople } from "~/teams/teams.server";
import { dayOf } from "~/time/calendar";
import { runningEntry, startTimer, stopTimer } from "~/time/entries.server";
import { freshDatabase } from "../db/database";

// The rules the slices share, against the real database: one running entry
// for a person in an organisation, started and stopped by the server's clock
// (decision 25); a submitted or approved period locks its days (TS-046); the
// active projects (TS-011a); the people a manager looks after (TS-038).

const ZONE = "Europe/London";
const T0 = Date.parse("2026-11-11T09:00:00Z");
const MINUTE = 60_000;

let acme: OrganisationScope;
let globex: OrganisationScope;
let ada: string;
let bola: string;
let projectId: string;

beforeEach(async () => {
	await freshDatabase();
	const db = drizzle(env.DB);
	const [a, g] = await db
		.insert(organisations)
		.values([
			{ name: "Acme", slug: "acme" },
			{ name: "Globex", slug: "globex" },
		])
		.returning();
	const [u1, u2] = await db
		.insert(users)
		.values([
			{ name: "Ada", email: "ada@example.com" },
			{ name: "Bola", email: "bola@example.com" },
		])
		.returning();
	if (!a || !g || !u1 || !u2) throw new Error("seed failed");
	acme = organisationScope(env.DB, a.id);
	globex = organisationScope(env.DB, g.id);
	await acme.memberships.insert([
		{ userId: u1.id, role: "owner" },
		{ userId: u2.id, role: "member" },
	]);
	await globex.memberships.insert({ userId: u1.id, role: "owner" });
	ada = u1.id;
	bola = u2.id;
	const [project] = await acme.projects.insert({ name: "Site", nameKey: "site" });
	if (!project) throw new Error("seed failed");
	projectId = project.id;
});

const start = (scope: OrganisationScope, now: number, project = projectId, who = ada) =>
	startTimer(scope, { userId: who, projectId: project, description: null, zone: ZONE, now });

describe("the timer", () => {
	it("starts one running entry at the server's clock", async () => {
		const outcome = await start(acme, T0);

		expect(outcome.ok).toBe(true);
		const running = await runningEntry(acme, ada);
		expect(running?.startedAt.getTime()).toBe(T0);
		expect(running?.endedAt).toBeNull();
	});

	it("stops the running entry when it starts another, at the same instant and in one batch", async () => {
		await start(acme, T0);
		const outcome = await start(acme, T0 + 30 * MINUTE);

		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.stopped?.endedAt?.getTime()).toBe(T0 + 30 * MINUTE);
		expect(outcome.started.startedAt.getTime()).toBe(T0 + 30 * MINUTE);
		expect(await acme.timeEntries.select()).toHaveLength(2);
		expect((await runningEntry(acme, ada))?.id).toBe(outcome.started.id);
	});

	it("leaves the first entry running when the second cannot be stored", async () => {
		await start(acme, T0);
		// The insert is made to fail: it names a project the database does not hold.
		const { insert } = acme.timeEntries.statements;
		const failing = vi.spyOn(acme.timeEntries.statements, "insert").mockImplementationOnce(() =>
			insert({
				userId: ada,
				projectId: "no-such-project",
				description: null,
				startedAt: new Date(T0 + MINUTE),
				spentOn: dayOf(T0 + MINUTE, ZONE),
				endedAt: null,
			}),
		);

		await expect(start(acme, T0 + MINUTE)).rejects.toThrow();
		expect(failing).toHaveBeenCalledOnce();
		expect((await runningEntry(acme, ada))?.startedAt.getTime()).toBe(T0);
	});

	it("runs one timer in each of two organisations for the same person", async () => {
		const [theirs] = await globex.projects.insert({ name: "Site", nameKey: "site" });
		if (!theirs) throw new Error("seed failed");

		await start(acme, T0);
		await start(globex, T0 + MINUTE, theirs.id);

		expect(await runningEntry(acme, ada)).not.toBeNull();
		expect(await runningEntry(globex, ada)).not.toBeNull();
	});

	it("keeps one person's timer apart from another's", async () => {
		await start(acme, T0);
		await start(acme, T0 + MINUTE, projectId, bola);

		expect((await stopTimer(acme, bola, T0 + 2 * MINUTE))?.userId).toBe(bola);
		expect(await runningEntry(acme, ada)).not.toBeNull();
	});

	it("refuses an archived project and a project of another organisation, and stores nothing", async () => {
		const [theirs] = await globex.projects.insert({ name: "Theirs", nameKey: "theirs" });
		await acme.projects.update({ archivedAt: new Date(T0) }, (p) => eq(p.id, projectId));

		expect(await start(acme, T0)).toEqual({ ok: false, reason: "no-project" });
		expect(await start(acme, T0, theirs?.id ?? "")).toEqual({ ok: false, reason: "no-project" });
		expect(await acme.timeEntries.select()).toEqual([]);
	});

	it("is refused on a day of a submitted or approved period, and allowed again once it is returned", async () => {
		const [period] = await acme.periods.insert({
			userId: ada,
			startsOn: "2026-11-09",
			endsOn: "2026-11-15",
			status: "submitted",
			submittedAt: new Date(T0),
		});

		expect(await start(acme, T0)).toEqual({ ok: false, reason: "locked" });
		await acme.periods.update({ status: "approved" }, (p) => eq(p.id, period?.id ?? ""));
		expect(await start(acme, T0)).toEqual({ ok: false, reason: "locked" });
		await acme.periods.update({ status: "returned" }, (p) => eq(p.id, period?.id ?? ""));
		expect((await start(acme, T0)).ok).toBe(true);
	});

	it("stops the running entry at the server's clock, and does nothing when none runs", async () => {
		expect(await stopTimer(acme, ada, T0)).toBeNull();
		await start(acme, T0);

		const stopped = await stopTimer(acme, ada, T0 + 5 * MINUTE);

		expect(stopped?.endedAt?.getTime()).toBe(T0 + 5 * MINUTE);
		expect(await runningEntry(acme, ada)).toBeNull();
	});
});

describe("locked days", () => {
	it("are the days of a person's submitted or approved periods, and of nobody else's", async () => {
		await acme.periods.insert([
			{
				userId: ada,
				startsOn: "2026-11-02",
				endsOn: "2026-11-08",
				status: "approved",
				submittedAt: new Date(T0),
			},
			{
				userId: ada,
				startsOn: "2026-11-09",
				endsOn: "2026-11-15",
				status: "withdrawn",
				submittedAt: new Date(T0),
			},
			{
				userId: bola,
				startsOn: "2026-11-09",
				endsOn: "2026-11-15",
				status: "submitted",
				submittedAt: new Date(T0),
			},
		]);

		const days = ["2026-11-01", "2026-11-02", "2026-11-08", "2026-11-09", "2026-11-11"];
		expect([...(await lockedDays(acme, ada, days))]).toEqual(["2026-11-02", "2026-11-08"]);
		expect([...(await lockedDays(acme, bola, days))]).toEqual(["2026-11-09", "2026-11-11"]);
		expect([...(await lockedDays(globex, ada, days))]).toEqual([]);
		expect([...(await lockedDays(acme, ada, []))]).toEqual([]);
	});
});

describe("the active projects", () => {
	it("are the organisation's projects not archived, by name", async () => {
		await acme.projects.insert([
			{ name: "alpha", nameKey: "alpha" },
			{ name: "Old", nameKey: "old", archivedAt: new Date(T0) },
		]);
		await globex.projects.insert({ name: "Elsewhere", nameKey: "elsewhere" });

		expect((await activeProjects(acme)).map((p) => p.name)).toEqual(["alpha", "Site"]);
		expect(await findActiveProject(acme, projectId)).not.toBeNull();
		const [old] = await acme.projects.select((p) => eq(p.nameKey, "old"));
		expect(await findActiveProject(acme, old?.id ?? "")).toBeNull();
	});
});

describe("the people a manager looks after", () => {
	it("are the members of the teams they manage, read on every request", async () => {
		const db = drizzle(env.DB);
		const [carol] = await db
			.insert(users)
			.values({ name: "Carol", email: "carol@example.com" })
			.returning();
		if (!carol) throw new Error("seed failed");
		await acme.memberships.insert({ userId: carol.id });
		const [design, sales] = await acme.teams.insert([
			{ name: "Design", nameKey: "design" },
			{ name: "Sales", nameKey: "sales" },
		]);
		if (!design || !sales) throw new Error("seed failed");
		await acme.teamMembers.insert([
			{ teamId: design.id, userId: bola, isManager: true },
			{ teamId: design.id, userId: ada },
			{ teamId: sales.id, userId: carol.id },
		]);

		expect([...(await managedPeople(acme, bola))].sort()).toEqual([ada, bola].sort());
		expect([...(await managedPeople(acme, ada))]).toEqual([]);
		expect([...(await managedPeople(globex, bola))]).toEqual([]);

		const membership = {
			organisation: { id: acme.organisationId },
			role: "member",
			managesTeams: true,
			user: { id: bola },
		} as Membership;
		expect((await accessOf(membership)).managed.has(ada)).toBe(true);

		await acme.teamMembers.update({ isManager: false }, (t) => eq(t.userId, bola));
		expect((await accessOf(membership)).managed.size).toBe(0);
	});
});
