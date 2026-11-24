import { env } from "cloudflare:workers";

import { sendEmail } from "~/auth/email.server";
import { getPlatformBrand } from "~/brand/platform-brand.server";
import { markNotificationEmails, waitingNotificationEmails } from "~/db";
import { mailOrigin } from "~/platform/mail.server";

import { notificationEmail } from "./email";
import { NotificationKind } from "./kinds";

/** The most notification emails one run of the scheduled work sends; the rest wait for the next. */
export const NOTIFICATION_EMAILS_PER_RUN = 100;

/** How long a notification's email may wait to be sent before it is given up: a day. */
const LONGEST_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * Sends the emails of notifications that wait (TS-049), oldest first, run
 * every minute by the scheduled handler. A person who turned a kind's email
 * off is skipped, as they are when they turn it off after it was made. The
 * first email that cannot be sent stops the run: it and the rest wait for
 * the next, for a day at most, so news is never sent late and one address
 * that fails holds nothing back for longer. Returns how many were sent.
 */
export async function sendWaitingNotifications(now: Date): Promise<number> {
	const waiting = await waitingNotificationEmails(env.DB, NOTIFICATION_EMAILS_PER_RUN);
	if (waiting.length === 0) return 0;
	const stale = (row: (typeof waiting)[number]) =>
		row.emailOn === false || row.createdAt.getTime() < now.getTime() - LONGEST_WAIT_MS;
	await markNotificationEmails(
		env.DB,
		waiting.filter(stale).map((row) => row.id),
		"skipped",
	);
	const platform = await getPlatformBrand(env);
	const origin = mailOrigin();
	const sent: string[] = [];
	for (const row of waiting) {
		if (stale(row)) continue;
		const message = notificationEmail(
			{
				kind: NotificationKind.parse(row.kind),
				title: row.title,
				body: row.body,
				path: row.path,
				organisationName: row.organisationName,
				slug: row.slug,
				origin,
			},
			platform,
		);
		if (!(await sendEmail({ to: row.email, ...message }))) break;
		sent.push(row.id);
	}
	await markNotificationEmails(env.DB, sent, "sent");
	return sent.length;
}
