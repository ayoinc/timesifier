import type { OrganisationScope, ScopedStatement } from "~/db";
import { WORK_KIND_LABELS, type WorkKind } from "~/leave/rules";
import { projectPath } from "~/projects/projects";
import { destinationPath, organisationPath } from "~/shell/destinations";
import type { Day } from "~/time/calendar";
import { formatDay, formatRange } from "~/time/format";
import { dayPath, weekPath } from "~/timesheet/views";

import type { NotificationKind } from "./kinds";

/**
 * The words of each notification, for the one person it is for (TS-049,
 * decision 68), and the writes that add them. A person is told of their own
 * week or request, and the reason given for it, which they see on their
 * timesheet and on Time off; the decider is not named. Who is told that
 * something waits is `decidersOf` (`notify.server.ts`).
 */

/** One notification for one person, before it is written. */
export interface NewNotification {
	userId: string;
	kind: NotificationKind;
	title: string;
	body?: string | null;
	/** Below the organisation's address: see `pathBelow`. */
	path: string;
	/** The period a reminder is for: one is written per person and key. */
	key?: string;
}

/** A slug no organisation has, for building an address and keeping what follows the organisation. */
const ANY_SLUG = "_";

/** What follows the organisation's address in the address `build` makes: `/approvals`, `?view=week&start=…`. */
export function pathBelow(build: (slug: string) => string): string {
	return build(ANY_SLUG).slice(organisationPath(ANY_SLUG).length);
}

/** The writes that add `notifications`, for a batch; one with a key is added unless it is there already. */
export function notificationStatements(
	scope: OrganisationScope,
	notifications: readonly NewNotification[],
): ScopedStatement<unknown>[] {
	return notifications.map(({ userId, kind, title, body = null, path, key }) => {
		const row = { userId, kind, title, body, path, key: key ?? null, emailState: "waiting" };
		return key
			? scope.notifications.statements.insertIfAbsent(row)
			: scope.notifications.statements.insert(row);
	});
}

/** A week of a person, for its notifications. */
export interface WeekOf {
	userId: string;
	startsOn: Day;
	endsOn: Day;
}

/** The words of a week's decision to its person, with the reason given for a return or a reopening. */
export function weekDecided(
	week: WeekOf,
	decision: "approved" | "returned" | "reopened",
	comment: string | null,
): NewNotification {
	const words = formatRange(week.startsOn, week.endsOn);
	const title =
		decision === "approved"
			? `Your timesheet for ${words} was approved.`
			: decision === "returned"
				? `Your timesheet for ${words} was returned to you.`
				: `Your timesheet for ${words} was reopened.`;
	return {
		userId: week.userId,
		kind: "week-decided",
		title,
		body: comment ? `The reason given: ${comment}` : null,
		path: pathBelow((slug) => weekPath(slug, week.startsOn)),
	};
}

/**
 * To a person asked from Approvals › Not submitted to submit their week, by
 * `askedBy`, the name of whoever asked. Once a day for each week: a second
 * press on `today` adds nothing.
 */
export function submitAsked(week: WeekOf, askedBy: string, today: Day): NewNotification {
	return {
		userId: week.userId,
		kind: "submit-reminder",
		title: `Please submit your timesheet for ${formatRange(week.startsOn, week.endsOn)}.`,
		body: `${askedBy} asked you to submit it.`,
		path: pathBelow((slug) => weekPath(slug, week.startsOn)),
		key: `asked:${week.startsOn}:${today}`,
	};
}

/** A request for leave or for extra work, as its notifications name it. */
export type RequestOf = {
	userId: string;
	startsOn: Day;
	endsOn: Day;
} & ({ type: "leave"; kindName: string } | { type: "work"; kind: WorkKind });

/** What a request is for, "Annual leave" as its kind is named or "overtime", for a reader who may see it. */
export function requestLabel(request: RequestOf): string {
	return request.type === "leave" ? request.kindName : WORK_KIND_LABELS[request.kind].toLowerCase();
}

/** The days a request takes: "Monday 16 November", or "Monday 16 November – Friday 20 November". */
export function requestDays(request: RequestOf): string {
	return request.startsOn === request.endsOn
		? formatDay(request.startsOn)
		: `${formatDay(request.startsOn)} – ${formatDay(request.endsOn)}`;
}

/** The words of a request's decision to its person, with the reason given. */
export function requestDecided(
	request: RequestOf,
	decision: "approved" | "refused" | "cancelled",
	comment: string | null,
): NewNotification {
	return {
		userId: request.userId,
		kind: "request-decided",
		title: `Your request for ${requestLabel(request)}, ${requestDays(request)}, was ${decision}.`,
		body: comment ? `The reason given: ${comment}` : null,
		path: pathBelow((slug) => destinationPath(slug, "time-off")),
	};
}

/** To the person whose timer the system stopped, and why (TR-02). */
export function timerStopped(userId: string, day: Day, lockedThrough: Day): NewNotification {
	return {
		userId,
		kind: "system",
		title: `Your timer on ${formatDay(day)} was stopped by the system.`,
		body: `The lock date reached ${formatDay(lockedThrough)}, so no more time can be added to that day.`,
		path: pathBelow((slug) => dayPath(slug, day)),
	};
}

/** To each of `userIds`, that a project's budget has passed its alert (TS-069). */
export function budgetCrossed(
	userIds: readonly string[],
	project: { id: string; name: string },
	used: string,
	threshold: number,
): NewNotification[] {
	return userIds.map((userId) => ({
		userId,
		kind: "budget",
		title: `The project “${project.name}” ${used}, past the alert at ${threshold}%.`,
		body: "You are told once for each budget period. Tracking time to the project is not stopped.",
		path: pathBelow((slug) => projectPath(slug, project.id)),
	}));
}
