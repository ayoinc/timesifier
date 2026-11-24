import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteExpiredActivity } from "~/activity/activity.server";
import { deleteExpiredContracts } from "~/contracts/contracts.server";
import { advanceExports, deleteExpiredExports } from "~/exports/job.server";
import { dispatchWebhooks } from "~/integrations/webhooks.server";
import { runBillingSchedule } from "~/invoices/schedule.server";
import { runAutoLock, runLockReach } from "~/locks/locks.server";
import { deleteExpiredNotifications } from "~/notifications/bell.server";
import { sendWaitingNotifications } from "~/notifications/mail.server";
import { runReminders } from "~/notifications/reminders.server";
import { sendWaitingInvitations } from "~/onboarding/onboarding.server";
import { recheckDomains } from "~/organisations/domains.server";
import { sendWaitingMail } from "~/platform/mail.server";
import worker from "../../workers/app";
import { DAILY, EVERY_MINUTE, HOURLY } from "../../workers/scheduled";
import { freshDatabase } from "../db/database";

vi.mock("~/activity/activity.server", { spy: true });
vi.mock("~/contracts/contracts.server", { spy: true });
vi.mock("~/exports/job.server", { spy: true });
vi.mock("~/integrations/webhooks.server", { spy: true });
vi.mock("~/invoices/schedule.server", { spy: true });
vi.mock("~/locks/locks.server", { spy: true });
vi.mock("~/notifications/bell.server", { spy: true });
vi.mock("~/notifications/mail.server", { spy: true });
vi.mock("~/notifications/reminders.server", { spy: true });
vi.mock("~/onboarding/onboarding.server", { spy: true });
vi.mock("~/organisations/domains.server", { spy: true });
vi.mock("~/platform/mail.server", { spy: true });

// The scheduled handler's duties (workers/scheduled.ts): each runs on its
// own, so one that throws is logged and the others still run, in their order;
// the reminders go after the duties that come first (decision 69). Every duty
// is stubbed: this is about the handler, not what each does.

const HOUR_TWO = Date.parse("2026-11-23T16:00:00Z");

beforeEach(async () => {
	await freshDatabase();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Every duty stubbed to record its name as it runs; `failing` throws instead. */
function stubbed(failing: string[]) {
	const ran: string[] = [];
	const stub = <F extends (...args: never[]) => Promise<unknown>>(name: string, fn: F) =>
		vi.mocked(fn).mockImplementation((async () => {
			ran.push(name);
			if (failing.includes(name)) throw new Error(`${name} is down`);
		}) as unknown as F);
	stub("webhooks", dispatchWebhooks);
	stub("invitations", sendWaitingInvitations);
	stub("mail", sendWaitingMail);
	stub("notificationEmails", sendWaitingNotifications);
	stub("exports", advanceExports);
	stub("autoLock", runAutoLock);
	stub("lockReach", runLockReach);
	stub("billing", runBillingSchedule);
	stub("expiredExports", deleteExpiredExports);
	stub("reminders", runReminders);
	stub("activity", deleteExpiredActivity);
	stub("notifications", deleteExpiredNotifications);
	stub("contracts", deleteExpiredContracts);
	stub("domains", recheckDomains);
	return ran;
}

async function trigger(cron: string, scheduledTime: number) {
	const context = createExecutionContext();
	await worker.scheduled(createScheduledController({ scheduledTime, cron }), env, context);
	await waitOnExecutionContext(context);
}

describe("the scheduled duties", () => {
	it("hourly: auto-lock failing stops none of the others, and the reminders go last", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const ran = stubbed(["autoLock"]);
		await trigger(HOURLY, HOUR_TWO);
		expect(ran).toEqual(["autoLock", "lockReach", "billing", "expiredExports", "reminders"]);
		expect(error).toHaveBeenCalledWith("scheduled: autoLock failed with Error");
	});

	it("hourly: the reminders failing is logged, after the others have run", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const ran = stubbed(["billing", "reminders"]);
		await trigger(HOURLY, HOUR_TWO);
		expect(ran).toEqual(["autoLock", "lockReach", "billing", "expiredExports", "reminders"]);
		expect(error.mock.calls).toEqual([
			["scheduled: billing failed with Error"],
			["scheduled: reminders failed with Error"],
		]);
	});

	it("every minute: webhooks failing stops none of the others; the reminders go on, but in the hour's first minute", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const ran = stubbed(["webhooks"]);
		await trigger(EVERY_MINUTE, HOUR_TWO + 60_000);
		expect(ran).toEqual([
			"webhooks",
			"invitations",
			"mail",
			"notificationEmails",
			"exports",
			"reminders",
		]);
		expect(vi.mocked(runReminders)).toHaveBeenCalledWith(HOUR_TWO + 60_000);

		ran.length = 0;
		await trigger(EVERY_MINUTE, HOUR_TWO);
		expect(ran).toEqual(["webhooks", "invitations", "mail", "notificationEmails", "exports"]);
	});

	it("daily: one failing stops none of the others", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const ran = stubbed(["activity", "notifications"]);
		await trigger(DAILY, Date.parse("2026-11-24T03:17:00Z"));
		expect(ran).toEqual(["activity", "notifications", "contracts", "domains"]);
	});

	it("daily: the contracts' deletion is a duty of its own, whose failing is logged and stops nothing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const ran = stubbed(["contracts"]);
		await trigger(DAILY, Date.parse("2026-11-24T03:17:00Z"));
		expect(ran).toEqual(["activity", "notifications", "contracts", "domains"]);
		expect(error).toHaveBeenCalledWith("scheduled: contracts failed with Error");
		expect(vi.mocked(deleteExpiredContracts)).toHaveBeenCalledWith(
			env.DB,
			new Date("2026-11-24T03:17:00Z"),
		);
	});
});
