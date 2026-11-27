import { env, withEnv } from "cloudflare:workers";
import { and, asc, eq, gt, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { onLeaveToday } from "~/approvals/approvals.server";
import { partsOf } from "~/approvals/parts.server";
import {
	among,
	countedDatabase,
	isQueriesSpent,
	leaveReminderPass,
	type OrganisationScope,
	organisationScope,
	organisations,
	QueryBudget,
	type ReminderPass,
	remindableOrganisations,
	takeReminderPass,
	users,
} from "~/db";
import { dayRulesOf } from "~/leave/rules.server";
import { deadlineOf, latestDeadlinePassed, nextDeadline } from "~/locks/deadline";
import { locksEntries, PeriodStatus, periodContaining, periodOfWeek } from "~/periods/periods";
import { destinationPath } from "~/shell/destinations";
import { addDays, type Day, dayOf, instantAt } from "~/time/calendar";
import { formatDay, formatDayAndTime, formatDuration, formatRange } from "~/time/format";
import { zoneOf } from "~/time/zones";
import { dayPath, weekPath } from "~/timesheet/views";

import { REMINDER_HOUR } from "./kinds";
import { decidersOf, projectDecidersOf } from "./notify.server";
import { type NewNotification, notificationStatements, pathBelow } from "./words";

/**
 * The reminders (TS-049, decision 69). Each goes to a person at most once in
 * its period, the unique key of its row says which: a day
 * (`timer:2026-11-16`), a deadline (`deadline:2026-11-23`) or a day of an
 * approver's (`approvals:2026-11-17`). Each is due at or after its moment,
 * timed in the person's own zone, so one a run did not reach is sent by a
 * later run in its period; none goes to a person on leave all of today where
 * they are.
 *
 * - A timer running past the regular hours its day takes, once for that day.
 * - The deadline: from the last `REMINDER_HOUR` o'clock where the person is
 *   that falls at least an hour before it, until the deadline, for the weeks
 *   it covers that they have not submitted.
 * - Weeks waiting for an approver since before their today, once that day,
 *   from `REMINDER_HOUR` o'clock where they are.
 *
 * The scheduled work runs them every minute but the hour's first (the hourly
 * run does, after the duties that come first), each run within its share of
 * the invocation's queries, `REMINDER_QUERIES_PER_RUN`. A pass checks every
 * organisation with work once; it starts in each hour once the one before is
 * finished, and each run goes on from where the last stopped (`reminderPass`).
 */

/**
 * The most D1 queries one run of the reminders makes: 300 of the 1,000 one
 * invocation may make on Workers Paid. The duties before it keep 700: in the
 * every-minute run, a step of an export of everything takes up to 400 of
 * them (TS-126, decision 71), the webhooks and the mail the rest.
 */
export const REMINDER_QUERIES_PER_RUN = 300;

/** How long a run holds the pass: one that dies holding it holds it no longer, and the next run takes it. */
export const REMINDER_LEASE_MS = 2 * 60 * 1000;

/** How long a run starts new items for: half its lease, so it lets the pass go long before the lease runs out. */
const RUN_MS = REMINDER_LEASE_MS / 2;

/**
 * The queries a run keeps for one more item, its write included: one with
 * fewer left stops before it. Measured on 2026-11-24: an organisation's own
 * reminders, its deadline and weeks waiting, make about 22, whatever its
 * size; a running timer about 10 (`test/notifications/reminders-pass.test.ts`).
 * Should one make more, the first query past the share is refused all the same.
 */
const ITEM_QUERIES = 30;

const HOUR_MS = 60 * 60 * 1000;

/** What a run reads of an organisation. */
interface Organisation {
	id: string;
	timeZone: string;
	weekStartsOn: number;
	deadlineKind: string;
	deadlineDay: number | null;
	deadlineTime: string | null;
}

/** Where a pass stands: what is written back when a run lets it go. */
type Stands = Pick<ReminderPass, "startedAt" | "lastOrganisation" | "lastEntry" | "finishedAt">;

/**
 * What a run did: `idle` when it did not take the pass (another run holds
 * it, or this hour's pass is finished), `stopped` when it used its share or
 * its time before the pass's end, `finished` when it reached it; and the
 * queries it made.
 */
export interface RemindersRun {
	outcome: "idle" | "stopped" | "finished";
	queries: number;
}

/**
 * One run of the reminders at `now`, making at most `cap` queries. Only
 * organisations with work are read (decision 69): a timer running or a week
 * waiting, each found through a partial index, or a deadline; and of those
 * with a deadline, only one due within a day reads anything more.
 */
export async function runReminders(
	now: number,
	cap = REMINDER_QUERIES_PER_RUN,
): Promise<RemindersRun> {
	// One query is kept back for letting the pass go.
	const budget = new QueryBudget(cap - 1);
	const outcome = (await withEnv({ ...env, DB: countedDatabase(env.DB, budget) }, () =>
		remind(now, budget),
	)) as RemindersRun["outcome"];
	return { outcome, queries: budget.spent };
}

async function remind(now: number, budget: QueryBudget): Promise<RemindersRun["outcome"]> {
	const token = crypto.randomUUID();
	const hour = now - (now % HOUR_MS);
	const pass = await takeReminderPass(env.DB, {
		token,
		now,
		leasedUntil: now + REMINDER_LEASE_MS,
		hour,
	});
	if (!pass) return "idle";
	const stands: Stands =
		pass.finishedAt === null
			? { ...pass, finishedAt: null }
			: { startedAt: hour, lastOrganisation: null, lastEntry: null, finishedAt: null };
	const started = Date.now();
	const room = () => budget.left >= ITEM_QUERIES && Date.now() - started < RUN_MS;
	let outcome: RemindersRun["outcome"] = "stopped";
	try {
		if (await walk(now, stands, room)) {
			stands.finishedAt = now;
			outcome = "finished";
		}
	} catch (error) {
		if (!isQueriesSpent(error)) throw error;
	} finally {
		budget.extend(1);
		await leaveReminderPass(env.DB, token, {
			startedAt: stands.startedAt,
			lastOrganisation: stands.lastOrganisation,
			lastEntry: stands.lastEntry,
			finishedAt: stands.finishedAt,
		});
	}
	return outcome;
}

/**
 * Goes on with the pass from where it `stands`, item by item while there is
 * `room`, moving `stands` past each item done. True when it reached the end.
 */
async function walk(now: number, stands: Stands, room: () => boolean): Promise<boolean> {
	if (!room()) return false;
	const { timing, waiting } = await remindableOrganisations(env.DB);
	const from = stands.lastOrganisation;
	const rows: Organisation[] = await drizzle(env.DB)
		.select({
			id: organisations.id,
			timeZone: organisations.timeZone,
			weekStartsOn: organisations.weekStartsOn,
			deadlineKind: organisations.deadlineKind,
			deadlineDay: organisations.deadlineDay,
			deadlineTime: organisations.deadlineTime,
		})
		.from(organisations)
		.where(
			and(
				or(
					ne(organisations.deadlineKind, "none"),
					among(organisations.id, [...timing, ...waiting]),
				),
				from === null ? undefined : gte(organisations.id, from),
			),
		)
		.orderBy(asc(organisations.id));
	for (const organisation of rows) {
		const scope = organisationScope(env.DB, organisation.id);
		if (organisation.id !== stands.lastOrganisation) {
			if (!room()) return false;
			await item(scope, async () => [
				...(await deadlineReminders(scope, organisation, now)),
				...(waiting.has(organisation.id) ? await approvalsReminders(scope, organisation, now) : []),
			]);
			stands.lastOrganisation = organisation.id;
			stands.lastEntry = "";
		}
		if (!timing.has(organisation.id)) continue;
		if (!room()) return false;
		const after = stands.lastEntry ?? "";
		const timers = await isolated(scope, () => runningTimers(scope, organisation, now, after), []);
		for (const timer of timers) {
			if (!room()) return false;
			await item(scope, () => timerReminder(scope, timer, now));
			stands.lastEntry = timer.id;
		}
	}
	return true;
}

/**
 * `work`, of one organisation: when it fails it is logged and skipped, so
 * one organisation's failure holds no other back. Running out of queries
 * stops the run instead.
 */
async function isolated<T>(
	scope: OrganisationScope,
	work: () => Promise<T>,
	otherwise: T,
): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (isQueriesSpent(error)) throw error;
		console.error(
			`reminders: organisation ${scope.organisationId} failed with ${error instanceof Error ? error.name : "unknown"}`,
		);
		return otherwise;
	}
}

