import { env } from "cloudflare:workers";
import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { keyedHash } from "~/auth/keyed-hash.server";
import { calendarFeedByHash, type OrganisationScope, organisationScope, users } from "~/db";
import { maySeeLeaveKindOf } from "~/organisations/access";
import { managedTeams } from "~/teams/teams.server";
import { addDays, dayOf } from "~/time/calendar";

import { callerOf, zoneOfCaller } from "./caller.server";
import { type IcsEvent, icsCalendar } from "./ics";

/**
 * Calendar feeds (TS-089): a secret address a calendar subscribes to. A
 * person's own lists their approved leave and, when they chose it, their
 * entries; a manager's lists the approved leave of one team they manage, and
 * no entry and no person's words. The address is shown once, when it is made;
 * only its keyed hash is kept. Revoking it, the person leaving, or a manager
 * no longer managing the team makes the address answer 404.
 */

/** What a feed's secret starts with, so a leaked one can be recognised. */
const FEED_PREFIX = "cal_";

const FEED_SHAPE = /^cal_[A-Za-z0-9_-]{43}$/;

/** How far back a feed reaches: a year of leave, ninety days of entries. */
const LEAVE_DAYS_BACK = 366;
const ENTRY_DAYS_BACK = 90;

function hashOf(token: string) {
	return keyedHash(String(env.BETTER_AUTH_SECRET), "calendar-feed", token);
}

function newToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return FEED_PREFIX + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The person's feeds still working, newest first, each with its team's name. */
export async function listFeeds(scope: OrganisationScope, userId: string) {
	const [feeds, teams] = await Promise.all([
		scope.calendarFeeds.select((f) => and(eq(f.userId, userId), isNull(f.revokedAt)), {
			orderBy: (f) => [desc(f.createdAt)],
		}),
		scope.teams.select(),
	]);
	const teamNames = new Map(teams.map((team) => [team.id, team.name]));
	return feeds.map((feed) => ({
		id: feed.id,
		kind: feed.kind as "person" | "team",
		team: feed.teamId ? (teamNames.get(feed.teamId) ?? null) : null,
		includeEntries: feed.includeEntries,
		createdAt: feed.createdAt.getTime(),
	}));
}

/** The teams `userId` manages, by name, for the choice of a team's feed. */
export async function teamsToFollow(scope: OrganisationScope, userId: string) {
	const managed = await managedTeams(scope, userId);
	if (managed.length === 0) return [];
	const teams = await scope.teams.select((t) => inArray(t.id, managed), {
		orderBy: (t) => [t.name],
	});
	return teams.map((team) => ({ id: team.id, name: team.name }));
}

export type NewFeed =
	| { kind: "person"; includeEntries: boolean }
	| { kind: "team"; teamId: string };

/**
 * Makes a feed for `userId` and returns its secret, shown this once; null for
 * a team they do not manage.
 */
export async function makeFeed(
	scope: OrganisationScope,
	userId: string,
	feed: NewFeed,
): Promise<string | null> {
	if (feed.kind === "team" && !(await managedTeams(scope, userId)).includes(feed.teamId)) {
		return null;
	}
	const token = newToken();
	await scope.calendarFeeds.insert({
		userId,
		kind: feed.kind,
		teamId: feed.kind === "team" ? feed.teamId : null,
		includeEntries: feed.kind === "person" && feed.includeEntries,
		tokenHash: await hashOf(token),
	});
	return token;
}

/** Revokes the person's feed `id`; false when they have no such feed still working. */
export async function revokeFeed(
	scope: OrganisationScope,
	userId: string,
	id: string,
): Promise<boolean> {
	const [revoked] = await scope.calendarFeeds.update({ revokedAt: new Date() }, (f) =>
		and(eq(f.id, id), eq(f.userId, userId), isNull(f.revokedAt)),
	);
	return revoked !== undefined;
}

