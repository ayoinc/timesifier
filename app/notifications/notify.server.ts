import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { onLeaveToday } from "~/approvals/approvals.server";
import { projectsApprovalsPath } from "~/approvals/parts";
import type { WaitingPart } from "~/approvals/parts.server";
import { among, type OrganisationScope, organisations, users } from "~/db";
import {
	type Access,
	mayDecideLeaveOf,
	mayDecidePeriodOf,
	maySeeLeaveKindOf,
} from "~/organisations/access";
import { nameOrEmail } from "~/organisations/people";
import { Role } from "~/organisations/roles";
import { destinationPath } from "~/shell/destinations";
import { formatRange } from "~/time/format";
import { weekPath } from "~/timesheet/views";

import {
	type NewNotification,
	notificationStatements,
	pathBelow,
	type RequestOf,
	requestDays,
	requestLabel,
	type WeekOf,
} from "./words";

/**
 * Who is told that something waits for them (TS-049, decision 68): a week
 * submitted, a request made. A decider is told the name of the person whose
 * week or request it is, which they see on Approvals, and nothing of its
 * hours or its reason. Nobody is told of their own (D5, decision 47).
 */

/** Writes `notifications` in one batch. */
export async function notify(
	scope: OrganisationScope,
	notifications: readonly NewNotification[],
): Promise<void> {
	const [first, ...rest] = notificationStatements(scope, notifications);
	if (first) await scope.batch([first, ...rest]);
}

/** The name of each of `ids` as the organisation shows it: their name, or their address. */
export async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
	if (ids.length === 0) return new Map();
	const rows = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(among(users.id, ids));
	return new Map(rows.map((row) => [row.id, nameOrEmail(row)]));
}

/** What a decider may decide of a person: their week, or their requests. */
type Deciding = (access: Access, personId: string) => boolean;

/**
 * For each of `personIds`, the people told that something of theirs waits
 * (decision 68): the managers of the teams they are in, but not a manager on
 * leave all of today (D6, decision 48); where no manager of theirs is there,
 * the organisation's owners and admins. Each is kept only where `may` says
 * they decide it, so nobody is told of their own (D5, decision 47). A person
 * nobody else decides for has nobody: what they submit is approved by the system.
 */
export async function decidersOf(
	scope: OrganisationScope,
	personIds: readonly string[],
	now: number,
	may: Deciding = mayDecidePeriodOf,
): Promise<Map<string, string[]>> {
	const found = new Map<string, string[]>();
	const ids = [...new Set(personIds)];
	if (ids.length === 0) return found;
	const [administrators, places, [organisation]] = await Promise.all([
		scope.memberships.select((m) => inArray(m.role, ["owner", "admin"])),
		scope.teamMembers.select((t) => among(t.userId, ids)),
		drizzle(env.DB)
			.select({ timeZone: organisations.timeZone })
			.from(organisations)
			.where(eq(organisations.id, scope.organisationId))
			.limit(1),
	]);
	const managers =
		places.length === 0
			? []
			: await scope.teamMembers.select((t) =>
					and(
						among(
							t.teamId,
							places.map((p) => p.teamId),
						),
						eq(t.isManager, true),
					),
				);
	const managerIds = [...new Set(managers.map((m) => m.userId))];
	const [away, roles] = await Promise.all([
		onLeaveToday(scope, managerIds, organisation ?? { timeZone: "UTC" }, now),
		managerIds.length === 0 ? [] : scope.memberships.select((m) => among(m.userId, managerIds)),
	]);
	const roleOf = new Map(
		[...roles, ...administrators].map((m) => [m.userId, Role.parse(m.role)] as const),
	);
	const accessOf = (userId: string, managed: string[]): Access => ({
		userId,
		role: roleOf.get(userId) ?? "member",
		managed: new Set(managed),
	});
	for (const personId of ids) {
		const teams = new Set(places.filter((p) => p.userId === personId).map((p) => p.teamId));
		// A manager manages every member of their team (`managedPeople`).
		const present = [
			...new Set(managers.filter((m) => teams.has(m.teamId)).map((m) => m.userId)),
		].filter((id) => !away.has(id) && may(accessOf(id, [personId]), personId));
		const deciders =
			present.length > 0
				? present
				: administrators.map((m) => m.userId).filter((id) => may(accessOf(id, []), personId));
		found.set(personId, [...new Set(deciders)].sort());
	}
	return found;
}

/**
 * For each of `parts`, project parts of weeks (TS-117), the people told
 * that it waits (decision 68): its delivery managers in the week but its
 * person, and not one on leave all of today (D6, decision 48); where none is
 * there, the organisation's owners and admins but its person (D5, decision
 * 47). In the order given.
 */
export async function projectDecidersOf(
	scope: OrganisationScope,
	parts: readonly { personId: string; deliveryManagers: readonly string[] }[],
	now: number,
): Promise<string[][]> {
	if (parts.length === 0) return [];
	const leaders = [...new Set(parts.flatMap((p) => p.deliveryManagers))];
	const [administrators, [organisation]] = await Promise.all([
		scope.memberships.select((m) => inArray(m.role, ["owner", "admin"])),
		drizzle(env.DB)
			.select({ timeZone: organisations.timeZone })
			.from(organisations)
			.where(eq(organisations.id, scope.organisationId))
			.limit(1),
	]);
	const away = await onLeaveToday(scope, leaders, organisation ?? { timeZone: "UTC" }, now);
	return parts.map(({ personId, deliveryManagers }) => {
		const present = deliveryManagers.filter((id) => id !== personId && !away.has(id));
		const deciders =
			present.length > 0
				? present
				: administrators.map((m) => m.userId).filter((id) => id !== personId);
		return [...new Set(deciders)].sort();
	});
}