/** One item of a pass: the reminders `make` makes, written in one batch. */
async function item(
	scope: OrganisationScope,
	make: () => Promise<NewNotification[]>,
): Promise<void> {
	await isolated(
		scope,
		async () => {
			const [first, ...rest] = notificationStatements(scope, await make());
			if (first) await scope.batch([first, ...rest]);
		},
		undefined,
	);
}

/** Where each of `userIds` is: their own zone, or the organisation's. */
async function zonesOf(
	userIds: readonly string[],
	organisation: { timeZone: string },
): Promise<Map<string, string>> {
	if (userIds.length === 0) return new Map();
	const rows = await drizzle(env.DB)
		.select({ id: users.id, timeZone: users.timeZone })
		.from(users)
		.where(among(users.id, userIds));
	return new Map(rows.map((row) => [row.id, zoneOf(row, organisation)]));
}

/** Those of `userIds` who are there today: not on leave all of it (D6, decision 48, as reminders read it). */
async function presentOf(
	scope: OrganisationScope,
	userIds: readonly string[],
	organisation: { timeZone: string },
	now: number,
): Promise<string[]> {
	const away = await onLeaveToday(scope, userIds, organisation, now);
	return [...new Set(userIds)].filter((id) => !away.has(id));
}

/** A running timer a pass checks. */
interface Running {
	id: string;
	userId: string;
	spentOn: Day;
}

