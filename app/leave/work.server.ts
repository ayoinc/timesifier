import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";

import { changes, recordStatement, recordStatementWhen } from "~/activity/activity.server";
import { workRefusersOf } from "~/approvals/refusals.server";
import { among, type OrganisationScope, type ScopedAccessor, uuidv7 } from "~/db";
import {
	type Access,
	mayApproveAfterRefusals,
	mayCancelLeaveOf,
	mayChangeTimeOf,
	mayDecideLeaveOf,
} from "~/organisations/access";
import type { Person } from "~/teams/people.server";
import { addDays, type Day, daysFrom } from "~/time/calendar";
import { LeaveStatus, LONGEST_REQUEST_DAYS } from "./kinds";
import {
	APPROVED_ALONE,
	calendarOf,
	type LeaveDecision,
	leaveContext,
	type Stepped,
	someoneElseDecides,
} from "./leave.server";
import {
	MOST_WORK_MINUTES_A_DAY,
	mayAskFor,
	type TimesheetRules,
	WORK_KIND_LABELS,
	WorkKind,
	workDays,
} from "./rules";

/**
 * Requests for overtime and weekend work (TS-090), where the organisation
 * allows them only with pre-approval. They are asked for on Time off and
 * decided as leave is: by a manager of a team the person is in, an owner or
 * an admin, never by the person; a person nobody else can decide for has
 * theirs approved as they are made. Approved, they raise the limit of each
 * day they cover (`rules.ts`).
 */

/** A request for overtime or weekend work, as the pages read it. */
export interface WorkRequest {
	id: string;
	userId: string;
	kind: WorkKind;
	startsOn: Day;
	endsOn: Day;
	minutesPerDay: number;
	reason: string | null;
	status: LeaveStatus;
	comment: string | null;
	decidedBy: string | null;
	createdAt: number;
}

type WorkRequests = OrganisationScope["workRequests"] extends ScopedAccessor<infer T> ? T : never;
type WorkRow = WorkRequests["$inferSelect"];

function workOf(row: WorkRow): WorkRequest {
	return {
		id: row.id,
		userId: row.userId,
		kind: WorkKind.parse(row.kind),
		startsOn: row.startsOn,
		endsOn: row.endsOn,
		minutesPerDay: row.minutesPerDay,
		reason: row.reason,
		status: LeaveStatus.parse(row.status),
		comment: row.comment,
		decidedBy: row.decidedBy,
		createdAt: row.createdAt.getTime(),
	};
}

/** A request as a person makes it. */
export interface NewWork {
	kind: WorkKind;
	startsOn: Day;
	endsOn: Day;
	minutesPerDay: number;
	reason: string | null;
}

/** Why a request was not made, by the field it concerns. */
export type NotAsked = {
	field: "kind" | "endsOn" | "minutesPerDay" | "form";
	message: string;
};

/**
 * Asks for overtime or weekend work for `userId`. Refused while the
 * organisation allows it freely or not at all, for days it does not apply to
 * (overtime on working days, weekend work on days not worked), and for days
 * another of the person's pending or approved requests of the kind covers.
 */
