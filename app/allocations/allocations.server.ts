import { and, eq, gte, isNull, lte, or } from "drizzle-orm";

import type { ActivitySource } from "~/activity/actions";
import { changes, recordStatement } from "~/activity/activity.server";
import { among, type OrganisationScope, type TenantRow } from "~/db";
import { dayStatus } from "~/leave/days";
import { calendarOf, leaveContext } from "~/leave/leave.server";
import { type Access, isAdministrator } from "~/organisations/access";
import type { Role } from "~/organisations/roles";
import { periodContaining } from "~/periods/periods";
import { namesOf } from "~/projects/project.server";
import { ledProjectIds, mayManageTeam } from "~/projects/teams.server";
import { addDays, type Day, daysFrom } from "~/time/calendar";

import {
	AllocationUnit,
	amountField,
	amountText,
	overlap,
	plannedOn,
	type Share,
	type ShareProblem,
	UNIT_MAX,
} from "./allocations";

// Time shares read and written (TS-116, docs/decisions.md entry 78). A share
// is never edited in its past: a change from a day ends the share the day
// before and starts a new one, so a week already planned keeps its plan. Who
// sets them is who manages the project's team (`mayManageTeam`): owners,
// admins, the client's account managers and the project's delivery managers.

export type AllocationRow = TenantRow<"allocations">;

/** The fields a share's activity record keeps. */
const SHARE_FIELDS = ["userId", "workPackageId", "startsOn", "endsOn", "amount", "unit"] as const;

export function toShare(row: AllocationRow): Share {
	const unit = AllocationUnit.safeParse(row.unit);
	return {
		id: row.id,
		userId: row.userId,
		projectId: row.projectId,
		workPackageId: row.workPackageId,
		startsOn: row.startsOn,
		endsOn: row.endsOn,
		amount: row.amount,
		unit: unit.success ? unit.data : "percent",
	};
}

/**
 * The shares that run on any day from `first` to `last`, of `userIds` and of
 * `projectIds` where given: one statement, whatever their number.
 */
export async function sharesOf(
	scope: OrganisationScope,
	of: { userIds?: readonly string[]; projectIds?: readonly string[]; first: Day; last: Day },
): Promise<Share[]> {
	if (of.userIds?.length === 0 || of.projectIds?.length === 0) return [];
	const rows = await scope.allocations.select((a) =>
		and(
			of.userIds ? among(a.userId, of.userIds) : undefined,
			of.projectIds ? among(a.projectId, of.projectIds) : undefined,
			lte(a.startsOn, of.last),
			or(isNull(a.endsOn), gte(a.endsOn, of.first)),
		),
	);
	return rows.map(toShare);
}

/** One share by its id, or undefined. */
export async function shareById(scope: OrganisationScope, id: string): Promise<Share | undefined> {
	const [row] = await scope.allocations.select((a) => eq(a.id, id), { limit: 1 });
	return row ? toShare(row) : undefined;
}

/** What a viewer may allocate: as an owner or admin, for the clients they manage, for the projects they lead. */
export interface Allocator {
	userId: string;
	role: Role;
	/** The clients they are an account manager of (decision 42). */
	managedClients: string[];
	/** The projects they lead as delivery manager today (TS-115c). */
	led: Set<string>;
}

export async function allocatorOf(
	scope: OrganisationScope,
	viewer: { userId: string; role: Role },
	today: Day,
): Promise<Allocator> {
	const [managed, led] = await Promise.all([
		scope.clientManagers.select((m) => eq(m.userId, viewer.userId)),
		ledProjectIds(scope, viewer.userId, today),
	]);
	return { ...viewer, managedClients: managed.map((m) => m.clientId), led };
}

/** Whether `allocator` sets the time shares of `project`: whoever manages its team. */
export function mayAllocate(
	allocator: Allocator,
	project: { id: string; clientId: string | null },
) {
	return mayManageTeam(
		allocator.role,
		allocator.managedClients,
		project.clientId,
		allocator.led.has(project.id),
	);
}

export type ShareChange = { ok: true; id: string } | { ok: false; problem: ShareProblem } | null;

/** Who did it, and through which door, for the activity record. */
export interface ShareActor {
	userId: string;
	source?: ActivitySource;
}

/** Whether a race let an overlapping share through to the trigger. */
function isOverlap(error: unknown): boolean {
	return error instanceof Error && /never overlap/.test(`${error.message} ${error.cause ?? ""}`);
}

