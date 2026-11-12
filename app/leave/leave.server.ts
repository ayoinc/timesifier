import { env } from "cloudflare:workers";
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, record } from "~/activity/activity.server";
import { type OrganisationScope, organisationScope, type ScopedAccessor, users } from "~/db";
import { lockDateOf } from "~/locks/locks.server";
import {
	type Access,
	isAdministrator,
	mayCancelLeaveOf,
	mayChangeTimeOf,
	mayDecideLeaveOf,
	maySeeLeaveKindOf,
} from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { type Membership, viewerOf } from "~/organisations/membership.server";
import { nameOrEmail } from "~/organisations/people";
import { type Timetables, timetableFor, timetablesOf } from "~/schedules/schedules.server";
import { canSee } from "~/shell/destinations";
import { type Person, peopleOf } from "~/teams/people.server";
import { addDays, type Day, dayOf, daysFrom } from "~/time/calendar";
import { formatDayWithYear } from "~/time/format";

import {
	type Balance,
	balance,
	type DayStatus,
	dayStatuses,
	expectedMinutes,
	halfDaysByYear,
	halfDaysTaken,
	type LeaveCalendar,
	type LeaveRequestLike,
	type LeaveSpan,
	leaveMinutes,
	overlaps,
	type PersonStatus,
	personStatus,
} from "./days";
import {
	HOLIDAY_KIND,
	inKindOrder,
	KindKey,
	type LeaveKind,
	LeaveStatus,
	LONGEST_REQUEST_DAYS,
} from "./kinds";
import {
	daysLabel,
	earliestNoticed,
	heldToNotice,
	isShortNotice,
	noticeAsked,
	noticeGiven,
	noticeLabel,
	type ShortNoticeRule,
} from "./rules";

/**
 * Leave as the database holds it (TS-061): the organisation's kinds, working
 * week and public holidays, and the requests people make. The rules are in
 * `days.ts` and `access.ts`; this module reads what they take and writes what
 * they allow, always through the organisation's scope.
 */

/** The organisation's kinds of leave, in the order they are listed. */
export async function leaveKindsOf(scope: OrganisationScope): Promise<LeaveKind[]> {
	const rows = await scope.leaveKinds.select();
	return inKindOrder(
		rows.map((row) => ({
			id: row.id,
			key: KindKey.parse(row.key),
			name: row.name,
			enabled: row.enabled,
			needsApproval: row.needsApproval,
			allowanceHalfDays: row.allowanceHalfDays,
			noticeDays: row.noticeDays,
		})),
	);
}

export interface PublicHoliday {
	id: string;
	day: Day;
	name: string;
}

/** The organisation's public holidays from `first` to `last`, or all of them, by day. */
export async function publicHolidaysOf(
	scope: OrganisationScope,
	range?: { first: Day; last: Day },
): Promise<PublicHoliday[]> {
	const rows = await scope.publicHolidays.select(
		(h) => (range ? and(gte(h.day, range.first), lte(h.day, range.last)) : undefined),
		{ orderBy: (h) => [asc(h.day)] },
	);
	return rows.map(({ id, day, name }) => ({ id, day, name }));
}

/** A request with its kind, as the pages read it. */
export interface LeaveRequest extends LeaveRequestLike {
	id: string;
	kindId: string;
	note: string | null;
	comment: string | null;
	decidedBy: string | null;
	decidedAt: number | null;
	createdAt: number;
	/** Days from the day it was made to its first day (TS-090). */
	noticeDays: number;
	/** Whether it gave less notice than its kind asked for. */
	shortNotice: boolean;
	/** Why, when it was short. */
	noticeReason: string | null;
}

type LeaveRequests = OrganisationScope["leaveRequests"] extends ScopedAccessor<infer T> ? T : never;
type RequestRow = LeaveRequests["$inferSelect"];

