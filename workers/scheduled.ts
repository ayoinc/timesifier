import { deleteExpiredActivity } from "~/activity/activity.server";
import { platformData } from "~/db";
import { dispatchWebhooks } from "~/integrations/webhooks.server";
import { runBillingSchedule } from "~/invoices/schedule.server";
import { runAutoLock } from "~/locks/locks.server";
import { sendWaitingMail } from "~/platform/mail.server";

/**
 * The Worker's background work, run by the Cron Triggers in wrangler.jsonc.
 * Each run is one short sequence of named steps, chosen by its trigger.
 *
 * - Every minute: the webhooks' deliveries that are due are sent (TS-087), and
 *   the next mailings to account holders, within the day's cap (TS-099).
 * - Every hour: auto-lock (TS-065); recurring invoices that are due are issued
 *   and overdue invoices are reminded (TS-074, TS-078).
 * - Every day at 03:17 UTC: rows past their retention are deleted: activity
 *   records after 730 days (TS-072), sign-ins after 90 (TS-099). TS-033 adds
 *   the other tables here.
 */

/** The triggers, as wrangler.jsonc names them. */
export const EVERY_MINUTE = "* * * * *";
export const HOURLY = "0 * * * *";
export const DAILY = "17 3 * * *";

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
	const now = controller.scheduledTime;
	if (controller.cron === EVERY_MINUTE) {
		await dispatchWebhooks({ now });
		await sendWaitingMail(new Date(now));
	}
	if (controller.cron === HOURLY) {
		await runAutoLock(now);
		await runBillingSchedule(now);
	}
	if (controller.cron === DAILY) {
		await deleteExpiredActivity(env.DB, new Date(now));
		await platformData.deleteOldSignIns(env.DB, new Date(now));
	}
}