export async function requestWork(
	scope: OrganisationScope,
	userId: string,
	request: NewWork,
	rules: Pick<TimesheetRules, "overtime" | "weekend">,
	now = new Date(),
): Promise<{ ok: true; status: LeaveStatus; alone: boolean } | { ok: false; problem: NotAsked }> {
	const label = WORK_KIND_LABELS[request.kind];
	if (!mayAskFor(rules, request.kind)) {
		const open = request.kind === "overtime" || rules.weekend !== "none";
		return {
			ok: false,
			problem: {
				field: "kind",
				message:
					rules.overtime === "allowed" && open
						? `${label} needs no approval here.`
						: `${label} is not allowed in this organisation.`,
			},
		};
	}
	if (request.endsOn < request.startsOn) {
		return {
			ok: false,
			problem: { field: "endsOn", message: "The last day comes before the first." },
		};
	}
	if (daysFrom(request.startsOn, request.endsOn).length > LONGEST_REQUEST_DAYS) {
		return {
			ok: false,
			problem: {
				field: "endsOn",
				message: `A request is at most ${LONGEST_REQUEST_DAYS} days long.`,
			},
		};
	}
	if (request.minutesPerDay < 1 || request.minutesPerDay > MOST_WORK_MINUTES_A_DAY) {
		return {
			ok: false,
			problem: {
				field: "minutesPerDay",
				message: `Type the hours a day, more than none and at most ${MOST_WORK_MINUTES_A_DAY / 60}.`,
			},
		};
	}
	const context = await leaveContext(scope, [userId], request.startsOn, request.endsOn);
	if (workDays(calendarOf(context, userId), request.kind, request).length === 0) {
		return {
			ok: false,
			problem: {
				field: "endsOn",
				message: {
					overtime: "These days hold no working day to work over.",
					weekend:
						"These days hold no day off: weekend work is for days the working week does not work.",
					holiday: "These days hold no public holiday.",
				}[request.kind],
			},
		};
	}
	const holding = await scope.workRequests.select(
		(w) =>
			and(
				eq(w.userId, userId),
				eq(w.kind, request.kind),
				inArray(w.status, ["pending", "approved"]),
				lte(w.startsOn, request.endsOn),
				gte(w.endsOn, request.startsOn),
			),
		{ limit: 1 },
	);
	if (holding.length > 0) {
		return {
			ok: false,
			problem: {
				field: "form",
				message: `You have already asked for ${label.toLowerCase()} on some of these days.`,
			},
		};
	}
	const alone = !(await someoneElseDecides(scope, userId));
	const status: LeaveStatus = alone ? "approved" : "pending";
	const id = uuidv7();
	const made = {
		id,
		userId,
		kind: request.kind,
		startsOn: request.startsOn,
		endsOn: request.endsOn,
		minutesPerDay: request.minutesPerDay,
		reason: request.reason,
		status,
		...(alone ? { decidedBy: userId, decidedAt: now, comment: APPROVED_ALONE } : {}),
	};
	await scope.batch([
		scope.workRequests.statements.insert(made),
		recordStatement(
			scope,
			userId,
			"work_request.requested",
			{ type: "work_request", id, ownerId: userId },
			changes(null, made, WORK_FIELDS),
		),
	]);
	return { ok: true, status, alone };
}

/** What the activity log records of a request for work (TR-11): never its reason's or comment's text. */
const WORK_FIELDS = ["kind", "startsOn", "endsOn", "minutesPerDay", "status"] as const;

/**
 * Moves a request from `from` to the change's status, recorded as `action`
 * with before and after in the same batch (TR-11): the record lands only when
 * the request still stood at `from`. Answers whether it moved.
 */
async function stepWork(
	scope: OrganisationScope,
	actorId: string,
	row: WorkRow,
	from: LeaveStatus,
	change: Partial<WorkRow> & { status: LeaveStatus },
	action:
		| "work_request.withdrawn"
		| "work_request.approved"
		| "work_request.declined"
		| "work_request.cancelled",
): Promise<Stepped> {
	const [, changed] = await scope.batch([
		recordStatementWhen(
			scope,
			scope.workRequests.exists((w) => and(eq(w.id, row.id), eq(w.status, from))),
			actorId,
			action,
			{ type: "work_request", id: row.id, ownerId: row.userId },
			changes({ kind: row.kind, status: row.status }, { kind: row.kind, status: change.status }, [
				"kind",
				"status",
			]),
		),
		scope.workRequests.statements.update(change, (w) => and(eq(w.id, row.id), eq(w.status, from))),
	]);
	return changed.length === 1 ? "done" : "stale";
}

async function workRow(scope: OrganisationScope, id: string) {
	const [row] = await scope.workRequests.select((w) => eq(w.id, id), { limit: 1 });
	return row;
}

/** Withdraws a pending request of the person's own. */
export async function withdrawWork(
	scope: OrganisationScope,
	access: Access,
	requestId: string,
): Promise<Stepped> {
	const row = await workRow(scope, requestId);
	if (!row) return "missing";
	if (!mayChangeTimeOf(access, row.userId)) return "not-allowed";
	if (row.status !== "pending") return "stale";
	return stepWork(
		scope,
		access.userId,
		row,
		"pending",
		{ status: "withdrawn" },
		"work_request.withdrawn",
	);
}

