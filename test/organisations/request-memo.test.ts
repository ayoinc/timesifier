import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { accessOf } from "~/organisations/access.server";
import { withRequestMemo } from "~/organisations/request-memo.server";
import { peopleOf, teamPeopleOf } from "~/teams/people.server";
import { addToTeam, managedPeople, managedTeams } from "~/teams/teams.server";

import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { type Crowd, seedCrowd, seedWork, WEEK } from "../lists/crowd";
import { open, type Person } from "../pages/harness";
import { membershipIn, seedMember, seedOrganisation, seedTeam } from "./harness";

// What one request reads of the members and the teams, it reads once (TS-113,
// D6 of research/corporate/scale-test.md). Before, the layout's membership,
// `accessOf`, `managedTeams`, `managedPeople` and `peopleOf` each read again
// what another had read: a manager's Team page read `team_members` five times.
// A GET keeps what it read for that request; a POST, the Cron Triggers and a
// test calling a loader itself keep nothing.

/** The statements D1 is asked to prepare while `run` runs. */
async function statementsWhile(run: () => Promise<unknown>): Promise<string[]> {
	const prepare = vi.spyOn(env.DB, "prepare");
	try {
		await run();
		return prepare.mock.calls.map(([sql]) => String(sql));
	} finally {
		prepare.mockRestore();
	}
}

/** How many of `sql` read `table`. */
function reads(sql: string[], table: string): number {
	return sql.filter((s) => new RegExp(`(from|join) "${table}"`).test(s)).length;
}

/** A GET of nothing in particular, for a request's memo. */
const GET = new Request("https://timesifier.test/app/acme");
const POST = new Request("https://timesifier.test/app/acme/team", { method: "POST" });

describe("a page as a manager of 120 of 150 people", () => {
	let crowd: Crowd;

	beforeEach(async () => {
		await freshDatabase();
		crowd = await seedCrowd(captureEmail());
		await seedWork(crowd);
	}, 60_000);

	async function statementsOf(path: string, who: Person) {
		let status = 0;
		const sql = await statementsWhile(async () => {
			const response = await open(path, who);
			status = response.status;
			await response.text();
		});
		return {
			status,
			total: sql.length,
			memberships: reads(sql, "memberships"),
			teamMembers: reads(sql, "team_members"),
			// The person's own membership: the layout's, and once.
			ownMembership: sql.filter((s) =>
				/from "memberships" where \("memberships"\."organisation_id" = \? and \("memberships"\."user_id" = \?\)\)/.test(
					s,
				),
			).length,
			// The teams they manage: `managedPlaces`, which the layout and `accessOf` share.
			managedTeams: sql.filter((s) => /from "team_members".*"is_manager" = \?/.test(s)).length,
			// The person's pins (TS-122, S2-09): the project picker's, or Team's people.
			pins: reads(sql, "pins"),
			// The bell's unread count (TS-049): the organisation's loader, once.
			notifications: reads(sql, "notifications"),
		};
	}

	// Before: Team 35 statements (5 of memberships, 5 of team_members), the
	// manager's teams read three times. Timesheet day 50 (4 and 3), as now: it
	// read the teams once already, and its repeats are TS-113b's, the
	// timetables of the leave reading the people's places twice (`placesOf`).
	// Since TS-111d and TS-111e, Timesheet day reads 5 more (the dated rules,
	// leave and weeks for the day's limits, the people's zones, and the lock
	// date as it reaches the person, twice) and Team 2 more (leave, and the
	// people's zones): none of the memberships or the teams, and the repeats
	// among them are TS-113b's too. Since TS-122, each reads the person's pins
	// once more: Timesheet day for the project picker, Team for This week. Since
	// TS-049, each reads the person's unread notifications once, for the bell.
	// Since TS-115b, Timesheet day reads the projects' work packages once, for
	// Track time's choices and the names of the day's entries.
	it("Timesheet day reads the manager's membership and their teams once", async () => {
		const counts = await statementsOf(`/app/acme?day=${WEEK}`, crowd.manager);
		expect(counts).toEqual({
			status: 200,
			total: 58,
			memberships: 4,
			teamMembers: 3,
			ownMembership: 1,
			managedTeams: 1,
			pins: 1,
			notifications: 1,
		});
	});

	it("Team reads the manager's membership, their teams and their people once", async () => {
		const counts = await statementsOf(`/app/acme/team?week=${WEEK}`, crowd.manager);
		expect(counts).toEqual({
			status: 200,
			// 36 before TS-125: each page's entries were read row by row, and the
			// total past one page summed apart. Now one sum serves the rows, the
			// order and the total. One more since TS-049, the bell's unread count.
			total: 36,
			memberships: 5,
			teamMembers: 3,
			ownMembership: 1,
			managedTeams: 1,
			pins: 1,
			notifications: 1,
		});
	});
});

