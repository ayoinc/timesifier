import { env } from "cloudflare:workers";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as z from "zod";

import { type ActivitySummary, type ActivityValue, type OrganisationScope, users } from "~/db";
import { NON_WORKING_RULE_LABELS, OVERTIME_RULE_LABELS, SHORT_NOTICE_LABELS } from "~/leave/rules";
import { activityScopeOf, type TimeScope } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import type { Membership } from "~/organisations/membership.server";
import { nameOrEmail } from "~/organisations/people";
import { addDays, bounds, Day, dayOf, daysFrom } from "~/time/calendar";
import { formatDayWithYear, formatDuration, formatRange, formatTime } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";

import { ActivityAction, ActivitySource, SubjectType } from "./actions";
import { REDACTED } from "./activity.server";
import { SYSTEM } from "./log";

/**
 * The activity log as people read it (TS-072): the records of a range of days,
 * newest first, narrowed by kind, project, who performed them and whose they
 * are, each put into words. Who reads which records is `activityScopeOf`: an
 * owner, admin or Finance every record; a team manager the records about
 * their own and their teams' people; anyone else their own. Records about the
 * organisation's own things, which are nobody's, are read by those who read
 * everything. The query takes the scope to SQL; nothing is filtered after.
 */

/** The longest range one page or one export covers. */
export const LONGEST_LOG_DAYS = 366;

const Optional = <T extends z.ZodType>(schema: T) =>
	z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** The filters as the address carries them. Anything else in it is ignored. */
const LogQuery = z.object({
	from: Optional(Day),
	to: Optional(Day),
	kind: Optional(SubjectType),
	project: Optional(z.string().max(64)),
	actor: Optional(z.string().max(64)),
	owner: Optional(z.string().max(64)),
});
export type LogQuery = z.infer<typeof LogQuery>;

/** The filters of an address, or null when one of them is not one this page knows. */
export function parseLogQuery(params: URLSearchParams): LogQuery | null {
	const parsed = LogQuery.safeParse(Object.fromEntries(params));
	return parsed.success ? parsed.data : null;
}

/** One record as a page and the export show it. */
export interface LogRow {
	id: string;
	/** When, as an instant, and in the viewer's zone. */
	at: number;
	when: string;
	/** Who performed it: a name, or "Timesifier" for the system. */
	actor: string;
	source: ActivitySource;
	action: ActivityAction;
	/** What was done, in words: "Changed project Website". */
	what: string;
	/** Whose record it is, or null for the organisation's own things. */
	owner: string | null;
	/** Each changed field: its label, what it was and what it became. */
	changes: { field: string; before: string; after: string }[];
	/** The changes in one line: "Project: Website → Launch · End: 12 Nov 2026, 17:00". */
	changesText: string;
	subjectType: SubjectType;
	subjectId: string;
}

/** What a log is read for. */
export interface LogRequest {
	scope: OrganisationScope;
	/** Whose records the viewer reads. */
	visible: TimeScope;
	zone: string;
	first: Day;
	last: Day;
	query: LogQuery;
}

/**
 * The records `membership` asks for with `query`, at `now`: a range of
 * `query.from` to `query.to` in the viewer's zone, the last 30 days by default.
 * Null for a range that ends before it starts or is longer than a year.
 */
export async function logRequest(
	membership: Membership,
	query: LogQuery,
	now: number,
	scope: OrganisationScope,
): Promise<LogRequest | null> {
	const [access, zone] = await Promise.all([accessOf(membership), zoneOfMember(membership)]);
	const today = dayOf(now, zone);
	const last = query.to ?? today;
	const first = query.from ?? addDays(last, -29);
	if (first > last || daysFrom(first, last).length > LONGEST_LOG_DAYS) return null;
	return { scope, visible: activityScopeOf(access), zone, first, last, query };
}

/** Where a page of records ends: the last record it held, so the next starts after it. */
export interface LogCursor {
	at: Date;
	id: string;
}