function requestOf(row: RequestRow, kinds: readonly LeaveKind[]): LeaveRequest {
	const kind = kinds.find((k) => k.id === row.kindId);
	return {
		id: row.id,
		userId: row.userId,
		kindId: row.kindId,
		kindKey: kind?.key ?? "annual",
		kindName: kind?.name ?? "",
		startsOn: row.startsOn,
		endsOn: row.endsOn,
		startsHalf: row.startsHalf,
		endsHalf: row.endsHalf,
		status: LeaveStatus.parse(row.status),
		note: row.note,
		comment: row.comment,
		decidedBy: row.decidedBy,
		decidedAt: row.decidedAt?.getTime() ?? null,
		createdAt: row.createdAt.getTime(),
		noticeDays: row.noticeDays,
		shortNotice: row.shortNotice,
		noticeReason: row.noticeReason,
	};
}

/** What the rules of `days.ts` take for many people over a run of days, read in three queries and one more for leave. */
export interface LeaveContext {
	kinds: LeaveKind[];
	/** Each person's work schedule, day by day (TS-097). */
	timetables: Timetables;
	/** Public holidays in the run, by day; empty while public holidays are switched off. */
	holidays: Map<Day, string>;
	/** Approved requests of the people that touch the run. */
	approved: LeaveRequest[];
}

/** Everything the rules need about `userIds` from `first` to `last`. */
export async function leaveContext(
	scope: OrganisationScope,
	userIds: readonly string[],
	first: Day,
	last: Day,
): Promise<LeaveContext> {
	const ids = [...new Set(userIds)];
	const [kinds, timetables, holidays, rows] = await Promise.all([
		leaveKindsOf(scope),
		timetablesOf(scope, ids),
		publicHolidaysOf(scope, { first, last }),
		ids.length === 0
			? Promise.resolve([])
			: scope.leaveRequests.select((r) =>
					and(
						inArray(r.userId, ids),
						eq(r.status, "approved"),
						lte(r.startsOn, last),
						gte(r.endsOn, first),
					),
				),
	]);
	const holidaysOn = kinds.find((k) => k.key === HOLIDAY_KIND)?.enabled ?? true;
	return {
		kinds,
		timetables,
		holidays: new Map(holidaysOn ? holidays.map((h) => [h.day, h.name]) : []),
		approved: rows.map((row) => requestOf(row, kinds)),
	};
}

/** The calendar of one person out of a `LeaveContext`. */
export function calendarOf(context: LeaveContext, userId: string): LeaveCalendar {
	return {
		timetable: context.timetables(userId),
		holidays: context.holidays,
		leave: context.approved.filter((r) => r.userId === userId),
	};
}

/** One person's days from `first` to `last`: what each is, and the time expected on it. */
export async function daysOf(
	scope: OrganisationScope,
	userId: string,
	first: Day,
	last: Day,
): Promise<DayStatus[]> {
	const context = await leaveContext(scope, [userId], first, last);
	return dayStatuses(calendarOf(context, userId), daysFrom(first, last));
}

/** A kind's balance for the person, beside the kind. */
export interface KindBalance {
	kind: LeaveKind;
	balance: Balance;
}

/** The person's requests, latest first, and their balance of each kind in `year`. */
export async function myLeave(
	scope: OrganisationScope,
	userId: string,
	year: number,
): Promise<{ kinds: LeaveKind[]; requests: LeaveRequest[]; balances: KindBalance[] }> {
	const first = `${year}-01-01`;
	const last = `${year}-12-31`;
	const [kinds, timetable, holidays, rows] = await Promise.all([
		leaveKindsOf(scope),
		timetableFor(scope, userId),
		publicHolidaysOf(scope),
		scope.leaveRequests.select((r) => eq(r.userId, userId), {
			orderBy: (r) => [desc(r.startsOn), desc(r.createdAt)],
		}),
	]);
	const holidaysOn = kinds.find((k) => k.key === HOLIDAY_KIND)?.enabled ?? true;
	const calendar = {
		timetable,
		holidays: new Map(holidaysOn ? holidays.map((h) => [h.day, h.name]) : []),
	};
	const requests = rows.map((row) => requestOf(row, kinds));
	const balances = kinds
		.filter((kind) => kind.key !== HOLIDAY_KIND)
		.filter((kind) => kind.enabled || requests.some((r) => r.kindId === kind.id))
		.map((kind) => ({
			kind,
			balance: balance(
				kind.allowanceHalfDays,
				requests.filter((r) => r.kindId === kind.id && r.startsOn <= last && r.endsOn >= first),
				year,
				calendar,
			),
		}));
	return { kinds, requests, balances };
}