/** The calendar behind the secret `token` at `now`, or null when there is none to show. */
export async function feedCalendar(token: string, now: number): Promise<string | null> {
	if (!FEED_SHAPE.test(token)) return null;
	const found = await calendarFeedByHash(env.DB, await hashOf(token));
	if (!found) return null;
	const [feed] = await organisationScope(env.DB, found.organisationId).calendarFeeds.select(
		(f) => eq(f.id, found.id),
		{ limit: 1 },
	);
	if (!feed) return null;
	const caller = await callerOf(found.organisationId, feed.userId);
	if (!caller) return null;
	const { scope } = caller;

	const zone = zoneOfCaller(caller);
	const today = dayOf(now, zone);
	const kinds = new Map((await scope.leaveKinds.select()).map((kind) => [kind.id, kind.name]));

	if (feed.kind === "team") {
		const teamId = feed.teamId ?? "";
		if (!(await managedTeams(scope, caller.user.id)).includes(teamId)) return null;
		const [[team], members] = await Promise.all([
			scope.teams.select((t) => eq(t.id, teamId), { limit: 1 }),
			scope.teamMembers.select((m) => eq(m.teamId, teamId)),
		]);
		const people = members.map((member) => member.userId);
		const leave = await approvedLeave(scope, people, addDays(today, -LEAVE_DAYS_BACK));
		const names = await namesOf(people);
		const events: IcsEvent[] = leave.map((request) => {
			const kind = maySeeLeaveKindOf(caller.access, request.userId)
				? kinds.get(request.kindId)
				: null;
			return {
				uid: `leave-${request.id}@timesifier`,
				summary: `${names.get(request.userId) ?? "Someone"}: ${kind ?? "On leave"}${halfDays(request)}`,
				allDay: { first: request.startsOn, last: request.endsOn },
			};
		});
		return icsCalendar(
			`${team?.name ?? "Team"} leave · ${caller.organisation.name}`,
			zone,
			events,
			now,
		);
	}

	const events: IcsEvent[] = (
		await approvedLeave(scope, [caller.user.id], addDays(today, -LEAVE_DAYS_BACK))
	).map((request) => ({
		uid: `leave-${request.id}@timesifier`,
		summary: `${kinds.get(request.kindId) ?? "Leave"}${halfDays(request)}`,
		allDay: { first: request.startsOn, last: request.endsOn },
	}));
	if (feed.includeEntries) {
		const since = new Date(now - ENTRY_DAYS_BACK * 86_400_000);
		const [entries, projects, tasks] = await Promise.all([
			scope.timeEntries.select(
				(e) => and(eq(e.userId, caller.user.id), gte(e.startedAt, since), isNotNull(e.endedAt)),
				{ orderBy: (e) => [e.startedAt], limit: 2000 },
			),
			scope.projects.select(),
			scope.tasks.select(),
		]);
		const projectNames = new Map(projects.map((p) => [p.id, p.name]));
		const taskNames = new Map(tasks.map((t) => [t.id, t.name]));
		for (const entry of entries) {
			const task = entry.taskId ? taskNames.get(entry.taskId) : undefined;
			events.push({
				uid: `entry-${entry.id}@timesifier`,
				summary: `${projectNames.get(entry.projectId) ?? "Project"}${task ? ` · ${task}` : ""}`,
				// The person's own feed: their own words.
				description: entry.description,
				timed: {
					start: entry.startedAt.getTime(),
					end: entry.endedAt?.getTime() ?? now,
					zone,
				},
			});
		}
	}
	return icsCalendar(`${caller.user.name} · ${caller.organisation.name}`, zone, events, now);
}

function halfDays(request: { startsHalf: boolean; endsHalf: boolean }) {
	return request.startsHalf || request.endsHalf ? " (half day)" : "";
}

function approvedLeave(scope: OrganisationScope, people: string[], from: string) {
	if (people.length === 0) return Promise.resolve([]);
	return scope.leaveRequests.select(
		(l) => and(inArray(l.userId, people), eq(l.status, "approved"), gte(l.endsOn, from)),
		{ orderBy: (l) => [l.startsOn] },
	);
}

async function namesOf(ids: string[]) {
	if (ids.length === 0) return new Map<string, string>();
	const rows = await drizzle(env.DB)
		.select({ id: users.id, name: users.name })
		.from(users)
		.where(inArray(users.id, ids));
	return new Map(rows.map((row) => [row.id, row.name]));
}
