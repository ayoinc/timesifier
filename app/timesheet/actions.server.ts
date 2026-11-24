import { env } from "cloudflare:workers";
import { data } from "react-router";
import * as z from "zod";

import { organisationScope } from "~/db";
import { overDaysRefusal, overLabel } from "~/leave/rules";
import { daysOver } from "~/leave/rules.server";
import { parseRequest } from "~/lib/validate";
import type { Membership } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import type { Outcome } from "~/organisations/problems";
import { periodContaining } from "~/periods/periods";
import { type NotMoved, submitPeriod, withdrawPeriod } from "~/periods/submission.server";
import { JOIN_INTENT, NOT_JOINABLE, TEAM_PROBLEMS, TEAM_REFUSAL } from "~/projects/teams";
import { joinTeam } from "~/projects/teams.server";
import { WORK_PACKAGE_REFUSALS } from "~/projects/work-packages";
import { TagIds } from "~/tags/tags";
import { addDays, Day, dayOf, exactInstantAt } from "~/time/calendar";
import { ENTRY_DESCRIPTION_MAX_LENGTH } from "~/time/entries";
import { startTimer, stopTimer } from "~/time/entries.server";
import { formatDay, formatDuration } from "~/time/format";
import {
	addHours,
	deleteEntry,
	editEntry,
	type NotWritten,
	REFUSAL_SENTENCES,
	restoreEntry,
	setCellHours,
} from "~/time/manual.server";
import { zoneOfMember } from "~/time/zones.server";
import { inTerms, type Terms, termsOf } from "~/workspace/work-model";
import { copyDay, copyWeek, leftOutSentence } from "./copy.server";
import { TypedHours } from "./durations";
import { markCookie } from "./getting-started.server";
import { entryOfUndo, undoToken } from "./undo.server";

/**
 * Everything the Timesheet's views ask the server for, in one action: "Track
 * time", which starts the timer or saves hours on a day (TS-056), the timer's
 * Stop (TS-012a), an entry changed or deleted by hand (TS-012b), a cell of the
 * week's grid (TS-052), a week's submission (TS-046) and putting getting
 * started away (TS-056). Each acts on the caller's own
 * time alone, in the organisation the layout read from the address: no form
 * names a person or an organisation, and `stop` names no entry. Times are the
 * server's clock, or a day and a time the person typed, read in their zone.
 */

const Id = z.string().min(1).max(64);
/** A wall-clock time as `<input type="time">` sends it. */
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Type a time as 09:30.");
const Description = z
	.string()
	.trim()
	.max(ENTRY_DESCRIPTION_MAX_LENGTH)
	.transform((text) => text || null);

/** Hours as typed: `1.5`, `1,5`, `1:30`, or nothing. */
const Hours = z.string().max(16);

/**
 * Whether time is overtime (TS-095), as a checkbox or a hidden field sends
 * it: "on" or "true" is, "false" is not, nothing leaves it to the writer.
 */
export const OvertimeFlag = z
	.enum(["on", "true", "false"])
	.optional()
	.transform((value) => (value === undefined ? undefined : value !== "false"));

/**
 * An entry's work package (TS-115b): an id, or empty for none. Left out, an
 * entry being changed keeps its own, and a new one has none.
 */
export const WorkPackageId = z
	.string()
	.max(64)
	.optional()
	.transform((value) => (value === undefined ? undefined : value === "" ? null : value));

