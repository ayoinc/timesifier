import { deleteExpiredActivity } from "~/activity/activity.server";
import { deleteExpiredContracts } from "~/contracts/contracts.server";
import { platformData } from "~/db";
import { advanceExports, deleteExpiredExports } from "~/exports/job.server";
import { dispatchWebhooks } from "~/integrations/webhooks.server";
import { runBillingSchedule } from "~/invoices/schedule.server";
import { runAutoLock, runLockReach } from "~/locks/locks.server";
import { deleteExpiredNotifications } from "~/notifications/bell.server";
import { sendWaitingNotifications } from "~/notifications/mail.server";
import { runReminders } from "~/notifications/reminders.server";
import { sendWaitingInvitations } from "~/onboarding/onboarding.server";
import { recheckDomains } from "~/organisations/domains.server";
import { MAIL_BATCH } from "~/platform/limits";
import { sendWaitingMail } from "~/platform/mail.server";

/**
 * The Worker's background work, run by the Cron Triggers in wrangler.jsonc.
 * Each run is one short sequence of named duties, chosen by its trigger. Each
 * duty runs on its own: one that fails is logged and the next still runs.
 *
 * - Every minute: the webhooks' deliveries that are due are sent (TS-087),
 *   then the invitation emails waiting from "Invite many" and people imports
 *   (TS-108), then the next mailings to account holders: one batch between
 *   them, within the day's cap (TS-099), and the emails of notifications that
 *   wait (TS-049); then one step of the oldest export of everything being
 *   made (TS-126); then, but in the hour's first minute, the reminders go on
 *   from where the last run stopped.
 * - Every hour: auto-lock (TS-065), then the lock date reaching the days that
 *   have ended since (D7: timers on them stopped, weeks auto-submitted); recurring invoices that are due are issued
 *   and overdue invoices are reminded (TS-074, TS-078). Exports of everything
 *   7 days old are deleted, file and row (TS-126). Then the reminders of
 *   running timers, the deadline and weeks waiting (TS-049): the hour's pass
 *   starts here, after the duties before it.
 * - Every day at 03:17 UTC: rows past their retention are deleted: activity
 *   records after 730 days (TS-072), sign-ins after 90 (TS-099),
 *   notifications after 90 (TS-049), and contracts three years after the end
 *   of the tax year (5 April) they ended in (TS-098a). TS-033 adds the other
 *   tables here.
 *   Every organisation's domains are looked up again (TS-104): the owners
 *   are told once after 7 days without the record, and the domain is
 *   unverified after 14.
 *
 * The reminders make at most `REMINDER_QUERIES_PER_RUN` of the 1,000 queries
 * one invocation may make, and go last in theirs (decision 69).
 */

/** The triggers, as wrangler.jsonc names them. */
export const EVERY_MINUTE = "* * * * *";
export const HOURLY = "0 * * * *";
export const DAILY = "17 3 * * *";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Runs each of `duties` in turn; one that throws is logged by its name, and the rest still run. */
async function runEach(duties: Record<string, () => Promise<unknown>>): Promise<void> {
	for (const [name, duty] of Object.entries(duties)) {
		try {
			await duty();
		} catch (error) {
			console.error(
				`scheduled: ${name} failed with ${error instanceof Error ? error.name : "unknown"}`,
			);
		}
	}
}

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
	const now = controller.scheduledTime;
	if (controller.cron === EVERY_MINUTE) {
		// The hour's first minute is the hourly run's: its reminders follow auto-lock and the lock date.
		const hoursFirst = now % HOUR_MS < MINUTE_MS;
		// The invitations and the mailings share one batch (TS-108).
		let invitations = 0;
		await runEach({
			webhooks: () => dispatchWebhooks({ now }),
			invitations: async () => {
				invitations = await sendWaitingInvitations(new Date(now));
			},
			mail: () => sendWaitingMail(new Date(now), MAIL_BATCH - invitations),
			notificationEmails: () => sendWaitingNotifications(new Date(now)),
			exports: () => advanceExports(new Date(now)),
			...(hoursFirst ? {} : { reminders: () => runReminders(now) }),
		});
	}
	if (controller.cron === HOURLY) {
		await runEach({
			autoLock: () => runAutoLock(now),
			lockReach: () => runLockReach(now),
			billing: () => runBillingSchedule(now),
			expiredExports: () => deleteExpiredExports(new Date(now)),
			reminders: () => runReminders(now),
		});
	}
	if (controller.cron === DAILY) {
		await runEach({
			activity: () => deleteExpiredActivity(env.DB, new Date(now)),
			signIns: () => platformData.deleteOldSignIns(env.DB, new Date(now)),
			notifications: () => deleteExpiredNotifications(new Date(now)),
			contracts: () => deleteExpiredContracts(env.DB, new Date(now)),
			domains: () => recheckDomains(new Date(now)),
		});
	}
}