/**
 * The organisation's running timers after `after`, in the order of their
 * ids, each one whose person is there today and has not yet been reminded of
 * it: a timer reminded of costs nothing more for the rest of its day.
 */
async function runningTimers(
	scope: OrganisationScope,
	organisation: Organisation,
	now: number,
	after: string,
): Promise<Running[]> {
	const running = await scope.timeEntries.select((e) => and(isNull(e.endedAt), gt(e.id, after)), {
		orderBy: (e) => [asc(e.id)],
	});
	if (running.length === 0) return [];
	const people = running.map((e) => e.userId);
	const [told, present] = await Promise.all([
		scope.notifications.select((n) =>
			and(
				eq(n.kind, "timer-reminder"),
				among(n.userId, people),
				among(
					n.key,
					running.map((e) => `timer:${e.spentOn}`),
				),
			),
		),
		presentOf(scope, people, organisation, now),
	]);
	const done = new Set(told.map((n) => `${n.userId} ${n.key}`));
	const here = new Set(present);
	return running.filter((e) => here.has(e.userId) && !done.has(`${e.userId} timer:${e.spentOn}`));
}

/** A timer running past the regular hours its day takes, to its person, once for that day. */
async function timerReminder(
	scope: OrganisationScope,
	timer: Running,
	now: number,
): Promise<NewNotification[]> {
	const day = timer.spentOn;
	const entries = await scope.timeEntries.select((e) =>
		and(eq(e.userId, timer.userId), eq(e.spentOn, day)),
	);
	const [rule] = await dayRulesOf(
		scope,
		timer.userId,
		[day],
		entries.map((e) => ({ ...e, day: e.spentOn })),
		now,
	);
	if (!rule || rule.limitMinutes === null || rule.trackedMinutes <= rule.limitMinutes) return [];
	return [
		{
			userId: timer.userId,
			kind: "timer-reminder",
			title: `Your timer is still running on ${formatDay(day)}, past the hours the day takes.`,
			body: `${formatDuration(rule.trackedMinutes * 60)} tracked; the day takes ${formatDuration(rule.limitMinutes * 60)}. Stop it, or correct it, if you have finished.`,
			path: pathBelow((slug) => dayPath(slug, day)),
			key: `timer:${day}`,
		},
	];
}