/**
 * The half days of a person's working days a span takes, by year: their
 * schedule's days on each day (TS-097). The calendar holds the public holidays of each whole year the span touches, as
 * the balance of those years counts the person's other requests against them.
 */
async function takenByYear(scope: OrganisationScope, userId: string, span: LeaveSpan) {
	const [kinds, timetable, holidays] = await Promise.all([
		leaveKindsOf(scope),
		timetableFor(scope, userId),
		publicHolidaysOf(scope, {
			first: `${span.startsOn.slice(0, 4)}-01-01`,
			last: `${span.endsOn.slice(0, 4)}-12-31`,
		}),
	]);
	const holidaysOn = kinds.find((k) => k.key === HOLIDAY_KIND)?.enabled ?? true;
	const calendar = {
		timetable,
		holidays: new Map(holidaysOn ? holidays.map((h) => [h.day, h.name]) : []),
	};
	return {
		kinds,
		calendar,
		byYear: halfDaysByYear(span, calendar),
		taken: halfDaysTaken(span, calendar),
	};
}

/** A request as a person makes it. */
export interface NewRequest extends LeaveSpan {
	kindId: string;
	note: string | null;
	/** Why it is asked for at short notice (TS-090); kept only when it is. */
	noticeReason: string | null;
}

/** When a request is made, as notice is counted (TS-090). */
export interface Asking {
	/** The day it is made, in the person's zone. */
	today: Day;
	/** Whether the organisation takes short notice with a reason, or refuses it. */
	shortNotice: ShortNoticeRule;
}

/** Why a request was not made, by the field it concerns. */
export type NotRequested =
	| { field: "kindId"; message: string }
	| { field: "endsOn"; message: string }
	| { field: "noticeReason"; message: string }
	| { field: "form"; message: string };

/**
 * Asks for leave for `userId`. A kind that needs no decision is approved at
 * once; any other waits. Refused for a kind switched off or the public
 * holidays, for days that hold no working day, for days that share one with
 * another of the person's pending or approved requests, and for more than the
 * kind's allowance leaves in a year. A request that gives less notice than
 * its kind asks (sick leave never does) needs a reason, and is refused where
 * the organisation does not take short notice (TS-090).
 */
export async function requestLeave(
	scope: OrganisationScope,
	userId: string,
	request: NewRequest,
	asking: Asking,
	now = new Date(),
): Promise<
	{ ok: true; status: LeaveStatus; alone: boolean } | { ok: false; problem: NotRequested }