export const TimesheetForm = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("track"),
		projectId: Id,
		description: Description.default(""),
		day: Day,
		hours: Hours.default(""),
		/** When the entry starts, where a slot of the calendar was chosen (TS-062). */
		start: Clock.optional(),
		taskId: Id.optional(),
		workPackageId: WorkPackageId,
		tagIds: TagIds,
		overtime: OvertimeFlag,
	}),
	z.object({ intent: z.literal("stop") }),
	z.object({
		intent: z.literal("edit"),
		entryId: Id,
		projectId: Id,
		date: Day,
		start: Clock,
		end: Clock,
		description: Description.default(""),
		taskId: Id.optional(),
		workPackageId: WorkPackageId,
		tagIds: TagIds,
		overtime: OvertimeFlag,
	}),
	z.object({ intent: z.literal("delete"), entryId: Id }),
	/** Puts back the entry just deleted (taste HT-A): the token its deletion answered. */
	z.object({ intent: z.literal("undo"), token: z.string().min(1).max(4096) }),
	/** Copies the last working day with time onto this empty day, or the last week with time onto this week (HT-F). */
	z.object({ intent: z.literal("copy-day"), day: Day }),
	z.object({ intent: z.literal("copy-week"), startsOn: Day }),
	z.object({
		intent: z.literal("cell"),
		projectId: Id,
		workPackageId: WorkPackageId,
		day: Day,
		hours: Hours,
		overtime: OvertimeFlag,
	}),
	z.object({ intent: z.literal("submit"), startsOn: Day }),
	z.object({ intent: z.literal("withdraw"), startsOn: Day }),
	z.object({ intent: z.literal("put-away") }),
	/** Puts the person on a project's team from a day, in one step from the picker (TS-115c). */
	z.object({ intent: z.literal(JOIN_INTENT), projectId: Id, day: Day }),
]);

/** What each refusal says to the person, and the status it is answered with. A day's limit says its own. */
const REFUSALS: Record<Exclude<NotWritten, "limit" | "invoiced">, [string, number]> = {
	"no-project": ["Choose an active project of this organisation.", 400],
	locked: [REFUSAL_SENTENCES.locked, 409],
	"not-found": ["That entry is not one of yours.", 404],
	running: ["That entry is running. Stop the timer first.", 409],
	"ends-before-start": ["An entry ends after it starts.", 400],
	ahead: [REFUSAL_SENTENCES.ahead, 400],
	"too-long": [REFUSAL_SENTENCES["too-long"], 400],
	"in-day-view": [
		"That day holds more than one entry of this project. Change it in the Day view.",
		409,
	],
	"no-task": ["Choose an active task of this project.", 400],
	"no-work-package": [WORK_PACKAGE_REFUSALS["no-work-package"], 400],
	"work-package-closed": [WORK_PACKAGE_REFUSALS["work-package-closed"], 409],
	"not-assigned": [TEAM_REFUSAL, 403],
	"no-tag": ["Choose active tags only.", 400],
};

/**
 * A refused change in words. A day's limit says what it has left (TS-090),
 * and so does a day with no room left before its end or now (TS-091, W08),
 * and an invoice its number and who can let the entry go (TR-09). A word for
 * projects is the organisation's own (TS-115a).
 */
const refusal = (
	refused:
		| { reason: Exclude<NotWritten, "limit" | "invoiced"> }
		| { reason: "limit" | "day-full" | "invoiced"; message: string },
	terms: Terms,
) => {
	if (refused.reason === "limit" || refused.reason === "invoiced") {
		return declined(refused.message, 409);
	}
	if (refused.reason === "day-full") return declined(refused.message);
	const [problem, status] = REFUSALS[refused.reason];
	return declined(inTerms(problem, terms), status);
};

/** A typed day and time as an instant in `zone`, or null when the clocks skip that time. */
function typedInstant(date: Day, clock: string, zone: string) {
	const [hours, minutes] = clock.split(":").map(Number) as [number, number];
	return exactInstantAt(date, hours * 60 + minutes, zone);
}

const SKIPPED = "That time does not exist on that day: the clocks change then.";
const NOT_TODAY = "Type the hours worked on that day. A timer runs today only.";
const NO_HOURS = "Type more than no hours, or leave them empty to start a timer.";
const FROM_START = "Type the hours worked from that time.";