/** The other shares of `userId` on the same line as `share`: the project, or the work package. */
async function sameLine(
	scope: OrganisationScope,
	share: Pick<Share, "userId" | "projectId" | "workPackageId">,
): Promise<Share[]> {
	const rows = await scope.allocations.select((a) =>
		and(
			eq(a.userId, share.userId),
			eq(a.projectId, share.projectId),
			share.workPackageId === null
				? isNull(a.workPackageId)
				: eq(a.workPackageId, share.workPackageId),
		),
	);
	return rows.map(toShare);
}

export interface ShareInput {
	projectId: string;
	workPackageId: string | null;
	userId: string;
	startsOn: Day;
	endsOn: Day | null;
	amount: number;
	unit: AllocationUnit;
}

function amountFits(amount: number, unit: AllocationUnit): boolean {
	return Number.isSafeInteger(amount) && amount > 0 && amount <= UNIT_MAX[unit];
}

/**
 * Gives `userId` a time share of `projectId`, or of one of its work packages.
 * Null when the project is not of this organisation. Refused when they are
 * not a member, the amount is out of range, the work package is another
 * project's, or they already have a share of that line on one of those days.
 */
export async function setShare(
	scope: OrganisationScope,
	actor: ShareActor,
	input: ShareInput,
): Promise<ShareChange> {
	const [project] = await scope.projects.select((p) => eq(p.id, input.projectId), { limit: 1 });
	if (!project) return null;
	if (input.endsOn !== null && input.endsOn < input.startsOn) {
		return { ok: false, problem: "ends-before-start" };
	}
	if (!amountFits(input.amount, input.unit)) return { ok: false, problem: "amount" };
	const [[member], packages] = await Promise.all([
		scope.memberships.select((m) => eq(m.userId, input.userId), { limit: 1 }),
		input.workPackageId === null
			? Promise.resolve([])
			: scope.workPackages.select(
					(w) => and(eq(w.id, input.workPackageId ?? ""), eq(w.projectId, input.projectId)),
					{ limit: 1 },
				),
	]);
	if (input.workPackageId !== null && packages.length === 0) {
		return { ok: false, problem: "work-package" };
	}
	if (!member) return { ok: false, problem: "not-member" };
	if ((await sameLine(scope, input)).some((other) => overlap(other, input))) {
		return { ok: false, problem: "overlaps" };
	}
	const row = { ...input, createdBy: actor.userId };
	try {
		const [[added]] = await scope.batch([
			scope.allocations.statements.insert(row),
			recordStatement(
				scope,
				actor.userId,
				"project.share_set",
				{ type: "project", id: input.projectId },
				changes(null, row, SHARE_FIELDS),
				actor.source,
			),
		]);
		return { ok: true, id: (added as AllocationRow).id };
	} catch (error) {
		if (isOverlap(error)) return { ok: false, problem: "overlaps" };
		throw error;
	}
}

/**
 * Changes one share: its last day (null for open), or its amount from a day.
 * An amount changed from the share's first day, or before, is the share's
 * own; from a later day, the share ends the day before and a new one of the
 * new amount runs on to where it ran, so the weeks before keep their plan.
 * Null when there is no such share, or it is not of `projectId` when given.
 */