> {
	const span: LeaveSpan = {
		startsOn: request.startsOn,
		endsOn: request.endsOn,
		startsHalf: request.startsHalf,
		endsHalf: request.endsOn > request.startsOn && request.endsHalf,
	};
	if (span.endsOn < span.startsOn) {
		return {
			ok: false,
			problem: { field: "endsOn", message: "The last day comes before the first." },
		};
	}
	const lockedThrough = await lockDateOf(scope.organisationId);
	if (lockedThrough !== null && span.startsOn <= lockedThrough) {
		return {
			ok: false,
			problem: {
				field: "form",
				message:
					"Some of these days are on or before the lock date, so leave cannot be asked for on them.",
			},
		};
	}
	if (daysFrom(span.startsOn, span.endsOn).length > LONGEST_REQUEST_DAYS) {
		return {
			ok: false,
			problem: {
				field: "endsOn",
				message: `A request is at most ${LONGEST_REQUEST_DAYS} days long.`,
			},
		};
	}
	const { kinds, calendar, byYear, taken } = await takenByYear(scope, userId, span);
	const kind = kinds.find((k) => k.id === request.kindId);
	if (!kind?.enabled || kind.key === HOLIDAY_KIND) {
		return { ok: false, problem: { field: "kindId", message: "Choose a kind of leave." } };
	}
	if (taken === 0) {
		return {
			ok: false,
			problem: { field: "endsOn", message: "These days hold no working day to take." },
		};
	}
	const noticeDays = noticeGiven(asking.today, span.startsOn);
	const short = isShortNotice(kind, asking.today, span.startsOn);
	const noticeReason = short ? request.noticeReason?.trim() || null : null;
	if (short && asking.shortNotice === "refused") {
		return {
			ok: false,
			problem: {
				field: "kindId",
				message: `${kind.name} needs ${noticeLabel({ noticeDays: noticeAsked(kind), shortNotice: false })} here: the earliest first day is ${formatDayWithYear(earliestNoticed(kind, asking.today))}.`,
			},
		};
	}
	if (short && noticeReason === null) {
		return {
			ok: false,
			problem: {
				field: "noticeReason",
				message: `This is short notice (${daysLabel(Math.max(0, noticeDays))}): say why in one line.`,
			},
		};
	}

	const holding = await scope.leaveRequests.select((r) =>
		and(
			eq(r.userId, userId),
			inArray(r.status, ["pending", "approved"]),
			lte(r.startsOn, span.endsOn),
			gte(r.endsOn, span.startsOn),
		),
	);
	if (holding.some((other) => overlaps(other, span))) {
		return {
			ok: false,
			problem: {
				field: "form",
				message: "You have already asked for leave on some of these days.",
			},
		};
	}

	if (kind.allowanceHalfDays !== null) {
		const years = [...byYear.keys()];
		const sameKind = await scope.leaveRequests.select((r) =>
			and(
				eq(r.userId, userId),
				eq(r.kindId, kind.id),
				inArray(r.status, ["pending", "approved"]),
				lte(r.startsOn, `${Math.max(...years)}-12-31`),
				gte(r.endsOn, `${Math.min(...years)}-01-01`),
			),
		);
		const theirs = sameKind.map((row) => ({ ...row, status: LeaveStatus.parse(row.status) }));
		for (const [year, halves] of byYear) {
			const { left } = balance(kind.allowanceHalfDays, theirs, year, calendar);
			if (left !== null && halves > left) {
				return {
					ok: false,
					problem: {
						field: "endsOn",
						message: `That is more ${kind.name.toLowerCase()} than you have left in ${year}.`,
					},
				};
			}
		}
	}

	const alone = kind.needsApproval && !(await someoneElseDecides(scope, userId));
	const status: LeaveStatus = kind.needsApproval && !alone ? "pending" : "approved";
	const [made] = await scope.leaveRequests.insert({
		userId,
		kindId: kind.id,
		...span,
		status,
		note: request.note,
		noticeDays,
		shortNotice: short,
		noticeReason,
		decidedAt: status === "approved" ? now : null,
		// Nobody but the person could decide it, so it is approved as it is made (TS-061).
		...(alone ? { decidedBy: userId, comment: APPROVED_ALONE } : {}),
	});
	if (made) {
		await record(
			scope,
			userId,
			"leave.requested",
			{ type: "leave", id: made.id, ownerId: userId },
			changes(null, made, LEAVE_FIELDS),
		);
	}
	return { ok: true, status, alone };
}

/** What the activity log records of a request for leave: never its note or comment's text. */
const LEAVE_FIELDS = ["kindId", "startsOn", "endsOn", "startsHalf", "endsHalf", "status"] as const;

/** Whether `row`'s days reach the lock date, so it can no longer change (TS-065). */
async function reachesLockDate(scope: OrganisationScope, row: { startsOn: Day }) {
	const lockedThrough = await lockDateOf(scope.organisationId);
	return lockedThrough !== null && row.startsOn <= lockedThrough;
}

/** Records a step on a request that has been taken. */
function recordStep(
	scope: OrganisationScope,
	actorId: string,
	action: "leave.withdrawn" | "leave.approved" | "leave.declined" | "leave.cancelled",
	row: { id: string; userId: string; status: string },
	status: string,
) {
	return record(
		scope,
		actorId,
		action,
		{ type: "leave", id: row.id, ownerId: row.userId },
		changes({ status: row.status }, { status }, ["status"]),
	);
}

