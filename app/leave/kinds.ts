import * as z from "zod";

/**
 * The kinds of leave (TS-061). Every organisation has the same six, made by
 * the migration `0007_leave` and its trigger; owners and admins rename them,
 * switch them off, set a yearly allowance and say whether a request waits for a
 * decision. Nothing here reads the database.
 */

/** The six kinds, in the order they are listed. `holiday` is the organisation's public holidays. */
export const KIND_KEYS = ["annual", "sick", "study", "parental", "unpaid", "holiday"] as const;
export const KindKey = z.enum(KIND_KEYS);
export type KindKey = z.infer<typeof KindKey>;

/** The kind whose days are the organisation's public holidays: nobody asks for it. */
export const HOLIDAY_KIND: KindKey = "holiday";

/** What each kind is given when an organisation is made: the migration's rows, written once more. */
export const DEFAULT_KINDS: Record<
	KindKey,
	{ name: string; needsApproval: boolean; allowanceHalfDays: number | null }
> = {
	annual: { name: "Annual leave", needsApproval: true, allowanceHalfDays: 50 },
	sick: { name: "Sick leave", needsApproval: false, allowanceHalfDays: null },
	study: { name: "Study leave", needsApproval: true, allowanceHalfDays: null },
	parental: { name: "Parental leave", needsApproval: true, allowanceHalfDays: null },
	unpaid: { name: "Unpaid leave", needsApproval: true, allowanceHalfDays: null },
	holiday: { name: "Public holiday", needsApproval: false, allowanceHalfDays: null },
};

/** A kind of leave as the rules read it. */
export interface LeaveKind {
	id: string;
	key: KindKey;
	name: string;
	enabled: boolean;
	needsApproval: boolean;
	/** Half days a year, or null for no allowance: nothing is counted against it. */
	allowanceHalfDays: number | null;
}

/** The kinds in the order they are listed. */
export function inKindOrder<K extends { key: KindKey }>(kinds: readonly K[]): K[] {
	return [...kinds].sort((a, b) => KIND_KEYS.indexOf(a.key) - KIND_KEYS.indexOf(b.key));
}

/** The kinds a person may ask for: those switched on, public holidays aside. */
export function requestableKinds<K extends LeaveKind>(kinds: readonly K[]): K[] {
	return inKindOrder(kinds).filter((kind) => kind.enabled && kind.key !== HOLIDAY_KIND);
}

/** Where a request stands. */
export const LEAVE_STATUSES = ["pending", "approved", "refused", "withdrawn", "cancelled"] as const;
export const LeaveStatus = z.enum(LEAVE_STATUSES);
export type LeaveStatus = z.infer<typeof LeaveStatus>;

/** A request's status as a person reads it. */
export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
	pending: "Waiting for approval",
	approved: "Approved",
	refused: "Refused",
	withdrawn: "Withdrawn",
	cancelled: "Cancelled",
};

/** The statuses whose days are counted against an allowance and may not be asked for twice. */
export const HOLDING_STATUSES: readonly LeaveStatus[] = ["pending", "approved"];

/** The longest name a kind or a public holiday takes. */
export const LEAVE_NAME_MAX_LENGTH = 60;
/** The longest note or comment a request takes. */
export const LEAVE_TEXT_MAX_LENGTH = 500;
/** The longest request, in days from its first to its last. */
export const LONGEST_REQUEST_DAYS = 366;
/** The largest yearly allowance, in days. */
export const LARGEST_ALLOWANCE_DAYS = 365;

/** Half days in words: 1 is "half a day", 2 is "1 day", 5 is "2.5 days". */
export function halfDaysLabel(halfDays: number): string {
	if (halfDays === 1) return "half a day";
	const days = halfDays / 2;
	return `${days} ${days === 1 ? "day" : "days"}`;
}