export async function timesheetAction(request: Request, membership: Membership) {
	const input = await parseRequest(request, TimesheetForm);
	const { user, organisation } = membership;
	const terms = termsOf(organisation.workModel, organisation.internalTerm);
	const scope = organisationScope(env.DB, organisation.id);
	const zone = await zoneOfMember(membership);
	const now = Date.now();

	switch (input.intent) {
		case JOIN_INTENT: {
			const joined = await joinTeam(
				scope,
				{ userId: user.id, role: membership.role },
				input.projectId,
				input.day,
			);
			if (joined === null) return declined(inTerms(REFUSALS["no-project"][0], terms), 400);
			if (joined === false) return declined(inTerms(NOT_JOINABLE, terms), 403);
			if (!joined.ok) return declined(inTerms(TEAM_PROBLEMS[joined.problem], terms));
			return done(inTerms(`You are on the project's team from ${formatDay(input.day)}.`, terms));
		}
		// With no hours the timer starts now, which is today: on another day hours
		// are asked for. With hours, one entry of them is placed on the day shown
		// at the time chosen on the calendar, or else as hours typed into the
		// week's grid are (`gridEntryStart`).
		case "track": {
			if (input.hours.trim() === "" && input.start !== undefined) return declined(FROM_START);
			if (input.hours.trim() === "") {
				if (input.day !== dayOf(now, zone)) return declined(NOT_TODAY);
				const started = await startTimer(scope, {
					userId: user.id,
					projectId: input.projectId,
					description: input.description,
					zone,
					now,
					taskId: input.taskId,
					workPackageId: input.workPackageId,
					tagIds: input.tagIds,
				});
				return started.ok
					? { ...done("Timer started."), changed: [started.started.id] }
					: refusal(started, terms);
			}
			const hours = TypedHours.safeParse(input.hours);
			if (!hours.success) return declined(hours.error.issues[0]?.message ?? "Type hours as 1.5.");
			if (hours.data === 0) return declined(input.start === undefined ? NO_HOURS : FROM_START);
			const startedAt =
				input.start === undefined ? undefined : typedInstant(input.day, input.start, zone);
			if (startedAt === null) return declined(SKIPPED);
			const added = await addHours(scope, user.id, {
				projectId: input.projectId,
				description: input.description,
				day: input.day,
				minutes: hours.data,
				startedAt,
				zone,
				now,
				taskId: input.taskId,
				workPackageId: input.workPackageId,
				tagIds: input.tagIds,
				overtime: input.overtime,
			});
			return added.ok
				? { ...done("Entry saved."), changed: [added.entry.id] }
				: refusal(added, terms);
		}

		// A timer that ran past its day's expected hours is cut there, the rest
		// overtime, where the day takes overtime (TS-095); else, or past a cap,
		// it is kept and the day flagged over until an entry is trimmed or
		// moved (TS-090). Every day it puts over is named: its own, the
		// remainder's, and a later day of the week whose overtime its overtime
		// pushed past the week's cap (TR-18b).
		case "stop": {
			const stopped = await stopTimer(scope, user.id, now);
			if (!stopped) return done("No timer was running.");
			const { ended, rest } = stopped;
			const last = [rest?.spentOn ?? ended.spentOn, dayOf(now, zone)].sort().at(-1) as Day;
			const over = await daysOver(scope, user.id, ended.spentOn, last, now);
			const split = rest
				? ` ${formatDuration((now - (ended.endedAt?.getTime() ?? now)) / 1000)} past the day's expected hours is recorded as overtime.`
				: ended.overtime
					? " It is recorded as overtime."
					: "";
			const named = over
				.map(
					(d) =>
						`${formatDay(d.day, "short")} is ${overLabel(d.overMinutes, d.moreThanADay).toLowerCase()}`,
				)
				.join(" and ");
			return done(
				over.length > 0
					? `Timer stopped.${split} ${named}: trim or move an entry before you submit the week.`
					: `Timer stopped.${split}`,
			);
		}

		// An end at or before the start is the next day's (TR-14): an entry
		// that crosses midnight keeps its day, the one it starts on.
		case "edit": {
			const startedAt = typedInstant(input.date, input.start, zone);
			const endsNextDay = input.end <= input.start;
			const endedAt = typedInstant(
				endsNextDay ? addDays(input.date, 1) : input.date,
				input.end,
				zone,
			);
			if (startedAt === null || endedAt === null) return declined(SKIPPED);
			const written = await editEntry(
				scope,
				user.id,
				zone,
				input.entryId,
				{
					projectId: input.projectId,
					description: input.description,
					startedAt,
					endedAt,
					taskId: input.taskId,
					workPackageId: input.workPackageId,
					tagIds: input.tagIds,
					overtime: input.overtime,
				},
				now,
			);
			return written.ok
				? { ...done("Entry saved."), changed: [input.entryId] }
				: refusal(written, terms);
		}

		case "delete": {
			const deleted = await deleteEntry(scope, user.id, input.entryId);
			if (!deleted.ok) return refusal(deleted, terms);
			const who = { organisationId: organisation.id, userId: user.id };
			return {
				...done("Entry deleted."),
				undo: await undoToken(env.BETTER_AUTH_SECRET, who, deleted.deleted, now),
			};
		}

		case "undo": {
			const who = { organisationId: organisation.id, userId: user.id };
			const entry = await entryOfUndo(env.BETTER_AUTH_SECRET, input.token, who, now);
			if (!entry) return declined("That deletion can no longer be undone.", 409);
			const restored = await restoreEntry(scope, user.id, entry, now);
			return restored.ok
				? { ...done("Entry restored."), changed: [entry.id] }
				: refusal(restored, terms);
		}

		case "copy-day": {
			const copied = await copyDay(scope, user.id, input.day, zone, now);
			if (!copied.ok) return declined(copied.problem, 409);
			const count = copied.ids.length;
			return {
				...done(
					[
						`Copied ${count} ${count === 1 ? "entry" : "entries"} from ${formatDay(copied.from, "short")}.`,
						...(copied.leftOut ? [leftOutSentence(copied.leftOut, { naming: false })] : []),
					].join(" "),
				),
				changed: copied.ids,
			};
		}

		case "copy-week": {
			const period = periodContaining(input.startsOn, organisation.weekStartsOn);
			const copied = await copyWeek(scope, user.id, period, zone, now);
			if (!copied.ok) return declined(copied.problem, 409);
			return {
				...done(
					[
						`Copied ${copied.ids.length} ${copied.ids.length === 1 ? "entry" : "entries"} onto ${copied.days} ${copied.days === 1 ? "day" : "days"}.`,
						...copied.notes,
					].join(" "),
				),
				changed: copied.ids,
			};
		}

		case "cell": {
			const hours = TypedHours.safeParse(input.hours);
			if (!hours.success) return declined(hours.error.issues[0]?.message ?? "Type hours as 1.5.");
			const set = await setCellHours(scope, user.id, {
				projectId: input.projectId,
				workPackageId: input.workPackageId ?? null,
				day: input.day,
				minutes: hours.data,
				overtime: input.overtime,
				zone,
				now,
			});
			return set.ok ? done("Saved.") : refusal(set, terms);
		}

		case "submit": {
			const submitted = await submitPeriod(scope, {
				userId: user.id,
				startsOn: input.startsOn,
				zone,
				weekStartsOn: organisation.weekStartsOn,
				now,
			});
			if (submitted.ok) {
				return done(
					submitted.alone
						? "Week submitted and approved automatically: nobody else can approve it."
						: "Week submitted. Its entries are locked until it is decided.",
				);
			}
			const problem: Record<NotMoved, string> = {
				"not-yet": "A week can be submitted once it has begun.",
				running: "Stop the timer before you submit the week.",
				"not-from-here": "This week is already submitted or approved.",
				over: overDaysRefusal(("over" in submitted && submitted.over) || []),
			};
			return declined(problem[submitted.reason], 409);
		}

		case "withdraw": {
			const withdrawn = await withdrawPeriod(scope, {
				userId: user.id,
				startsOn: input.startsOn,
				weekStartsOn: organisation.weekStartsOn,
			});
			return withdrawn.ok
				? done("Submission withdrawn. You can change the week's entries again.")
				: declined("Only a submission nobody has decided yet can be withdrawn.", 409);
		}

		case "put-away":
			return data<Outcome>(done("Getting started is put away."), {
				headers: { "Set-Cookie": markCookie(request.headers.get("Cookie"), user.id, "away") },
			});
	}
}