/** The records of a request, newest first: `limit` of them, those after `after` when it is given. */
export async function logRecords(log: LogRequest, limit: number, after?: LogCursor) {
	const { scope, visible, zone, first, last, query } = log;
	const { from, to } = bounds(first, last, zone);
	return scope.activityRecords.select(
		(r) =>
			and(
				gte(r.createdAt, new Date(from)),
				lt(r.createdAt, new Date(to)),
				after === undefined
					? undefined
					: or(lt(r.createdAt, after.at), and(eq(r.createdAt, after.at), lt(r.id, after.id))),
				visible.everyone ? undefined : inArray(r.ownerId, visible.people),
				query.kind === undefined ? undefined : eq(r.subjectType, query.kind),
				query.actor === undefined
					? undefined
					: query.actor === SYSTEM
						? isNull(r.actorId)
						: eq(r.actorId, query.actor),
				query.owner === undefined ? undefined : eq(r.ownerId, query.owner),
				query.project === undefined
					? undefined
					: or(
							and(inArray(r.subjectType, ["project", "budget"]), eq(r.subjectId, query.project)),
							sql`json_extract(${r.summary}, '$.before.projectId') = ${query.project}`,
							sql`json_extract(${r.summary}, '$.after.projectId') = ${query.project}`,
						),
			),
		{ orderBy: (r) => [desc(r.createdAt), desc(r.id)], limit },
	);
}

/** The records of one subject that `visible` may read, oldest first: an entry's history. */
export function subjectRecords(
	scope: OrganisationScope,
	visible: TimeScope,
	subject: { type: SubjectType; id: string },
) {
	return scope.activityRecords.select(
		(r) =>
			and(
				eq(r.subjectType, subject.type),
				eq(r.subjectId, subject.id),
				visible.everyone ? undefined : inArray(r.ownerId, visible.people),
			),
		{ orderBy: (r) => [r.createdAt, r.id] },
	);
}

/** A record as the log reads it. */
interface RecordRow {
	id: string;
	actorId: string | null;
	ownerId: string | null;
	source: string;
	action: string;
	subjectType: string;
	subjectId: string;
	summary: ActivitySummary;
	createdAt: Date;
}

/** What "<verb> <noun>" each step reads as. */
const STEPS: Record<string, string> = {
	created: "Created",
	updated: "Changed",
	deleted: "Deleted",
	started: "Started",
	stopped: "Stopped",
	submitted: "Submitted",
	withdrawn: "Withdrew",
	approved: "Approved",
	returned: "Returned",
	reopened: "Reopened",
	renamed: "Renamed",
	archived: "Archived",
	restored: "Restored",
	client_changed: "Changed the client of",
	role_changed: "Changed the role of",
	contractor_changed: "Changed the contractor status of",
	removed: "Removed",
	cancelled: "Cancelled",
	member_added: "Added a member to",
	member_removed: "Removed a member from",
	manager_changed: "Changed a manager of",
	sent: "Sent",
	voided: "Voided",
	accepted: "Recorded as accepted",
	declined: "Declined",
	recorded: "Recorded",
	requested: "Requested",
	changed: "Changed",
	revoked: "Revoked",
	imported: "Imported",
	reverted: "Reverted",
	assigned: "Assigned",
};

/** What each kind of thing an action names is called in a sentence. */
const NOUNS: Record<string, string> = {
	time_entry: "a time entry",
	period: "a week",
	project: "project",
	client: "client",
	membership: "member",
	invitation: "an invitation",
	team: "team",
	task: "task",
	rate: "a rate",
	budget: "the budget of project",
	expense: "an expense",
	expense_category: "expense category",
	retainer: "a retainer",
	recurring_invoice: "a recurring invoice",
	invoice: "invoice",
	estimate: "estimate",
	payment: "a payment",
	leave: "leave",
	lock_date: "the lock date",
	deadline: "the timesheet deadline",
	api_token: "an API token",
	webhook: "a webhook",
	import: "an import",
	timesheet_rules: "the timesheet rules",
	work_schedule: "work schedule",
	brand: "the brand",
};

