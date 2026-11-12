import { locksEntries, type PeriodStatus } from "~/periods/periods";
import type { Day } from "~/time/calendar";

/**
 * Why a time entry, an expense or a day of leave cannot change (TS-064, B22).
 * A lock is derived, never stored, from three things:
 *
 * - the organisation's lock date, `locked_through`: nothing on or before it
 *   changes, for anyone. The owner is bound too; the date has to be moved back
 *   first, which is recorded.
 * - its person's period on that day, while submitted or approved (TS-046).
 * - being on an invoice line (`invoice_line_sources`). Leave is never invoiced.
 *
 * The roles that may change someone's items at all are `access.ts`; a lock
 * holds whoever asks.
 */

/** Why an item is locked. */
export type LockReason = "locked-through" | "submitted" | "approved" | "invoiced";

/** What decides whether an item on `day` is locked. */
export interface LockInput {
	/** The item's local date: an entry's start day in its person's zone, an expense's `spent_on`. */
	day: Day;
	/** The organisation's lock date, or null when it has none. */
	lockedThrough: Day | null;
	/** The status of its person's period holding `day`, or null when never submitted. */
	periodStatus: PeriodStatus | null;
	/** Whether the item is on an invoice line. */
	invoiced: boolean;
}

/**
 * Why the item is locked, or null when it is not. When more than one reason
 * holds, the one that would take longest to undo is given: invoiced, then the
 * lock date, then an approved period, then a submitted one.
 */
export function lockOf(input: LockInput): LockReason | null {
	const { day, lockedThrough, periodStatus, invoiced } = input;
	if (invoiced) return "invoiced";
	if (lockedThrough !== null && day <= lockedThrough) return "locked-through";
	if (locksEntries(periodStatus)) return periodStatus === "approved" ? "approved" : "submitted";
	return null;
}

/**
 * Why a change is refused, or null when it may be made. A change touches the
 * item as it was (`before`, null for a new one) and as it would be (`after`,
 * null for a deletion), and is refused when either is locked: an entry may not
 * be moved out of a locked day, nor into one.
 */
export function lockOfChange(before: LockInput | null, after: LockInput | null): LockReason | null {
	return (before === null ? null : lockOf(before)) ?? (after === null ? null : lockOf(after));
}

/** Whether a change from `before` to `after` may be made: see `lockOfChange`. */
export function mayChangeItem(before: LockInput | null, after: LockInput | null): boolean {
	return lockOfChange(before, after) === null;
}

/** The lock date as the people it binds are told it: the date, and the owner's or admin's reason when one was given. */
export interface LockNotice {
	lockedThrough: Day;
	reason: string | null;
}

/** A locked day's short label, beside its heading. */
export const LOCK_LABELS: Record<LockReason, string> = {
	"locked-through": "Locked",
	submitted: "Submitted",
	approved: "Approved",
	invoiced: "Invoiced",
};

/**
 * Why nothing can be tracked or changed on a locked day, in a sentence:
 * `formatDay` writes the lock date as the page writes days.
 */
export function lockSentence(
	reason: LockReason,
	lockDate: LockNotice | null,
	formatDay: (day: Day) => string,
): string {
	switch (reason) {
		case "locked-through": {
			const through = lockDate ? `, ${formatDay(lockDate.lockedThrough)}` : "";
			const why = lockDate?.reason ? ` The reason given: ${lockDate.reason}` : "";
			return `This day is on or before the lock date${through}, so nothing can be tracked or changed on it until an owner or admin moves the date back.${why}`;
		}
		case "submitted":
		case "approved":
			return "This day is in a submitted or approved week, so nothing can be tracked or changed on it.";
		case "invoiced":
			return "This day's time is on an invoice, so it cannot be changed until it is taken off.";
	}
}

/** The lock date in a sentence, for a view that holds days on or before it. */
export function lockDateNotice(lockDate: LockNotice, formatDay: (day: Day) => string): string {
	const why = lockDate.reason ? ` The reason given: ${lockDate.reason}` : "";
	return `Locked through ${formatDay(lockDate.lockedThrough)}: nothing on or before that day can be tracked or changed until an owner or admin moves the lock date back.${why}`;
}