describe("a request's memo", () => {
	let acme: { id: string; slug: string };
	let hedy: { userId: string };
	let linus: { userId: string };
	let bola: { userId: string };
	let team: string;

	beforeEach(async () => {
		await freshDatabase();
		acme = await seedOrganisation();
		await seedMember(acme.id, "owner", "ada@example.com");
		hedy = await seedMember(acme.id, "member", "hedy@example.com");
		linus = await seedMember(acme.id, "member", "linus@example.com");
		bola = await seedMember(acme.id, "member", "bola@example.com");
		team = await seedTeam(acme.id, "Platform", {
			members: [linus.userId],
			managers: [hedy.userId],
		});
	});

	/** Hedy's membership of Acme, as the layout reads it. */
	function hedysMembership() {
		return membershipIn({ id: hedy.userId } as Parameters<typeof membershipIn>[0], acme.slug);
	}

	it("in a GET, reads a manager's teams and the people once, however often they are asked for", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const organisation = { timeZone: "Europe/London" };
		const asked: unknown[] = [];
		const sql = await statementsWhile(() =>
			withRequestMemo(GET, async () => {
				const membership = await hedysMembership();
				const access = await accessOf(membership);
				asked.push(
					membership.managesTeams,
					[...access.managed].sort(),
					[...(await accessOf(membership)).managed].sort(),
					await managedTeams(scope, hedy.userId),
					[...(await managedPeople(scope, hedy.userId))].sort(),
					(await peopleOf(scope, organisation)).length,
					(await peopleOf(scope, organisation)).length,
					(await teamPeopleOf(scope, organisation, access)).map((p) => p.id).sort(),
					(await peopleOf(scope, organisation, [bola.userId])).map((p) => p.id),
				);
			}),
		);
		const theTeam = [hedy.userId, linus.userId].sort();
		expect(asked).toEqual([true, theTeam, theTeam, [team], theTeam, 4, 4, theTeam, [bola.userId]]);
		// The organisation, Hedy's membership, the places in her teams, and the
		// members with their accounts: each once.
		expect(reads(sql, "organisations")).toBe(1);
		expect(reads(sql, "memberships")).toBe(2);
		expect(reads(sql, "team_members")).toBe(1);
		expect(reads(sql, "users")).toBe(1);
		expect(sql).toHaveLength(5);
	});

	it("in a POST, reads afresh, so what an action changes is read after it", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const managed = await withRequestMemo(POST, async () => {
			const before = await accessOf(await hedysMembership());
			expect(await addToTeam(scope, hedy.userId, team, bola.userId, false)).toBe("done");
			return [
				before.managed.has(bola.userId),
				(await accessOf(await hedysMembership())).managed.has(bola.userId),
			];
		});
		expect(managed).toEqual([false, true]);
	});

	it("outside a request, as the Cron Triggers and the tests call, reads every time", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const before = await managedPeople(scope, hedy.userId);
		await addToTeam(scope, hedy.userId, team, bola.userId, false);
		expect([
			before.has(bola.userId),
			(await managedPeople(scope, hedy.userId)).has(bola.userId),
		]).toEqual([false, true]);
	});

	it("keeps nothing past its request, nor one organisation's reads for another", async () => {
		const globex = await seedOrganisation("Globex", "globex");
		await seedMember(globex.id, "owner", "grace@example.com");
		const organisation = { timeZone: "Europe/London" };
		const namesIn = async (organisationId: string) =>
			(await peopleOf(organisationScope(env.DB, organisationId), organisation)).map((p) => p.email);

		const first = await withRequestMemo(GET, async () => [
			await namesIn(acme.id),
			await namesIn(globex.id),
		]);
		expect(first).toEqual([
			["ada@example.com", "bola@example.com", "hedy@example.com", "linus@example.com"],
			["grace@example.com"],
		]);

		await seedMember(globex.id, "member", "kat@example.com");
		expect(await withRequestMemo(GET, () => namesIn(globex.id))).toEqual([
			"grace@example.com",
			"kat@example.com",
		]);
	});
});