/** How a changed field is named. Any other is shown by its own name. */
const FIELD_LABELS: Record<string, string> = {
	projectId: "Project",
	clientId: "Client",
	taskId: "Task",
	kindId: "Kind of leave",
	description: "Description",
	notes: "Notes",
	comment: "Comment",
	startedAt: "Start",
	endedAt: "End",
	name: "Name",
	status: "Status",
	role: "Role",
	isContractor: "Contractor",
	isManager: "Manager",
	archived: "Archived",
	lockedThrough: "Lock date",
	reason: "Reason",
	startsOn: "First day",
	endsOn: "Last day",
	startsHalf: "Starts at midday",
	endsHalf: "Ends at midday",
	deadlineKind: "Deadline",
	deadlineDay: "Deadline day",
	deadlineTime: "Deadline time",
	autoLockDays: "Auto-lock after (days)",
	autoSubmitAtLock: "Auto-submit",
	amountMinor: "Amount",
	currency: "Currency",
	effectiveFrom: "From",
	unitName: "Unit",
	unitPriceMinor: "Unit price",
	userId: "Person",
	budgetKind: "Budget",
	budgetAmount: "Budget amount",
	billingContact: "Billing contact",
	line: "Line",
	frequency: "Frequency",
	paymentTermsDays: "Payment terms (days)",
	tags: "Tags",
	overtime: "Overtime",
	weekend: "Weekend and non-working days",
	overtimeDayCap: "Overtime cap a day",
	overtimeWeekCap: "Overtime cap a week",
	shortNotice: "Short notice",
	days: "Days",
	weekMinutes: "Hours a week",
	scheduleId: "Schedule",
	teamId: "Team",
	organisation: "Organisation",
	logo: "Logo",
	colour: "Colour",
};

/** The values of the timesheet rules, in words (TS-095). */
const RULE_VALUES: Record<string, Record<string, string>> = {
	overtime: OVERTIME_RULE_LABELS,
	weekend: NON_WORKING_RULE_LABELS,
	shortNotice: SHORT_NOTICE_LABELS,
};

/** The names a page shows for the ids its records hold. */
interface Names {
	people: Map<string, string>;
	things: Map<string, string>;
}

/** The names of the people and things `records` name, read in a few queries. */
async function namesOf(scope: OrganisationScope, records: readonly RecordRow[]): Promise<Names> {
	const people = new Set<string>();
	const ids = new Set<string>();
	for (const r of records) {
		if (r.actorId) people.add(r.actorId);
		if (r.ownerId) people.add(r.ownerId);
		ids.add(r.subjectId);
		for (const side of [r.summary.before, r.summary.after]) {
			for (const [key, value] of Object.entries(side ?? {})) {
				if (key === "userId" && typeof value === "string") people.add(value);
				else if (key === "tags" && typeof value === "string") {
					for (const tag of value.split(",")) if (tag !== "") ids.add(tag);
				} else if (key.endsWith("Id") && typeof value === "string") ids.add(value);
			}
		}
	}
	const list = [...ids];
	const [accounts, projects, clients, teams, kinds, categories, tags, schedules] =
		await Promise.all([
			people.size === 0
				? []
				: drizzle(env.DB)
						.select({ id: users.id, name: users.name, email: users.email })
						.from(users)
						.where(inArray(users.id, [...people])),
			list.length === 0 ? [] : scope.projects.select((p) => inArray(p.id, list)),
			list.length === 0 ? [] : scope.clients.select((c) => inArray(c.id, list)),
			list.length === 0 ? [] : scope.teams.select((t) => inArray(t.id, list)),
			list.length === 0 ? [] : scope.leaveKinds.select((k) => inArray(k.id, list)),
			list.length === 0 ? [] : scope.expenseCategories.select((c) => inArray(c.id, list)),
			list.length === 0 ? [] : scope.tags.select((t) => inArray(t.id, list)),
			list.length === 0 ? [] : scope.workSchedules.select((s) => inArray(s.id, list)),
		]);
	return {
		people: new Map(accounts.map((a) => [a.id, nameOrEmail(a)])),
		things: new Map(
			[...projects, ...clients, ...teams, ...kinds, ...categories, ...tags, ...schedules].map(
				(thing) => [thing.id, thing.name],
			),
		),
	};
}

/**
 * An instant as the log writes it in `zone`: the day with its year, since the
 * log reaches back two years, and the time, "Thursday 12 November 2026 at 14:05".
 */