export async function changeShare(
	scope: OrganisationScope,
	actor: ShareActor,
	id: string,
	change: { endsOn: Day | null } | { amount: number; unit: AllocationUnit; from: Day },
	projectId?: string,
): Promise<ShareChange> {
	const share = await shareById(scope, id);
	if (!share || (projectId !== undefined && share.projectId !== projectId)) return null;
	const subject = { type: "project" as const, id: share.projectId };
	if ("endsOn" in change) {
		if (change.endsOn !== null && change.endsOn < share.startsOn) {
			return { ok: false, problem: "ends-before-start" };
		}
		if (change.endsOn === share.endsOn) return { ok: true, id };
		const after = { ...share, endsOn: change.endsOn };
		const others = (await sameLine(scope, share)).filter((other) => other.id !== id);
		if (others.some((other) => overlap(other, after))) return { ok: false, problem: "overlaps" };
		try {
			await scope.batch([
				scope.allocations.statements.update({ endsOn: change.endsOn, updatedAt: new Date() }, (a) =>
					eq(a.id, id),
				),
				recordStatement(
					scope,
					actor.userId,
					"project.share_changed",
					subject,
					changes(share, after, SHARE_FIELDS),
					actor.source,
				),
			]);
		} catch (error) {
			if (isOverlap(error)) return { ok: false, problem: "overlaps" };
			throw error;
		}
		return { ok: true, id };
	}
	if (!amountFits(change.amount, change.unit)) return { ok: false, problem: "amount" };
	if (change.amount === share.amount && change.unit === share.unit) return { ok: true, id };
	if (share.endsOn !== null && change.from > share.endsOn) {
		return { ok: false, problem: "ends-before-start" };
	}
	const amount = { amount: change.amount, unit: change.unit };
	if (change.from <= share.startsOn) {
		await scope.batch([
			scope.allocations.statements.update({ ...amount, updatedAt: new Date() }, (a) =>
				eq(a.id, id),
			),
			recordStatement(
				scope,
				actor.userId,
				"project.share_changed",
				subject,
				changes(share, { ...share, ...amount }, SHARE_FIELDS),
				actor.source,
			),
		]);
		return { ok: true, id };
	}
	const next = {
		projectId: share.projectId,
		workPackageId: share.workPackageId,
		userId: share.userId,
		startsOn: change.from,
		endsOn: share.endsOn,
		...amount,
		createdBy: actor.userId,
	};
	const endsOn = addDays(change.from, -1);
	const [, [added]] = await scope.batch([
		scope.allocations.statements.update({ endsOn, updatedAt: new Date() }, (a) => eq(a.id, id)),
		scope.allocations.statements.insert(next),
		recordStatement(
			scope,
			actor.userId,
			"project.share_changed",
			subject,
			changes(share, { ...share, ...amount, startsOn: change.from }, SHARE_FIELDS),
			actor.source,
		),
	]);
	return { ok: true, id: (added as AllocationRow).id };
}

/** Removes one share, all of its days. Null when there is no such share, or it is not of `projectId` when given. */
export async function removeShare(
	scope: OrganisationScope,
	actor: ShareActor,
	id: string,
	projectId?: string,
): Promise<ShareChange> {
	const share = await shareById(scope, id);
	if (!share || (projectId !== undefined && share.projectId !== projectId)) return null;
	await scope.batch([
		scope.allocations.statements.delete((a) => eq(a.id, id)),
		recordStatement(
			scope,
			actor.userId,
			"project.share_removed",
			{ type: "project", id: share.projectId },
			changes(share, null, SHARE_FIELDS),
			actor.source,
		),
	]);
	return { ok: true, id };
}

/** One person's days from `first` to `last`: what their schedule sets, what they have available, and what each share plans. */
export interface PersonPlan {
	userId: string;
	days: Day[];
	/** The schedule's minutes of each day, before holidays and leave. */
	scheduled: number[];
	/** What each day leaves them: the schedule less a public holiday or approved leave. */
	available: number[];
	shares: { share: Share; planned: number[] }[];
}

/**
 * The plans of `userIds` from `first` to `last`, read at once: their
 * schedules, holidays and leave through `leaveContext`, and their shares in
 * one statement. What a share plans on a day is `plannedOn`.
 */
export async function plansOf(
	scope: OrganisationScope,
	userIds: readonly string[],
	first: Day,
	last: Day,
	weekStartsOn: number,
	shares?: readonly Share[],
): Promise<Map<string, PersonPlan>> {
	if (userIds.length === 0) return new Map();
	const [context, read] = await Promise.all([
		leaveContext(scope, userIds, first, last),
		shares ?? sharesOf(scope, { userIds, first, last }),
	]);
	const days = daysFrom(first, last);
	const byPerson = new Map<string, Share[]>();
	for (const share of read)
		byPerson.set(share.userId, [...(byPerson.get(share.userId) ?? []), share]);
	return new Map(
		userIds.map((userId) => {
			const calendar = calendarOf(context, userId);
			const theirs = byPerson.get(userId) ?? [];
			return [
				userId,
				{
					userId,
					days,
					scheduled: days.map((day) => calendar.timetable(day).minutes),
					available: days.map((day) => dayStatus(calendar, day).expectedMinutes),
					shares: theirs.map((share) => ({
						share,
						planned: days.map((day) => plannedOn(share, calendar, day, weekStartsOn)),
					})),
				},
			];
		}),
	);
}