/** The comment on a request approved as it was made because nobody else could decide it. */
export const APPROVED_ALONE = "Approved automatically: nobody else can decide it";

/**
 * Whether anybody but `userId` may decide their leave: another owner or admin,
 * or a manager of a team they are in other than themselves.
 */
export async function someoneElseDecides(
	scope: OrganisationScope,
	userId: string,
): Promise<boolean> {
	const [administrators, mine] = await Promise.all([
		scope.memberships.select(
			(m) => and(inArray(m.role, ["owner", "admin"]), ne(m.userId, userId)),
			{ limit: 1 },
		),
		scope.teamMembers.select((t) => eq(t.userId, userId)),
	]);
	if (administrators.length > 0) return true;
	if (mine.length === 0) return false;
	const managers = await scope.teamMembers.select(
		(t) =>
			and(
				inArray(
					t.teamId,
					mine.map((m) => m.teamId),
				),
				eq(t.isManager, true),
				ne(t.userId, userId),
			),
		{ limit: 1 },
	);
	return managers.length > 0;
}

/** What a step on a request came to. `locked`: its days reach the lock date (TS-065). */
export type Stepped = "done" | "missing" | "not-allowed" | "stale" | "locked";

async function requestRow(scope: OrganisationScope, id: string) {
	const [row] = await scope.leaveRequests.select((r) => eq(r.id, id), { limit: 1 });
	return row;
}

/** Withdraws a pending request of the person's own. */
export async function withdrawLeave(
	scope: OrganisationScope,
	access: Access,
	requestId: string,
): Promise<Stepped> {
	const row = await requestRow(scope, requestId);
	if (!row) return "missing";
	if (!mayChangeTimeOf(access, row.userId)) return "not-allowed";
	if (row.status !== "pending") return "stale";
	if (await reachesLockDate(scope, row)) return "locked";
	const changed = await scope.leaveRequests.update({ status: "withdrawn" }, (r) =>
		and(eq(r.id, row.id), eq(r.status, "pending")),
	);
	if (changed.length !== 1) return "stale";
	await recordStep(scope, access.userId, "leave.withdrawn", row, "withdrawn");
	return "done";
}

/** A decision on a pending request. */
export type LeaveDecision = { action: "approved" | "refused"; comment: string | null };

/** Approves or refuses a pending request, as `access`. A decided request is never decided again. */
export async function decideLeave(
	scope: OrganisationScope,
	access: Access,
	requestId: string,
	decision: LeaveDecision,
	now = new Date(),
): Promise<Stepped> {
	const row = await requestRow(scope, requestId);
	if (!row) return "missing";
	if (!mayDecideLeaveOf(access, row.userId)) return "not-allowed";
	if (row.status !== "pending") return "stale";
	if (await reachesLockDate(scope, row)) return "locked";
	const changed = await scope.leaveRequests.update(
		{
			status: decision.action,
			decidedBy: access.userId,
			decidedAt: now,
			comment: decision.comment,
		},
		(r) => and(eq(r.id, row.id), eq(r.status, "pending")),
	);
	if (changed.length !== 1) return "stale";
	await recordStep(
		scope,
		access.userId,
		decision.action === "approved" ? "leave.approved" : "leave.declined",
		row,
		decision.action,
	);
	return "done";
}

/**
 * Cancels an approved request that has not begun, as an owner or admin, with
 * the reason. `today` is the day in the zone of the person whose leave it is.
 */
export async function cancelLeave(
	scope: OrganisationScope,
	access: Access,
	requestId: string,
	reason: string,
	todayOf: (userId: string) => Promise<Day>,
	now = new Date(),
): Promise<Stepped> {
	const row = await requestRow(scope, requestId);
	if (!row) return "missing";
	if (!mayCancelLeaveOf(access, row.userId)) return "not-allowed";
	if (row.status !== "approved" || row.startsOn <= (await todayOf(row.userId))) return "stale";
	if (await reachesLockDate(scope, row)) return "locked";
	const changed = await scope.leaveRequests.update(
		{ status: "cancelled", decidedBy: access.userId, decidedAt: now, comment: reason },
		(r) => and(eq(r.id, row.id), eq(r.status, "approved")),
	);
	if (changed.length !== 1) return "stale";
	await recordStep(scope, access.userId, "leave.cancelled", row, "cancelled");
	return "done";
}