export function when(instant: number, zone: string): string {
	return `${formatDayWithYear(dayOf(instant, zone))} at ${formatTime(instant, zone)}`;
}

/** One value of a changed field in words. */
function valueText(key: string, value: ActivityValue | undefined, names: Names, zone: string) {
	if (value === undefined || value === null || value === "") return "none";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (key.endsWith("At") && typeof value === "number") return when(value, zone);
	// An expense's tags: comma-joined ids, read as the tags' names.
	if (key === "tags" && typeof value === "string") {
		return value
			.split(",")
			.map((id) => names.things.get(id) ?? "a deleted tag")
			.join(", ");
	}
	if (typeof value === "string" && RULE_VALUES[key]?.[value]) return RULE_VALUES[key][value];
	if ((key.endsWith("Cap") || key === "weekMinutes") && typeof value === "number")
		return formatDuration(value * 60);
	if (key.endsWith("Id") && typeof value === "string") {
		return names.things.get(value) ?? names.people.get(value) ?? "a deleted one";
	}
	if ((key.endsWith("On") || key === "lockedThrough") && typeof value === "string") {
		return Day.safeParse(value).success ? formatRange(value, value) : value;
	}
	return String(value);
}

/**
 * The changed fields of a summary, each in words. A redacted field's text is
 * never shown: it reads "added", "changed" or "removed".
 */
function changesOf(summary: ActivitySummary, names: Names, zone: string) {
	const before = summary.before ?? {};
	const after = summary.after ?? {};
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
	return keys.map((key) => {
		const field = FIELD_LABELS[key] ?? key;
		if (before[key] === REDACTED || after[key] === REDACTED) {
			const what = !(key in before) ? "added" : !(key in after) ? "removed" : "changed";
			return { field, before: "none", after: `${what} (not shown)` };
		}
		return {
			field,
			before: valueText(key, before[key], names, zone),
			after: valueText(key, after[key], names, zone),
		};
	});
}

/** What an action did, in words, with the thing's name where it has one. */
function whatOf(r: RecordRow, names: Names): string {
	const action = ActivityAction.parse(r.action);
	const [prefix = "", step = ""] = action.split(".");
	const verb = STEPS[step] ?? step;
	const noun = NOUNS[prefix] ?? prefix;
	const named =
		names.things.get(r.subjectId) ??
		(typeof r.summary.after?.name === "string" ? r.summary.after.name : undefined) ??
		(typeof r.summary.before?.name === "string" ? r.summary.before.name : undefined);
	if (action === "time_entry.started") return "Started the timer";
	if (action === "time_entry.stopped") return "Stopped the timer";
	if (action === "time_entry.split") return "Split a time entry at the day's expected hours";
	if (prefix === "membership" && r.ownerId) {
		return `${verb} ${names.people.get(r.ownerId) ?? "a former member"}`;
	}
	return named && !noun.startsWith("a") ? `${verb} ${noun} ${named}` : `${verb} ${noun}`;
}

/** The changes, and the same in one line. */
function withText(changes: LogRow["changes"]) {
	const changesText = changes
		.map(({ field, before, after }) =>
			before === "none" ? `${field}: ${after}` : `${field}: ${before} → ${after}`,
		)
		.join(" · ");
	return { changes, changesText };
}

/** The records in words, for `zone`. */
export async function logRows(
	scope: OrganisationScope,
	records: readonly RecordRow[],
	zone: string,
): Promise<LogRow[]> {
	const names = await namesOf(scope, records);
	return records.map((r) => ({
		id: r.id,
		at: r.createdAt.getTime(),
		when: when(r.createdAt.getTime(), zone),
		actor: r.actorId === null ? "Timesifier" : (names.people.get(r.actorId) ?? "A former member"),
		source: ActivitySource.parse(r.source),
		action: ActivityAction.parse(r.action),
		what: whatOf(r, names),
		owner: r.ownerId === null ? null : (names.people.get(r.ownerId) ?? "A former member"),
		...withText(changesOf(r.summary, names, zone)),
		subjectType: SubjectType.parse(r.subjectType),
		subjectId: r.subjectId,
	}));
}