/**
 * When the deadline reminder for the deadline at `deadline` goes to a person
 * in `zone`: the last `REMINDER_HOUR` o'clock there at least an hour before it.
 */
export function deadlineReminderAt(deadline: number, zone: string): number {
	const latest = deadline - HOUR_MS;
	let day = dayOf(latest, zone);
	while (instantAt(day, REMINDER_HOUR * 60, zone) > latest) day = addDays(day, -1);
	return instantAt(day, REMINDER_HOUR * 60, zone);
}

/**
 * The weeks the deadline on `day` covers: those with a day from the deadline
 * before it, `previous`, to the day before this one, oldest first. A week
 * that starts on the deadline's day is the next deadline's.
 */
function weeksDue(
	organisation: Organisation,
	day: Day,
	previous: Day | null,
): { startsOn: Day; endsOn: Day }[] {
	const weeks = [];
	let week = periodContaining(previous ?? addDays(day, -7), organisation.weekStartsOn);
	// A deadline covers a month at most: never more than six weeks.
	while (weeks.length < 6 && week.startsOn < day) {
		weeks.push(week);
		week = periodContaining(addDays(week.endsOn, 1), organisation.weekStartsOn);
	}
	return weeks;
}

/** Before the deadline, to each person with a week it covers that they have not submitted. */
async function deadlineReminders(
	scope: OrganisationScope,
	organisation: Organisation,
	now: number,
): Promise<NewNotification[]> {
	const deadline = deadlineOf(organisation);
	if (deadline.kind === "none") return [];
	const day = nextDeadline(deadline, organisation.timeZone, now);
	if (day === null) return [];
	const [hours, minutes] = deadline.time.split(":").map(Number) as [number, number];
	const at = instantAt(day, hours * 60 + minutes, organisation.timeZone);
	// No reminder is due more than a day and an hour before its deadline, wherever its person is.
	if (at - now > 25 * HOUR_MS) return [];
	const previous = latestDeadlinePassed(deadline, organisation.timeZone, at - 1);
	const weeks = weeksDue(organisation, day, previous);
	const first = weeks[0];
	if (!first) return [];
	const members = await scope.memberships.select();
	const zones = await zonesOf(
		members.map((m) => m.userId),
		organisation,
	);
	const due = members.filter(
		(m) => now >= deadlineReminderAt(at, zones.get(m.userId) ?? organisation.timeZone),
	);
	if (due.length === 0) return [];
	const present = new Set(
		await presentOf(
			scope,
			due.map((m) => m.userId),
			organisation,
			now,
		),
	);
	const last = weeks.at(-1) ?? first;
	const rows = await scope.periods.select((p) =>
		and(
			among(
				p.userId,
				due.map((m) => m.userId),
			),
			lte(p.startsOn, last.endsOn),
			gte(p.endsOn, first.startsOn),
		),
	);
	const made: NewNotification[] = [];
	for (const member of due) {
		if (!present.has(member.userId)) continue;
		const joined = dayOf(member.createdAt, zones.get(member.userId) ?? organisation.timeZone);
		const open = weeks.filter((week) => {
			if (week.endsOn < joined) return false;
			const { row } = periodOfWeek(
				rows.filter((r) => r.userId === member.userId),
				week,
			);
			return !locksEntries(row ? PeriodStatus.parse(row.status) : null);
		});
		const [oldest] = open;
		if (!oldest) continue;
		const when = formatDayAndTime(at, zones.get(member.userId) ?? organisation.timeZone);
		made.push({
			userId: member.userId,
			kind: "deadline-reminder",
			title:
				open.length === 1
					? `Your timesheet for ${formatRange(oldest.startsOn, oldest.endsOn)} is due by ${when}.`
					: `${open.length} of your timesheets, from ${formatRange(oldest.startsOn, oldest.endsOn)}, are due by ${when}.`,
			path: pathBelow((slug) => weekPath(slug, oldest.startsOn)),
			key: `deadline:${day}`,
		});
	}
	return made;
}

