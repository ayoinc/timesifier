import { env } from "cloudflare:workers";
import * as z from "zod";

import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import type { Membership } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { type NotMoved, submitPeriod, withdrawPeriod } from "~/periods/submission.server";
import { Day, exactInstantAt } from "~/time/calendar";
import { ENTRY_DESCRIPTION_MAX_LENGTH } from "~/time/entries";
import { startTimer, stopTimer } from "~/time/entries.server";
import {
	addEntry,
	deleteEntry,
	editEntry,
	type NotWritten,
	setCellHours,
} from "~/time/manual.server";
import { zoneOfMember } from "~/time/zones.server";

import { TypedHours } from "./durations";

/**
 * Everything the Timesheet's views ask the server for, in one action: the
 * timer (TS-012a), entries by hand (TS-012b), a cell of the week's grid
 * (TS-052) and a week's submission (TS-046). Each acts on the caller's own
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

const EntryFields = {
	projectId: Id,
	date: Day,
	start: Clock,
	end: Clock,
	description: Description.default(""),
};

export const TimesheetForm = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("start"), projectId: Id, description: Description.default("") }),
	z.object({ intent: z.literal("stop") }),
	z.object({ intent: z.literal("add"), ...EntryFields }),
	z.object({ intent: z.literal("edit"), entryId: Id, ...EntryFields }),
	z.object({ intent: z.literal("delete"), entryId: Id }),
	z.object({ intent: z.literal("cell"), projectId: Id, day: Day, hours: z.string().max(16) }),
	z.object({ intent: z.literal("submit"), startsOn: Day }),
	z.object({ intent: z.literal("withdraw"), startsOn: Day }),
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

export async function timesheetAction(request: Request, membership: Membership) {
	const input = await parseRequest(request, TimesheetForm);
	const { user, organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const zone = await zoneOfMember(membership);
	const now = Date.now();

	switch (input.intent) {
		case "start": {
			const started = await startTimer(scope, {
				userId: user.id,
				projectId: input.projectId,
				description: input.description,
				zone,
				now,
			});
			if (started.ok) return done("Timer started.");
			return refusal(started.reason);
		}

		case "stop": {
			const stopped = await stopTimer(scope, user.id, now);
			return done(stopped ? "Timer stopped." : "No timer was running.");
		}

		case "add":
		case "edit": {
			const startedAt = typedInstant(input.date, input.start, zone);
			const endedAt = typedInstant(input.date, input.end, zone);
			if (startedAt === null || endedAt === null) return declined(SKIPPED);
			const span = {
				projectId: input.projectId,
				description: input.description,
				startedAt,
				endedAt,
			};
			const written =
				input.intent === "add"
					? await addEntry(scope, user.id, zone, span)
					: await editEntry(scope, user.id, zone, input.entryId, span);
			if (!written.ok) return refusal(written.reason);
			return done(input.intent === "add" ? "Entry added." : "Entry saved.");
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
	}
}
