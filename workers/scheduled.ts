import { deleteExpiredActivity } from "~/activity/activity.server";
import { dispatchWebhooks } from "~/integrations/webhooks.server";
import { runAutoLock } from "~/locks/locks.server";

/**
 * The Worker's background work, run by the Cron Triggers in wrangler.jsonc.
 * Each run is one short sequence of named steps, chosen by its trigger.
 *
 * - Every minute: the webhooks' deliveries that are due are sent (TS-087).
 * - Every hour: auto-lock (TS-065).
 * - Every day at 03:17 UTC: rows past their retention are deleted: activity
 *   records after 730 days (TS-072). TS-033 adds the other tables here.
 */

/** The triggers, as wrangler.jsonc names them. */
export const EVERY_MINUTE = "* * * * *";
export const HOURLY = "0 * * * *";
export const DAILY = "17 3 * * *";

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
	const now = controller.scheduledTime;
	if (controller.cron === EVERY_MINUTE) await dispatchWebhooks({ now });
	if (controller.cron === HOURLY) await runAutoLock(now);
	if (controller.cron === DAILY) await deleteExpiredActivity(env.DB, new Date(now));
}
