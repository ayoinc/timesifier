import * as z from "zod";

/**
 * The kinds of notification (TS-049, decisions 68 and 69). Each is shown in
 * the bell of the organisation it happened in, always, and sent by email too
 * unless its person has turned that kind's email off on My account
 * (`notification_choices`). The words here are the same for everybody: they
 * hold nothing anybody typed, so an email's subject and heading can be made
 * of them alone.
 */

export const NOTIFICATION_KINDS = [
	"week-waiting",
	"week-decided",
	"request-waiting",
	"request-decided",
	"system",
	"budget",
	"timer-reminder",
	"deadline-reminder",
	"submit-reminder",
	"approvals-reminder",
	"export-ready",
	"export-failed",
] as const;

export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

/**
 * Who may be sent a kind: everyone; only those who decide or look after
 * budgets; or only owners, of the export of everything they asked for (TS-126b).
 */
export type KindAudience = "everyone" | "deciders" | "budgets" | "owners";

export interface KindWords {
	/** Its row on My account › Notifications. */
	label: string;
	/** What it tells, under the label. */
	description: string;
	/** Its email's subject and heading. */
	subject: string;
	heading: string;
	/** Why the person got its email, at the foot. */
	reason: string;
	audience: KindAudience;
}

export const KIND_WORDS: Record<NotificationKind, KindWords> = {
	"week-waiting": {
		label: "Timesheets to approve",
		description: "A week someone submitted that waits for you.",
		subject: "A timesheet is waiting for your approval",
		heading: "A timesheet to approve",
		reason:
			"You got this email because you approve this person's timesheets: you manage a team they are in, or you are an owner or admin and nobody else is there to.",
		audience: "deciders",
	},
	"week-decided": {
		label: "Your timesheets approved or returned",
		description: "Your week approved, or returned with the reason.",
		subject: "Your timesheet has been decided",
		heading: "Your timesheet",
		reason: "You got this email because this timesheet is yours.",
		audience: "everyone",
	},
	"request-waiting": {
		label: "Requests to decide",
		description: "Leave, overtime, weekend or public holiday work someone asked for.",
		subject: "A request is waiting for your decision",
		heading: "A request to decide",
		reason:
			"You got this email because you decide this person's requests: you manage a team they are in, or you are an owner or admin and nobody else is there to.",
		audience: "deciders",
	},
	"request-decided": {
		label: "Your requests decided",
		description: "Your leave or extra work approved, declined or cancelled.",
		subject: "Your request has been decided",
		heading: "Your request",
		reason: "You got this email because this request is yours.",
		audience: "everyone",
	},
	system: {
		label: "What Timesifier did for you",
		description: "Your week submitted, or your timer stopped, when the lock date reached it.",
		subject: "Timesifier changed your timesheet",
		heading: "Your timesheet",
		reason: "You got this email because this timesheet is yours.",
		audience: "everyone",
	},
	budget: {
		label: "Budget alerts",
		description: "A project's budget past its alert.",
		subject: "A project has reached its budget alert on Timesifier",
		heading: "Budget alert",
		reason:
			"You got this email because you are an owner or admin of this organisation on Timesifier, or manage a team with someone in it who tracked time to this project.",
		audience: "budgets",
	},
	"timer-reminder": {
		label: "A timer past the day's limit",
		description: "Once a day, when your timer runs past your day's hours.",
		subject: "Your timer is still running",
		heading: "Your timer",
		reason: "You got this email because the timer is yours.",
		audience: "everyone",
	},
	"deadline-reminder": {
		label: "The timesheet deadline",
		description: "Before the deadline, when your week is not submitted.",
		subject: "Your timesheet is due soon",
		heading: "Your timesheet is due",
		reason: "You got this email because this timesheet is yours and it is not submitted.",
		audience: "everyone",
	},
	"submit-reminder": {
		label: "Asked to submit a timesheet",
		description: "When someone who approves your timesheets asks you to submit a week.",
		subject: "Please submit your timesheet",
		heading: "Your timesheet",
		reason:
			"You got this email because this timesheet is yours, it is not submitted, and someone who approves it asked you to submit it.",
		audience: "everyone",
	},
	"approvals-reminder": {
		label: "Timesheets still waiting",
		description: "Once a day, when weeks have waited for you since before today.",
		subject: "Timesheets are waiting for your approval",
		heading: "Timesheets to approve",
		reason:
			"You got this email because you approve these timesheets: you manage a team their people are in, or you are an owner or admin and nobody else is there to.",
		audience: "deciders",
	},
	"export-ready": {
		label: "Your export ready to download",
		description: "The export of everything you asked for, ready to download.",
		subject: "Your export of everything is ready on Timesifier",
		heading: "Your export is ready",
		reason:
			"You got this email because you asked for this export, as an owner of the organisation on Timesifier.",
		audience: "owners",
	},
	"export-failed": {
		label: "Your export could not be made",
		description: "The export of everything you asked for, when it could not be made.",
		subject: "Your export of everything could not be made on Timesifier",
		heading: "Your export could not be made",
		reason:
			"You got this email because you asked for this export, as an owner of the organisation on Timesifier.",
		audience: "owners",
	},
};

/** How long a notification is kept, in days, before the daily job deletes it. */
export const NOTIFICATION_RETENTION_DAYS = 90;

/** The most notifications the bell lists. */
export const BELL_LIMIT = 30;

/** The hour, where the person is, from which a reminder of the deadline or of weeks waiting is due. */
export const REMINDER_HOUR = 9;

/** What the bell lists of one notification. */
export interface BellItem {
	id: string;
	kind: NotificationKind;
	title: string;
	body: string | null;
	/** Its address in the organisation. */
	href: string;
	createdAt: number;
	read: boolean;
}
