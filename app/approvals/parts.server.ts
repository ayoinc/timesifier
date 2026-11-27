import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { among, type OrganisationScope, type TenantRow } from "~/db";
import type { Day } from "~/time/calendar";

import { APPROVED_ALONE, type PartState, type PartStatus } from "./parts";

/**
 * The parts of submitted weeks (TS-117, decision 79), read and written: which
 * parts a week holds as it is submitted (`planParts`), who leads a project in
 * a week, and the SQL that keeps a period's status in step with its parts
 * (`weekStatusSql`). What a part is, and how a week's status follows its
 * parts, is `parts.ts`.
 */

export type PartRow = TenantRow<"periodParts">;
type Statement = Parameters<OrganisationScope["batch"]>[0][number];

/** A run of days, both included. */
export interface Span {
	startsOn: Day;
	endsOn: Day;
}

/** One person's week. */
export interface WeekRef extends Span {
	userId: string;
}

/** How `projectPartsOf` keys a week. */
export function weekKey(week: WeekRef): string {
	return `${week.userId} ${week.startsOn}`;
}

/** A delivery manager's stretch that overlaps `span`, for SQL: three readers. */
function overlapping(m: { startsOn: AnySQLiteColumn; endsOn: AnySQLiteColumn }, span: Span) {
	return and(lte(m.startsOn, span.endsOn), or(isNull(m.endsOn), gte(m.endsOn, span.startsOn)));
}

/** The projects `userId` is a delivery manager of at some time in `span`. */
export async function ledIn(
	scope: OrganisationScope,
	userId: string,
	span: Span,
): Promise<Set<string>> {
	const rows = await scope.projectMembers.select((m) =>
		and(eq(m.userId, userId), eq(m.role, "delivery_manager"), overlapping(m, span)),
	);
	return new Set(rows.map((row) => row.projectId));
}

/** The delivery managers of each of `projectIds` at some time in `span`, each list sorted. */
export async function deliveryManagersIn(
	scope: OrganisationScope,
	projectIds: readonly string[],
	span: Span,
): Promise<Map<string, string[]>> {
	const found = new Map<string, string[]>();
	if (projectIds.length === 0) return found;
	const rows = await scope.projectMembers.select((m) =>
		and(among(m.projectId, projectIds), eq(m.role, "delivery_manager"), overlapping(m, span)),
	);
	for (const row of rows) {
		const list = found.get(row.projectId) ?? [];
		if (!list.includes(row.userId)) list.push(row.userId);
		found.set(row.projectId, list);
	}
	for (const list of found.values()) list.sort();
	return found;
}

/**
 * The project parts of each of `weeks`, by `weekKey`: of the projects its
 * person logged time on in it, those with a client that have a delivery
 * manager at some time in the week, each with its delivery managers then
 * (the person among them, when they are one). A week with none has an empty
 * map: it is decided whole.
 */
export async function projectPartsOf(
	scope: OrganisationScope,
	weeks: readonly WeekRef[],
): Promise<Map<string, Map<string, string[]>>> {
	const found = new Map<string, Map<string, string[]>>(
		weeks.map((week) => [weekKey(week), new Map<string, string[]>()]),
	);
	if (weeks.length === 0) return found;
	const first = weeks.map((w) => w.startsOn).sort()[0] as Day;
	const last = weeks
		.map((w) => w.endsOn)
		.sort()
		.at(-1) as Day;
	// Which projects each person logged time on, on which day: one line each, added up by D1.
	const lines = await scope.timeEntries.sums(
		(e) => ({ userId: e.userId, projectId: e.projectId, spentOn: e.spentOn }),
		() => ({ entries: sql<number>`1` }),
		[["userId", "projectId", "spentOn"]],
		(e) =>
			and(
				among(e.userId, [...new Set(weeks.map((w) => w.userId))]),
				gte(e.spentOn, first),
				lte(e.spentOn, last),
			),
	);
	const projectIds = [...new Set(lines.map((line) => String(line.projectId)))];
	if (projectIds.length === 0) return found;
	const [clientProjects, managers] = await Promise.all([
		scope.projects.select((p) => and(among(p.id, projectIds), isNotNull(p.clientId))),
		scope.projectMembers.select((m) =>
			and(
				among(m.projectId, projectIds),
				eq(m.role, "delivery_manager"),
				overlapping(m, { startsOn: first, endsOn: last }),
			),
		),
	]);
	if (managers.length === 0) return found;
	const ofClients = new Set(clientProjects.map((p) => p.id));
	for (const week of weeks) {
		const parts = found.get(weekKey(week));
		if (!parts) continue;
		const logged = new Set(
			lines
				.filter(
					(line) =>
						line.userId === week.userId &&
						String(line.spentOn) >= week.startsOn &&
						String(line.spentOn) <= week.endsOn,
				)
				.map((line) => String(line.projectId)),
		);
		for (const projectId of [...logged].sort()) {
			if (!ofClients.has(projectId)) continue;
			const leaders = [
				...new Set(
					managers
						.filter(
							(m) =>
								m.projectId === projectId &&
								m.startsOn <= week.endsOn &&
								(m.endsOn === null || m.endsOn >= week.startsOn),
						)
						.map((m) => m.userId),
				),
			].sort();
			if (leaders.length > 0) parts.set(projectId, leaders);
		}
	}
	return found;
}

