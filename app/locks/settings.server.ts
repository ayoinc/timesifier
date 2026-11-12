import * as z from "zod";

import { isAdministrator } from "~/organisations/access";
import type { Membership } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { Day, dayOf } from "~/time/calendar";
import { formatRange } from "~/time/format";

import { type Deadline, DeadlineKind, DeadlineTime, LONGEST_AUTO_LOCK_DAYS } from "./deadline";
import {
	LOCK_REASON_MAX_LENGTH,
	type LockSettings,
	lockSettingsOf,
	type NotLocked,
	setDeadline,
	setLockDate,
} from "./locks.server";
import { deadlineLabel } from "./words";

/**
 * Workspace settings' "Timesheet locking" (TS-065): the forms it sends, what
 * the page's loader reads for it, and what its action does with each. Only
 * owners and admins change it; the page is theirs alone, and the action asks
 * again.
 */

/** A checkbox sends its value only while it is ticked. */
const Ticked = z
	.literal("on")
	.optional()
	.transform((value) => value === "on");

/** A reason: optional, on one line, up to the limit. */
const Reason = z
	.string()
	.trim()
	.max(LOCK_REASON_MAX_LENGTH)
	.optional()
	.transform((text) => (text ? text : null));

/** Days after a deadline; empty is auto-lock off. */
const AutoLockDays = z
	.string()
	.trim()
	.max(3)
	.transform((text, context) => {
		if (text === "") return null;
		const days = Number(text);
		if (!Number.isInteger(days) || days < 0 || days > LONGEST_AUTO_LOCK_DAYS) {
			context.addIssue({
				code: "custom",
				message: `Type a whole number of days from 0 to ${LONGEST_AUTO_LOCK_DAYS}, or leave it empty.`,
			});
			return z.NEVER;
		}
		return days;
	});

/** The forms of the section, for the page's discriminated union of intents. */
export const LOCK_FORMS = [
	z.object({
		intent: z.literal("deadline"),
		deadlineKind: DeadlineKind,
		weekday: z.coerce.number().int().min(1).max(7).optional(),
		monthDay: z.coerce.number().int().min(1).max(31).optional(),
		time: DeadlineTime.optional(),
		autoLockDays: AutoLockDays.optional(),
		autoSubmitAtLock: Ticked,
	}),
	z.object({
		intent: z.literal("lock-date"),
		lockedThrough: Day,
		reason: Reason,
		autoSubmit: Ticked,
	}),
	z.object({
		intent: z.literal("remove-lock-date"),
		reason: z.string().trim().min(1).max(LOCK_REASON_MAX_LENGTH),
	}),
] as const;

const LockForm = z.discriminatedUnion("intent", [...LOCK_FORMS]);
export type LockForm = z.infer<typeof LockForm>;

/** What the section shows: the organisation's lock and deadline, and today in its zone. */
export interface LockingData extends LockSettings {
	/** Today in the organisation's zone: the latest lock date that may be set. */
	today: Day;
}

export async function lockingData(
	organisation: { id: string; timeZone: string },
	now: number,
): Promise<LockingData> {
	return { ...(await lockSettingsOf(organisation.id)), today: dayOf(now, organisation.timeZone) };
}

const NOT_LOCKED: Record<NotLocked, string> = {
	"after-today": "The lock date can be today at the latest.",
	"reason-needed": "Say why the lock date moves back: the reason is kept in the activity log.",
	stale: "The lock date changed since this page was opened. Look at it again.",
};

/** What one of the section's forms asks for, as `membership`, at `now`. */
export async function lockAction(input: LockForm, membership: Membership, now: number) {
	const { organisation, role, user } = membership;
	if (!isAdministrator(role)) return declined(NOT_ALLOWED, 403);
	const actor = { userId: user.id };

	if (input.intent === "deadline") {
		let deadline: Deadline = { kind: "none" };
		if (input.deadlineKind !== "none") {
			if (input.time === undefined) return declined("Choose the deadline's time.");
			if (input.deadlineKind === "weekly") {
				if (input.weekday === undefined) return declined("Choose the deadline's day.");
				deadline = { kind: "weekly", weekday: input.weekday, time: input.time };
			} else {
				if (input.monthDay === undefined) return declined("Choose the deadline's day.");
				deadline = { kind: "monthly", day: input.monthDay, time: input.time };
			}
		}
		const autoLockDays = input.autoLockDays ?? null;
		await setDeadline(organisation.id, actor, {
			deadline,
			autoLockDays,
			autoSubmitAtLock: input.autoSubmitAtLock,
		});
		return done(
			deadline.kind === "none"
				? "No timesheet deadline. Auto-lock is off."
				: `The timesheet deadline is ${deadlineLabel(deadline).toLowerCase()}.`,
		);
	}

	const lockedThrough = input.intent === "lock-date" ? input.lockedThrough : null;
	const set = await setLockDate(
		organisation,
		actor,
		{
			lockedThrough,
			reason: input.reason,
			autoSubmit: input.intent === "lock-date" && input.autoSubmit,
		},
		now,
	);
	if (!set.ok) return declined(NOT_LOCKED[set.reason], set.reason === "stale" ? 409 : 400);
	if (lockedThrough === null) return done("The lock date is removed. Past time can change again.");
	const submitted =
		set.submitted === 0
			? ""
			: ` ${set.submitted} ${set.submitted === 1 ? "week was" : "weeks were"} submitted by the system.`;
	return done(`Time is locked through ${formatRange(lockedThrough, lockedThrough)}.${submitted}`);
}