/** The people whose leave `access` decides: everyone else for an owner or admin, the members of their teams for a manager. */
export async function leaveDecidablePeople(
	scope: OrganisationScope,
	organisation: { timeZone: string },
	access: Access,
): Promise<Person[]> {
	const people = isAdministrator(access.role)
		? await peopleOf(scope, organisation)
		: await peopleOf(scope, organisation, access.managed);
	return people.filter((person) => mayDecideLeaveOf(access, person.id));
}

/** A request as the deciding pages list it: with its person, what it takes, and who decided it. */
export interface RequestToDecide extends LeaveRequest {
	person: Person;
	halfDays: number;
	decidedByName: string | null;
	/** Whether the viewer may cancel it now. */
	cancellable: boolean;
}

/**
 * The requests of `people` waiting for a decision, oldest first, and their
 * approved requests that have not begun, soonest first: what the Requests tab
 * of Time off lists.
 */
export async function requestsToDecide(
	scope: OrganisationScope,
	access: Access,
	people: readonly Person[],
	todayOf: (person: Person) => Day,
): Promise<{ pending: RequestToDecide[]; upcoming: RequestToDecide[] }> {
	const ids = people.map((p) => p.id);
	if (ids.length === 0) return { pending: [], upcoming: [] };
	const earliestToday = people.map(todayOf).sort()[0] ?? "0000-01-01";
	const [kinds, timetables, rows] = await Promise.all([
		leaveKindsOf(scope),
		timetablesOf(scope, ids),
		scope.leaveRequests.select(
			(r) =>
				and(
					inArray(r.userId, ids),
					inArray(r.status, ["pending", "approved"]),
					gte(r.endsOn, addDays(earliestToday, -366)),
				),
			{ orderBy: (r) => [asc(r.startsOn), asc(r.createdAt)] },
		),
	]);
	const first = rows.map((r) => r.startsOn).sort()[0];
	const last = rows
		.map((r) => r.endsOn)
		.sort()
		.at(-1);
	const holidays = first && last ? await publicHolidaysOf(scope, { first, last }) : [];
	const holidaysOn = kinds.find((k) => k.key === HOLIDAY_KIND)?.enabled ?? true;
	const holidaysByDay = new Map(holidaysOn ? holidays.map((h) => [h.day, h.name]) : []);
	const byId = new Map(people.map((p) => [p.id, p]));
	const deciders = await namesOf(rows.flatMap((r) => (r.decidedBy ? [r.decidedBy] : [])));
	const pending: RequestToDecide[] = [];
	const upcoming: RequestToDecide[] = [];
	for (const row of rows) {
		const person = byId.get(row.userId);
		if (!person) continue;
		const request = requestOf(row, kinds);
		const listed: RequestToDecide = {
			...request,
			person,
			halfDays: halfDaysTaken(request, {
				timetable: timetables(person.id),
				holidays: holidaysByDay,
			}),
			decidedByName: (row.decidedBy && deciders.get(row.decidedBy)) || null,
			cancellable: false,
		};
		if (request.status === "pending") {
			if (mayDecideLeaveOf(access, person.id)) pending.push(listed);
		} else if (request.startsOn > todayOf(person)) {
			upcoming.push({ ...listed, cancellable: mayCancelLeaveOf(access, person.id) });
		}
	}
	return { pending, upcoming };
}

async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
	const wanted = [...new Set(ids)];
	if (wanted.length === 0) return new Map();
	const rows = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(inArray(users.id, wanted));
	return new Map(rows.map((user) => [user.id, nameOrEmail(user)]));
}

/** How many requests wait for the decision of the person behind `membership`: part of the number on the Approvals link. */
export async function pendingLeaveOf(membership: Membership): Promise<number | null> {
	if (!canSee(viewerOf(membership), "approvals")) return null;
	const scope = organisationScope(env.DB, membership.organisation.id);
	const access = await accessOf(membership);
	const people = await leaveDecidablePeople(scope, membership.organisation, access);
	return countPending(scope, people);
}