/** The parts of each of `periodIds`, the line part first, then by project. */
export async function partsOf(
	scope: OrganisationScope,
	periodIds: readonly string[],
): Promise<Map<string, PartRow[]>> {
	const found = new Map<string, PartRow[]>();
	if (periodIds.length === 0) return found;
	const rows = await scope.periodParts.select((p) => among(p.periodId, [...new Set(periodIds)]));
	for (const row of rows) found.set(row.periodId, [...(found.get(row.periodId) ?? []), row]);
	for (const list of found.values()) {
		list.sort((a, b) =>
			a.projectId === b.projectId
				? 0
				: a.projectId === null
					? -1
					: b.projectId === null
						? 1
						: a.projectId.localeCompare(b.projectId),
		);
	}
	return found;
}

/** A part waiting for a decision once a week is submitted, for who is told. */
export interface WaitingPart {
	/** The project of a project part; null for the line part. */
	projectId: string | null;
	/** A project part's delivery managers in the week; empty for the line part. */
	deliveryManagers: string[];
}

/** What submitting a week does to its parts: see `planParts`. */
export interface PlannedParts {
	/** The writes, after the period's own: parts added, made to wait again, approved alone, or gone. */
	statements: Statement[];
	/** Whether the week is held in parts; when not, it is decided whole, as before TS-117. */
	held: boolean;
	/** Its parts once written; empty when it is not held in parts. */
	parts: PartState[];
	/** Of those, the ones that wait for somebody. */
	waiting: WaitingPart[];
}

/**
 * The parts of `week`, the period `periodId`, as it is submitted at `at`
 * (TS-117, decision 79): the line part and a part for each project part
 * (`projectPartsOf`), or none. A part approved before stays approved, as its
 * entries could not change; one returned waits again; a project part new to
 * the week is added; one whose time has all gone is removed. A part nobody but
 * its person may decide is approved by the system (D5, decision 47): the line
 * part when `lineAlone`, a project part when its person is its only delivery
 * manager and no other owner or admin is there. `known`: the period is on
 * record, so it may have parts already.
 */
export async function planParts(
	scope: OrganisationScope,
	{
		periodId,
		known,
		week,
		lineAlone,
		at,
	}: { periodId: string; known: boolean; week: WeekRef; lineAlone: boolean; at: Date },
): Promise<PlannedParts> {
	const [projects, existing] = await Promise.all([
		projectPartsOf(scope, [week]).then((found) => found.get(weekKey(week)) ?? new Map()),
		known ? scope.periodParts.select((p) => eq(p.periodId, periodId)) : Promise.resolve([]),
	]);
	if (projects.size === 0) {
		return {
			statements:
				existing.length === 0
					? []
					: [scope.periodParts.statements.delete((p) => eq(p.periodId, periodId))],
			held: false,
			parts: [],
			waiting: [],
		};
	}
	const onlyTheirs = (leaders: readonly string[]) => leaders.every((id) => id === week.userId);
	const otherAdministrator = [...projects.values()].some(onlyTheirs)
		? (
				await scope.memberships.select(
					(m) => and(inArray(m.role, ["owner", "admin"]), ne(m.userId, week.userId)),
					{ limit: 1 },
				)
			).length > 0
		: true;
	const keys: (string | null)[] = [null, ...[...projects.keys()].sort()];
	const statements: Statement[] = [];
	const parts: PartState[] = [];
	const waiting: WaitingPart[] = [];
	for (const projectId of keys) {
		const row = existing.find((r) => r.projectId === projectId);
		if (row?.status === "approved") {
			parts.push({ projectId, status: "approved" });
			continue;
		}
		const leaders: string[] = projectId === null ? [] : (projects.get(projectId) ?? []);
		const alone = projectId === null ? lineAlone : !otherAdministrator && onlyTheirs(leaders);
		const status: PartStatus = alone ? "approved" : "submitted";
		const values = {
			status,
			decidedBy: null,
			decidedAt: alone ? at : null,
			comment: alone ? APPROVED_ALONE : null,
		};
		statements.push(
			row
				? scope.periodParts.statements.update(values, (p) => eq(p.id, row.id))
				: scope.periodParts.statements.insert({ periodId, projectId, ...values }),
		);
		if (alone) {
			statements.push(
				scope.periodEvents.statements.insert({
					periodId,
					action: "approved",
					actorId: null,
					comment: APPROVED_ALONE,
					part: projectId === null ? "line" : "project",
					projectId,
				}),
			);
		} else {
			waiting.push({ projectId, deliveryManagers: leaders });
		}
		parts.push({ projectId, status });
	}
	const gone = existing.filter((r) => r.status !== "approved" && !keys.includes(r.projectId));
	if (gone.length > 0) {
		statements.push(
			scope.periodParts.statements.delete((p) =>
				among(
					p.id,
					gone.map((r) => r.id),
				),
			),
		);
	}
	return { statements, held: true, parts, waiting };
}

/**
 * The status of the period `periodId` as its parts stand when the statement
 * runs, for SQL: returned while any part is, submitted while any waits,
 * approved once every part is (`weekStatusOf`). Read in the batch that
 * changes a part, after it, so two approvers deciding two parts at once leave
 * the period where both decisions put it.
 */
export function weekStatusSql(scope: OrganisationScope, periodId: string) {
	const any = (status: PartStatus) =>
		scope.periodParts.exists((p) => and(eq(p.periodId, periodId), eq(p.status, status)));
	return sql<string>`case when ${any("returned")} then 'returned' when ${any("submitted")} then 'submitted' else 'approved' end`;
}