/** Approves or refuses a pending request, as `access`: whoever decides the person's leave. */
export async function decideWork(
	scope: OrganisationScope,
	access: Access,
	requestId: string,
	decision: LeaveDecision,
	now = new Date(),
): Promise<Stepped> {
	const row = await workRow(scope, requestId);
	if (!row) return "missing";
	if (!mayDecideLeaveOf(access, row.userId)) return "not-allowed";
	if (row.status !== "pending") return "stale";
	if (
		decision.action === "approved" &&
		!mayApproveAfterRefusals(access, await workRefusersOf(scope, row))
	) {
		return "refused-before";
	}
	return stepWork(
		scope,
		access.userId,
		row,
		"pending",
		{
			status: decision.action,
			decidedBy: access.userId,
			decidedAt: now,
			comment: decision.comment,
		},
		decision.action === "approved" ? "work_request.approved" : "work_request.declined",
	);
}

/** Cancels an approved request that has not begun, as an owner or admin, with the reason. */
export async function cancelWork(
	scope: OrganisationScope,
	access: Access,
	requestId: string,
	reason: string,
	todayOf: (userId: string) => Promise<Day>,
	now = new Date(),
): Promise<Stepped> {
	const row = await workRow(scope, requestId);
	if (!row) return "missing";
	if (!mayCancelLeaveOf(access, row.userId)) return "not-allowed";
	if (row.status !== "approved" || row.startsOn <= (await todayOf(row.userId))) return "stale";
	return stepWork(
		scope,
		access.userId,
		row,
		"approved",
		{ status: "cancelled", decidedBy: access.userId, decidedAt: now, comment: reason },
		"work_request.cancelled",
	);
}

/** How many of a person's requests Time off lists. */
const MINE_LISTED = 50;

/** The person's requests for overtime and weekend work, latest first. */
export async function myWork(scope: OrganisationScope, userId: string): Promise<WorkRequest[]> {
	const rows = await scope.workRequests.select((w) => eq(w.userId, userId), {
		orderBy: (w) => [desc(w.startsOn), desc(w.createdAt)],
		limit: MINE_LISTED,
	});
	return rows.map(workOf);
}

/** A request as the deciding pages list it, with its person. */
export interface WorkToDecide extends WorkRequest {
	person: Person;
	/** Whether the viewer may cancel it now. */
	cancellable: boolean;
}

/**
 * The requests of `people` waiting for a decision of `access`, oldest first,
 * and their approved requests that have not begun, soonest first.
 */
export async function workToDecide(
	scope: OrganisationScope,
	access: Access,
	people: readonly Person[],
	todayOf: (person: Person) => Day,
): Promise<{ pending: WorkToDecide[]; upcoming: WorkToDecide[] }> {
	const ids = people.map((p) => p.id);
	if (ids.length === 0) return { pending: [], upcoming: [] };
	const earliestToday = people.map(todayOf).sort()[0] ?? "0000-01-01";
	const rows = await scope.workRequests.select(
		(w) =>
			and(
				among(w.userId, ids),
				inArray(w.status, ["pending", "approved"]),
				gte(w.endsOn, addDays(earliestToday, -366)),
			),
		{ orderBy: (w) => [asc(w.startsOn), asc(w.createdAt)] },
	);
	const byId = new Map(people.map((p) => [p.id, p]));
	const pending: WorkToDecide[] = [];
	const upcoming: WorkToDecide[] = [];
	for (const row of rows) {
		const person = byId.get(row.userId);
		if (!person) continue;
		const request = workOf(row);
		if (request.status === "pending") {
			if (mayDecideLeaveOf(access, person.id)) {
				pending.push({ ...request, person, cancellable: false });
			}
		} else if (request.startsOn > todayOf(person)) {
			upcoming.push({ ...request, person, cancellable: mayCancelLeaveOf(access, person.id) });
		}
	}
	return { pending, upcoming };
}