/** How many requests of `people` wait for a decision: for leave, and for overtime and weekend work (TS-090). */
export async function countPending(
	scope: OrganisationScope,
	people: readonly Person[],
): Promise<number> {
	const ids = people.map((p) => p.id);
	if (ids.length === 0) return 0;
	const [[leave], [work]] = await Promise.all([
		scope.leaveRequests.sum(
			() => sqlOne,
			(r) => r.status,
			(r) => and(inArray(r.userId, ids), eq(r.status, "pending")),
		),
		scope.workRequests.sum(
			() => sqlOne,
			(w) => w.status,
			(w) => and(inArray(w.userId, ids), eq(w.status, "pending")),
		),
	]);
	return (leave?.total ?? 0) + (work?.total ?? 0);
}

/** One for each row: what `sum` adds up to count them. */
const sqlOne = sql<number>`1`;

/** What owners and admins change of a kind. Public holidays have no allowance and need no decision. */
export interface KindChange {
	name: string;
	enabled: boolean;
	needsApproval: boolean;
	allowanceHalfDays: number | null;
	/** Days of notice a request should give (TS-090); sick leave and public holidays keep none. */
	noticeDays: number;
}

/** Changes one of the organisation's kinds; false when it has no such kind. */
export async function changeKind(
	scope: OrganisationScope,
	kindId: string,
	change: KindChange,
): Promise<boolean> {
	const [row] = await scope.leaveKinds.select((k) => eq(k.id, kindId), { limit: 1 });
	if (!row) return false;
	const holiday = row.key === HOLIDAY_KIND;
	const changed = await scope.leaveKinds.update(
		{
			name: change.name,
			enabled: change.enabled,
			needsApproval: holiday ? false : change.needsApproval,
			allowanceHalfDays: holiday ? null : change.allowanceHalfDays,
			noticeDays: heldToNotice({ key: KindKey.parse(row.key) }) ? change.noticeDays : 0,
		},
		(k) => eq(k.id, row.id),
	);
	return changed.length === 1;
}

/** Adds a public holiday; false when the organisation already has one on that day. */
export async function addPublicHoliday(
	scope: OrganisationScope,
	holiday: { day: Day; name: string },
): Promise<boolean> {
	const existing = await scope.publicHolidays.select((h) => eq(h.day, holiday.day), { limit: 1 });
	if (existing.length > 0) return false;
	await scope.publicHolidays.insert(holiday);
	return true;
}

/** Removes a public holiday; false when the organisation has no such holiday. */
export async function removePublicHoliday(scope: OrganisationScope, id: string): Promise<boolean> {
	return (await scope.publicHolidays.delete((h) => eq(h.id, id))).length === 1;
}

/** One person's leave over a run of days, and where they stand now. */
export interface PersonLeave {
	/** Where they stand now, on their own today. */
	now: PersonStatus;
	/** Each day of the run. */
	days: DayStatus[];
	/** The minutes expected of them over the run. */
	expectedMinutes: number;
	/** The minutes of approved leave over the run: shown beside worked time, never counted in it. */
	leaveMinutes: number;
}

/**
 * The leave of each of `people` from `first` to `last`, and where each stands
 * at `now`, read in one go. The kind of their leave is named only where
 * `access` may see it (`maySeeLeaveKindOf`); `running` says whose timer runs.
 */