/** The sum of a list of minutes. */
export function total(minutes: readonly number[]): number {
	return minutes.reduce((sum, m) => sum + m, 0);
}

/**
 * Whose time shares a viewer sees (TS-116): owners and admins everyone's;
 * a line manager every share of the people in their teams; a delivery
 * manager, and a client's account manager, every share on the projects they
 * lead or whose client they manage. Anyone sees their own.
 */
export interface ShareSight {
	everyone: boolean;
	/** The people all of whose shares they see: those they manage, and themselves. */
	people: ReadonlySet<string>;
	/** The projects every share of which they see. */
	projects: ReadonlySet<string>;
}

export async function shareSightOf(
	scope: OrganisationScope,
	access: Access,
	allocator: Allocator,
): Promise<ShareSight> {
	if (isAdministrator(access.role))
		return { everyone: true, people: new Set(), projects: new Set() };
	const ofClients =
		allocator.managedClients.length === 0
			? []
			: await scope.projects.select((p) => among(p.clientId, allocator.managedClients));
	return {
		everyone: false,
		people: new Set([access.userId, ...access.managed]),
		projects: new Set([...allocator.led, ...ofClients.map((p) => p.id)]),
	};
}

/** Whether `sight` sees `share`. */
export function sees(sight: ShareSight, share: Pick<Share, "userId" | "projectId">): boolean {
	return sight.everyone || sight.people.has(share.userId) || sight.projects.has(share.projectId);
}

/** One time share as a project's Team tab lists it. */
export interface ListedShare {
	id: string;
	userId: string;
	name: string;
	workPackageId: string | null;
	/** The work package's code and name, "WP2 · Discovery"; null for the whole project. */
	workPackage: string | null;
	startsOn: Day;
	endsOn: Day | null;
	unit: Share["unit"];
	/** In words: "2.5 days a week". */
	amount: string;
	/** As its field shows it: "2.5". */
	field: string;
	/** What it plans in the week shown, in minutes. */
	weekPlanned: number;
}

/**
 * The time shares of `projectId`, of everyone or of `only` (a viewer who
 * does not see the whole team sees their own), with what each plans in the
 * week of `today`: those running or to come first, by name, then the ended.
 */
export async function projectShares(
	scope: OrganisationScope,
	projectId: string,
	today: Day,
	weekStartsOn: number,
	only?: string,
): Promise<ListedShare[]> {
	const [rows, packages] = await Promise.all([
		scope.allocations.select((a) =>
			and(eq(a.projectId, projectId), only === undefined ? undefined : eq(a.userId, only)),
		),
		scope.workPackages.select((w) => eq(w.projectId, projectId)),
	]);
	if (rows.length === 0) return [];
	const shares = rows.map(toShare);
	const userIds = [...new Set(shares.map((s) => s.userId))];
	const week = periodContaining(today, weekStartsOn);
	const [names, plans] = await Promise.all([
		namesOf(userIds),
		plansOf(scope, userIds, week.startsOn, week.endsOn, weekStartsOn, shares),
	]);
	const packageNames = new Map(packages.map((w) => [w.id, `${w.code} · ${w.name}`]));
	const ended = (s: Share) => s.endsOn !== null && s.endsOn < today;
	return shares
		.map((share) => ({
			id: share.id,
			userId: share.userId,
			name: names.get(share.userId) ?? "Former member",
			workPackageId: share.workPackageId,
			workPackage: share.workPackageId ? (packageNames.get(share.workPackageId) ?? null) : null,
			startsOn: share.startsOn,
			endsOn: share.endsOn,
			unit: share.unit,
			amount: amountText(share),
			field: amountField(share),
			weekPlanned: total(
				plans.get(share.userId)?.shares.find((s) => s.share.id === share.id)?.planned ?? [],
			),
			ended: ended(share),
		}))
		.sort((a, b) => {
			if (a.ended !== b.ended) return a.ended ? 1 : -1;
			if (a.ended) return (b.endsOn ?? "").localeCompare(a.endsOn ?? "");
			return (
				a.name.localeCompare(b.name, "en") ||
				(a.workPackage ?? "").localeCompare(b.workPackage ?? "", "en") ||
				a.startsOn.localeCompare(b.startsOn)
			);
		})
		.map(({ ended: _, ...listed }) => listed);
}