/** A week submitted, for `weeksSubmitted`. */
export interface WeekSubmitted extends WeekOf {
	bySystem: boolean;
	/** Whether the whole week was approved as it was submitted, as nobody else may decide it (D5). */
	alone: boolean;
	/** The parts of it that wait (TS-117); null for a week decided whole. */
	parts?: readonly WaitingPart[] | null;
}

/**
 * The notifications of weeks submitted: to each week's deciders, that it
 * waits for them; and, for one the system submitted (TR-01), to its person,
 * that the system did so, and `why`. A week approved as it was submitted,
 * as nobody else may decide it (D5), waits for nobody. A week held in parts
 * (TS-117) tells the deciders of each part that waits: its line manager of
 * the rest of it, and each project's delivery managers of its time there.
 */
export async function weeksSubmitted(
	scope: OrganisationScope,
	weeks: readonly WeekSubmitted[],
	now: number,
	why: string | null = null,
): Promise<NewNotification[]> {
	if (weeks.length === 0) return [];
	const lineWaits = (week: WeekSubmitted) =>
		!week.alone && (!week.parts || week.parts.some((p) => p.projectId === null));
	const projectParts = weeks.flatMap((week) =>
		week.alone
			? []
			: (week.parts ?? []).flatMap((part) =>
					part.projectId === null ? [] : [{ week, projectId: part.projectId, part }],
				),
	);
	const waiting = weeks.filter((w) => !w.alone).map((w) => w.userId);
	const projectIds = [...new Set(projectParts.map((p) => p.projectId))];
	const [deciders, names, partDeciders, projects] = await Promise.all([
		decidersOf(
			scope,
			weeks.filter(lineWaits).map((w) => w.userId),
			now,
		),
		namesOf(waiting),
		projectDecidersOf(
			scope,
			projectParts.map(({ week, part }) => ({
				personId: week.userId,
				deliveryManagers: part.deliveryManagers,
			})),
			now,
		),
		projectIds.length === 0 ? [] : scope.projects.select((p) => among(p.id, projectIds)),
	]);
	const projectName = new Map(projects.map((p) => [p.id, p.name]));
	const made: NewNotification[] = [];
	const approvals = pathBelow((slug) => destinationPath(slug, "approvals"));
	for (const week of weeks) {
		const words = formatRange(week.startsOn, week.endsOn);
		const name = names.get(week.userId) ?? "Someone";
		if (lineWaits(week)) {
			for (const userId of deciders.get(week.userId) ?? []) {
				made.push({
					userId,
					kind: "week-waiting",
					title: week.bySystem
						? `${name}'s timesheet for ${words} was submitted by the system and waits for your approval.`
						: `${name} submitted their timesheet for ${words}.`,
					path: approvals,
				});
			}
		}
		projectParts.forEach((each, index) => {
			if (each.week !== week) return;
			const project = projectName.get(each.projectId) ?? "a project";
			for (const userId of partDeciders[index] ?? []) {
				made.push({
					userId,
					kind: "week-waiting",
					title: week.bySystem
						? `${name}'s time on ${project} for ${words} was submitted by the system and waits for your approval.`
						: `${name} submitted their time on ${project} for ${words}.`,
					path: pathBelow((slug) => projectsApprovalsPath(slug, week.startsOn)),
				});
			}
		});
		if (week.bySystem) {
			made.push({
				userId: week.userId,
				kind: "system",
				title: week.alone
					? `Your timesheet for ${words} was submitted and approved by the system.`
					: `Your timesheet for ${words} was submitted by the system.`,
				body: why,
				path: pathBelow((slug) => weekPath(slug, week.startsOn)),
			});
		}
	}
	return made;
}

/**
 * The notifications of a request waiting: to its deciders (decision 68),
 * each told what it is for only where they may see that kind of leave
 * (`maySeeLeaveKindOf`), as every decider of leave may; otherwise "leave".
 */
export async function requestWaiting(
	scope: OrganisationScope,
	request: RequestOf,
	now: number,
): Promise<NewNotification[]> {
	const [deciders, names] = await Promise.all([
		decidersOf(scope, [request.userId], now, mayDecideLeaveOf),
		namesOf([request.userId]),
	]);
	const name = names.get(request.userId) ?? "Someone";
	const recipients = deciders.get(request.userId) ?? [];
	if (recipients.length === 0) return [];
	const roles = new Map(
		(await scope.memberships.select((m) => among(m.userId, recipients))).map((m) => [
			m.userId,
			Role.parse(m.role),
		]),
	);
	return recipients.map((userId) => {
		const access: Access = {
			userId,
			role: roles.get(userId) ?? "member",
			managed: new Set([request.userId]),
		};
		const what =
			request.type === "work" || maySeeLeaveKindOf(access, request.userId)
				? requestLabel(request)
				: "leave";
		return {
			userId,
			kind: "request-waiting",
			title: `${name} asked for ${what}: ${requestDays(request)}.`,
			path: pathBelow((slug) => destinationPath(slug, "approvals")),
		};
	});
}