export async function leaveOfPeople(
	scope: OrganisationScope,
	access: Access,
	people: readonly Pick<Person, "id" | "timeZone">[],
	first: Day,
	last: Day,
	now: number,
	running: ReadonlySet<string> = new Set(),
): Promise<Map<string, PersonLeave>> {
	const todays = new Map(people.map((p) => [p.id, dayOf(now, p.timeZone)]));
	const all = [first, last, ...todays.values()].sort();
	const context = await leaveContext(
		scope,
		people.map((p) => p.id),
		all[0] ?? first,
		all.at(-1) ?? last,
	);
	const days = daysFrom(first, last);
	return new Map(
		people.map((person) => {
			const calendar = calendarOf(context, person.id);
			const kindVisible = maySeeLeaveKindOf(access, person.id);
			const shown = kindVisible
				? calendar
				: {
						...calendar,
						leave: calendar.leave.map((r) => ({ ...r, kindName: "On leave" })),
					};
			return [
				person.id,
				{
					now: personStatus(shown, todays.get(person.id) ?? first, {
						running: running.has(person.id),
						kindVisible,
					}),
					days: dayStatuses(shown, days),
					expectedMinutes: expectedMinutes(calendar, days),
					leaveMinutes: leaveMinutes(calendar, days),
				},
			];
		}),
	);
}

/** One approved stretch of a colleague's leave to come, as Time off lists it. */
export interface UpcomingLeave {
	id: string;
	person: string;
	/** The kind's name where the viewer may see it (`maySeeLeaveKindOf`); else "On leave". */
	kind: string;
	startsOn: Day;
	endsOn: Day;
	startsHalf: boolean;
	endsHalf: boolean;
}

/** How far ahead Time off lists the team's leave, in days. */
export const TEAM_LEAVE_AHEAD_DAYS = 42;

/**
 * The approved leave of the viewer's colleagues from `today` to
 * `TEAM_LEAVE_AHEAD_DAYS` later (TS-090), soonest first. Colleagues are the
 * people who share a team with the viewer and those they manage; everyone in
 * the organisation for an owner or admin, or for a person in no team. The
 * kind is named only where `access` may see it.
 */
export async function teamLeaveAhead(
	scope: OrganisationScope,
	organisation: { timeZone: string },
	access: Access,
	today: Day,
): Promise<UpcomingLeave[]> {
	let only: Set<string> | undefined;
	if (!isAdministrator(access.role)) {
		const mine = await scope.teamMembers.select((t) => eq(t.userId, access.userId));
		if (mine.length > 0) {
			const mates = await scope.teamMembers.select((t) =>
				inArray(
					t.teamId,
					mine.map((m) => m.teamId),
				),
			);
			only = new Set([...mates.map((m) => m.userId), ...access.managed]);
		}
	}
	only?.delete(access.userId);
	if (only?.size === 0) return [];
	const last = addDays(today, TEAM_LEAVE_AHEAD_DAYS);
	const [kinds, rows] = await Promise.all([
		leaveKindsOf(scope),
		scope.leaveRequests.select(
			(r) =>
				and(
					ne(r.userId, access.userId),
					only ? inArray(r.userId, [...only]) : undefined,
					eq(r.status, "approved"),
					lte(r.startsOn, last),
					gte(r.endsOn, today),
				),
			{ orderBy: (r) => [asc(r.startsOn)] },
		),
	]);
	const people = await peopleOf(
		scope,
		organisation,
		rows.map((r) => r.userId),
	);
	const names = new Map(people.map((p) => [p.id, p.name]));
	return rows.flatMap((row) => {
		const name = names.get(row.userId);
		if (!name) return [];
		const request = requestOf(row, kinds);
		return [
			{
				id: row.id,
				person: name,
				kind: maySeeLeaveKindOf(access, row.userId) ? request.kindName : "On leave",
				startsOn: row.startsOn,
				endsOn: row.endsOn,
				startsHalf: row.startsHalf,
				endsHalf: row.endsHalf,
			},
		];
	});
}

/**
 * How many requests for leave each of `userIds` made at short notice from
 * `first` to `last` (TS-090), counted by the day the leave starts, whatever
 * became of them but a withdrawal. Reports shows it per person.
 */
export async function shortNoticeCounts(
	scope: OrganisationScope,
	userIds: readonly string[],
	first: Day,
	last: Day,
): Promise<Map<string, number>> {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return new Map();
	const rows = await scope.leaveRequests.select((r) =>
		and(
			inArray(r.userId, ids),
			eq(r.shortNotice, true),
			ne(r.status, "withdrawn"),
			gte(r.startsOn, first),
			lte(r.startsOn, last),
		),
	);
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
	return counts;
}
