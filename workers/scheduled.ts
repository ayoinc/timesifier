import { deleteExpiredActivity } from "~/activity/activity.server";
import { platformData } from "~/db";
import { advanceExports, deleteExpiredExports } from "~/exports/job.server";
import { dispatchWebhooks } from "~/integrations/webhooks.server";
import { runBillingSchedule } from "~/invoices/schedule.server";
import { runAutoLock, runLockReach } from "~/locks/locks.server";
import { sendWaitingInvitations } from "~/onboarding/onboarding.server";
import { recheckDomains } from "~/organisations/domains.server";
import { MAIL_BATCH } from "~/platform/limits";
import { sendWaitingMail } from "~/platform/mail.server";

/**
 * The Worker's background work, run by the Cron Triggers in wrangler.jsonc.
 * Each run is one short sequence of named steps, chosen by its trigger.
 *
 * - Every minute: the webhooks' deliveries that are due are sent (TS-087),
 *   then the invitation emails waiting from "Invite many" and people imports
 *   (TS-108), then the next mailings to account holders: one batch between
 *   them, within the day's cap (TS-099); then one step of the oldest export
 *   of everything being made (TS-126).
 * - Every hour: auto-lock (TS-065), then the lock date reaching the days that
 *   have ended since (D7: timers on them stopped, weeks auto-submitted); recurring invoices that are due are issued
 *   and overdue invoices are reminded (TS-074, TS-078). Exports of everything
 *   7 days old are deleted, file and row (TS-126).
 * - Every day at 03:17 UTC: rows past their retention are deleted: activity
 *   records after 730 days (TS-072), sign-ins after 90 (TS-099). TS-033 adds
 *   the other tables here. Every organisation's domains are looked up again
 *   (TS-104): the owners are told once after 7 days without the record, and
 *   the domain is unverified after 14.
 */

/** The triggers, as wrangler.jsonc names them. */
export const EVERY_MINUTE = "* * * * *";
export const HOURLY = "0 * * * *";
export const DAILY = "17 3 * * *";

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
	const now = controller.scheduledTime;
	if (controller.cron === EVERY_MINUTE) {
		await dispatchWebhooks({ now });
		const invitations = await sendWaitingInvitations(new Date(now));
		await sendWaitingMail(new Date(now), MAIL_BATCH - invitations);
		await advanceExports(new Date(now));
	}
	if (controller.cron === HOURLY) {
		await runAutoLock(now);
		await runLockReach(now);
		await runBillingSchedule(now);
		await deleteExpiredExports(new Date(now));
	}
	if (controller.cron === DAILY) {
		await deleteExpiredActivity(env.DB, new Date(now));
		await platformData.deleteOldSignIns(env.DB, new Date(now));
		await recheckDomains(new Date(now));
	}
}
