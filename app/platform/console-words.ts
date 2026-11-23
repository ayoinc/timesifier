import { dayOf } from "~/time/calendar";
import { formatDayAndTime, formatDayWithYear } from "~/time/format";

// What the platform console's pages share in words (TS-099): the reason every
// tool asks for, the steps of the platform log as sentences, and the clock
// the console's times are read on. Nothing here runs only on the server.

/** The longest reason a tool takes. A reason is a sentence or two, not a report. */
export const REASON_MAX_LENGTH = 500;

/** What the reason field asks for, under its label. */
export const REASON_HINT =
	"Recorded in the platform log with what you did. Say why, in a sentence.";

/** The refusal of a tool sent without a reason. */
export const REASON_MISSING = "Say why you are doing this. The reason is kept in the platform log.";

/** The reason as it is kept, or null when there is none or it is too long to be one. */
export function reasonOf(text: string | undefined): string | null {
	const reason = text?.trim() ?? "";
	return reason.length > 0 && reason.length <= REASON_MAX_LENGTH ? reason : null;
}

/** One step of the platform log as a page shows it. */
export interface PlatformLogRow {
	id: string;
	when: string;
	who: string;
	action: string;
	/** What the step was done to, and its page in the console where it has one. */
	subject: { label: string; href: string | null };
	reason: string | null;
}

/**
 * The steps the platform log records, as a person says them. A step a newer
 * tool records and this list has not caught up with is read from its name.
 */
export const PLATFORM_ACTION_LABELS: Record<string, string> = {
	"console.opened": "Opened the console",
	"organisation.plan_changed": "Changed the plan",
	"support_access.granted": "Support access granted",
	"support_access.revoked": "Support access ended",
	"support_access.used": "Read the organisation under support access",
	"account.sessions_revoked": "Ended the account's sessions",
	"account.closed": "Closed the account",
	"account.restored": "Restored the account",
	"account.invitation_resent": "Sent an invitation again",
	"account.export_link_sent": "Sent the link to their data",
	"account.deleted": "Deleted the account",
	"mailing.queued": "Queued a mailing",
	"brand.changed": "Changed the brand",
	"brand.test_sent": "Sent a test email of the brand",
};

export function actionWords(action: string): string {
	const known = PLATFORM_ACTION_LABELS[action];
	if (known) return known;
	const words = action.replace(/[._]/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The clock the console reads times on. Its owners work in the United
 * Kingdom, and an organisation's own zone would make one log read on many clocks.
 */
export const CONSOLE_ZONE = "Europe/London";

/** A moment as the console writes it: "Wednesday 11 November at 09:30". */
export function consoleMoment(at: Date): string {
	return formatDayAndTime(at.getTime(), CONSOLE_ZONE);
}

/** A day as the console writes it, with its year: "Wednesday 11 November 2026". */
export function consoleDay(at: Date): string {
	return formatDayWithYear(dayOf(at.getTime(), CONSOLE_ZONE));
}
