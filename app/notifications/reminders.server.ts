import { env } from "cloudflare:workers";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { onLeaveToday } from "~/approvals/approvals.server";
import { among, type OrganisationScope, organisationScope, organisations, users } from "~/db";
import { dayRulesOf } from "~/leave/rules.server";
import { deadlineOf, latestDeadlinePassed, nextDeadline } from "~/locks/deadline";
import { locksEntries, PeriodStatus, periodContaining, periodOfWeek } from "~/periods/periods";
import { destinationPath } from "~/shell/destinations";
import { addDays, type Day, dayOf, instantAt } from "~/time/calendar";
import { formatDay, formatDayAndTime, formatDuration, formatRange } from "~/time/format";
import { zoneOf } from "~/time/zones";
import { dayPath, weekPath } from "~/timesheet/views";

import { REMINDER_HOUR } from "./kinds";
import { decidersOf } from "./notify.server";
import { type NewNotification, notificationStatements, pathBelow } from "./words";

/**
 * The reminders (TS-049, decision 69), run every hour by the scheduled
 * handler. Each goes to a person at most once in its period, the unique key
 * of its row says which: a day (`timer:2026-11-16`), a deadline
 * (`deadline:2026-11-23`) or a day of an approver's (`approvals:2026-11-17`).
 * Each is timed in the person's own zone, and none goes to a person on leave
 * all of today where they are.
 *
 * - A timer running past the regular hours its day takes, once a day.
 * - The deadline: at the last `REMINDER_HOUR` o'clock where the person is
 *   that falls at least an hour before it, for the weeks it covers that they
 *   have not submitted.
 * - Weeks waiting for an approver since before their today, once a day from
 *   `REMINDER_HOUR` o'clock to `LAST_HOUR` o'clock where they are.
 */

/** The hour, where an approver is, after which a day's reminder of weeks waiting is no longer sent. */
const LAST_HOUR = 18;

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

/** Each organisation's reminders at `now`. */
export async function runReminders(now: number): Promise<void> {
	const rows: Organisation[] = await drizzle(env.DB)
		.select({
			id: organisations.id,
			timeZone: organisations.timeZone,
			weekStartsOn: organisations.weekStartsOn,
			deadlineKind: organisations.deadlineKind,
			deadlineDay: organisations.deadlineDay,
			deadlineTime: organisations.deadlineTime,
		})
		.from(organisations);
	for (const organisation of rows) {
		const scope = organisationScope(env.DB, organisation.id);
		const reminders = [
			...(await timerReminders(scope, organisation, now)),
			...(await deadlineReminders(scope, organisation, now)),
			...(await approvalsReminders(scope, organisation, now)),
		];
		const [first, ...rest] = notificationStatements(scope, reminders);
		if (first) await scope.batch([first, ...rest]);
	}
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

/** A timer running past the regular hours its day takes, to its person, once for that day. */
async function timerReminders(
	scope: OrganisationScope,
	organisation: Organisation,
	now: number,
): Promise<NewNotification[]> {
	const running = await scope.timeEntries.select((e) => isNull(e.endedAt));
	if (running.length === 0) return [];
	const present = new Set(
		await presentOf(
			scope,
			running.map((e) => e.userId),
			organisation,
			now,
		),
	);
	const made: NewNotification[] = [];
	for (const entry of running) {
		if (!present.has(entry.userId)) continue;
		const day = entry.spentOn;
		const entries = await scope.timeEntries.select((e) =>
			and(eq(e.userId, entry.userId), eq(e.spentOn, day)),
		);
		const [rule] = await dayRulesOf(
			scope,
			entry.userId,
			[day],
			entries.map((e) => ({ ...e, day: e.spentOn })),
			now,
		);
		if (!rule || rule.limitMinutes === null || rule.trackedMinutes <= rule.limitMinutes) continue;
		made.push({
			userId: entry.userId,
			kind: "timer-reminder",
			title: `Your timer is still running on ${formatDay(day)}, past the hours the day takes.`,
			body: `${formatDuration(rule.trackedMinutes * 60)} tracked; the day takes ${formatDuration(rule.limitMinutes * 60)}. Stop it, or correct it, if you have finished.`,
			path: pathBelow((slug) => dayPath(slug, day)),
			key: `timer:${day}`,
		});
	}
	return made;
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

/** To each approver with weeks waiting for them since before their today, once that day. */
async function approvalsReminders(
	scope: OrganisationScope,
	organisation: Organisation,
	now: number,
): Promise<NewNotification[]> {
	const waiting = await scope.periods.select((p) => eq(p.status, "submitted"));
	if (waiting.length === 0) return [];
	const deciders = await decidersOf(
		scope,
		waiting.map((p) => p.userId),
		now,
	);
	const approvers = [...new Set([...deciders.values()].flat())];
	const [zones, present] = await Promise.all([
		zonesOf(approvers, organisation),
		presentOf(scope, approvers, organisation, now),
	]);
	const made: NewNotification[] = [];
	for (const approver of present) {
		const zone = zones.get(approver) ?? organisation.timeZone;
		const today = dayOf(now, zone);
		if (now < instantAt(today, REMINDER_HOUR * 60, zone)) continue;
		if (now >= instantAt(today, LAST_HOUR * 60, zone)) continue;
		const since = instantAt(today, 0, zone);
		const theirs = waiting.filter(
			(p) =>
				deciders.get(p.userId)?.includes(approver) &&
				p.submittedAt !== null &&
				p.submittedAt.getTime() < since,
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