/**
 * To each approver with weeks, or parts of weeks (TS-117), waiting for them
 * since before their today, once that day: due from `REMINDER_HOUR` o'clock
 * where they are, so one a run did not reach goes later that day. A week
 * decided whole, and the line part of one held in parts, wait for its
 * person's deciders (`decidersOf`); a project part for its project's
 * (`projectDecidersOf`).
 */
async function approvalsReminders(
	scope: OrganisationScope,
	organisation: Organisation,
	now: number,
): Promise<NewNotification[]> {
	const periods = await scope.periods.select((p) => inArray(p.status, ["submitted", "returned"]));
	if (periods.length === 0) return [];
	const parts = await partsOf(
		scope,
		periods.map((p) => p.id),
	);
	// Each thing waiting: a week decided whole, or a part of one; `projectId` null for the rest of a week.
	const waiting = periods.flatMap((period) => {
		const list = parts.get(period.id);
		if (!list) return period.status === "submitted" ? [{ period, projectId: null }] : [];
		return list
			.filter((part) => part.status === "submitted")
			.map((part) => ({ period, projectId: part.projectId }));
	});
	if (waiting.length === 0) return [];
	const ofProjects = waiting.flatMap((w) =>
		w.projectId === null ? [] : [{ ...w, projectId: w.projectId }],
	);
	const stretches =
		ofProjects.length === 0
			? []
			: await scope.projectMembers.select((m) =>
					and(
						among(
							m.projectId,
							ofProjects.map((w) => w.projectId),
						),
						eq(m.role, "delivery_manager"),
					),
				);
	const [deciders, partDeciders] = await Promise.all([
		decidersOf(
			scope,
			waiting.filter((w) => w.projectId === null).map((w) => w.period.userId),
			now,
		),
		projectDecidersOf(
			scope,
			ofProjects.map(({ period, projectId }) => ({
				personId: period.userId,
				deliveryManagers: stretches
					.filter(
						(s) =>
							s.projectId === projectId &&
							s.startsOn <= period.endsOn &&
							(s.endsOn === null || s.endsOn >= period.startsOn),
					)
					.map((s) => s.userId),
			})),
			now,
		),
	]);
	const decidersFor = (w: (typeof waiting)[number]) =>
		w.projectId === null
			? (deciders.get(w.period.userId) ?? [])
			: (partDeciders[
					ofProjects.findIndex((p) => p.period === w.period && p.projectId === w.projectId)
				] ?? []);
	const approvers = [...new Set(waiting.flatMap(decidersFor))];
	const [zones, present] = await Promise.all([
		zonesOf(approvers, organisation),
		presentOf(scope, approvers, organisation, now),
	]);
	const made: NewNotification[] = [];
	for (const approver of present) {
		const zone = zones.get(approver) ?? organisation.timeZone;
		const today = dayOf(now, zone);
		if (now < instantAt(today, REMINDER_HOUR * 60, zone)) continue;
		const since = instantAt(today, 0, zone);
		const theirs = waiting.filter(
			(w) =>
				decidersFor(w).includes(approver) &&
				w.period.submittedAt !== null &&
				w.period.submittedAt.getTime() < since,
		);
		if (theirs.length === 0) continue;
		made.push({
			userId: approver,
			kind: "approvals-reminder",
			title:
				theirs.length === 1
					? "1 timesheet has waited for your approval since before today."
					: `${theirs.length} timesheets have waited for your approval since before today.`,
			path: pathBelow((slug) => destinationPath(slug, "approvals")),
			key: `approvals:${today}`,
		});
	}
	return made;
}
