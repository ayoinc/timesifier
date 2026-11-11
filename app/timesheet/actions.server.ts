import { env } from "cloudflare:workers";
import { data } from "react-router";
import * as z from "zod";

import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import type { Membership } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import type { Outcome } from "~/organisations/problems";
import { type NotMoved, submitPeriod, withdrawPeriod } from "~/periods/submission.server";
import { Day, dayOf, exactInstantAt } from "~/time/calendar";
import { ENTRY_DESCRIPTION_MAX_LENGTH } from "~/time/entries";
import { startTimer, stopTimer } from "~/time/entries.server";
import {
	addHours,
	deleteEntry,
	editEntry,
	type NotWritten,
	setCellHours,
} from "~/time/manual.server";
import { zoneOfMember } from "~/time/zones.server";

import { TypedHours } from "./durations";
import { markCookie } from "./getting-started.server";

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

export const TimesheetForm = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("track"),
		projectId: Id,
		description: Description.default(""),
		day: Day,
		hours: Hours.default(""),
		/** When the entry starts, where a slot of the calendar was chosen (TS-062). */
		start: Clock.optional(),
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
	}),
	z.object({ intent: z.literal("delete"), entryId: Id }),
	z.object({ intent: z.literal("cell"), projectId: Id, day: Day, hours: Hours }),
	z.object({ intent: z.literal("submit"), startsOn: Day }),
	z.object({ intent: z.literal("withdraw"), startsOn: Day }),
	z.object({ intent: z.literal("put-away") }),
]);

/** What each refusal says to the person, and the status it is answered with. */
const REFUSALS: Record<NotWritten, [string, number]> = {
	"no-project": ["Choose an active project of this organisation.", 400],
	locked: [
		"That week is submitted or approved, so its entries cannot be changed. Withdraw it first.",
		409,
	],
	"not-found": ["That entry is not one of yours.", 404],
	running: ["That entry is running. Stop the timer first.", 409],
	"ends-before-start": ["An entry ends after it starts.", 400],
	"in-day-view": [
		"That day holds more than one entry of this project. Change it in the Day view.",
		409,
	],
};

const refusal = (reason: NotWritten) => declined(...REFUSALS[reason]);

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
	const scope = organisationScope(env.DB, organisation.id);
	const zone = await zoneOfMember(membership);
	const now = Date.now();

	switch (input.intent) {
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
				});
				return started.ok ? done("Timer started.") : refusal(started.reason);
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
			});
			return added.ok ? done("Entry saved.") : refusal(added.reason);
		}

		case "stop": {
			const stopped = await stopTimer(scope, user.id, now);
			return done(stopped ? "Timer stopped." : "No timer was running.");
		}

		case "edit": {
			const startedAt = typedInstant(input.date, input.start, zone);
			const endedAt = typedInstant(input.date, input.end, zone);
			if (startedAt === null || endedAt === null) return declined(SKIPPED);
			const written = await editEntry(scope, user.id, zone, input.entryId, {
				projectId: input.projectId,
				description: input.description,
				startedAt,
				endedAt,
			});
			return written.ok ? done("Entry saved.") : refusal(written.reason);
		}

		case "delete": {
			const deleted = await deleteEntry(scope, user.id, zone, input.entryId);
			return deleted.ok ? done("Entry deleted.") : refusal(deleted.reason);
		}

		case "cell": {
			const hours = TypedHours.safeParse(input.hours);
			if (!hours.success) return declined(hours.error.issues[0]?.message ?? "Type hours as 1.5.");
			const set = await setCellHours(scope, user.id, {
				projectId: input.projectId,
				day: input.day,
				minutes: hours.data,
				zone,
				now,
			});
			return set.ok ? done("Saved.") : refusal(set.reason);
		}

		case "submit": {
			const submitted = await submitPeriod(scope, {
				userId: user.id,
				startsOn: input.startsOn,
				zone,
				weekStartsOn: organisation.weekStartsOn,
				now,
			});
			if (submitted.ok) return done("Week submitted. Its entries are locked until it is decided.");
			const problem: Record<NotMoved, string> = {
				"not-yet": "A week can be submitted once it has begun.",
				running: "Stop the timer before you submit the week.",
				"not-from-here": "This week is already submitted or approved.",
			};
			return declined(problem[submitted.reason], 409);
		}

		case "withdraw": {
			const withdrawn = await withdrawPeriod(scope, { userId: user.id, startsOn: input.startsOn });
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
