import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { organisationScope, setNotificationChoice, uuidv7 } from "~/db";
import { KIND_WORDS, NOTIFICATION_RETENTION_DAYS } from "~/notifications/kinds";
import { NOTIFICATION_EMAILS_PER_RUN, sendWaitingNotifications } from "~/notifications/mail.server";
import { notify } from "~/notifications/notify.server";
import type { NewNotification } from "~/notifications/words";
import worker from "../../workers/app";
import { DAILY, EVERY_MINUTE } from "../../workers/scheduled";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation } from "../organisations/harness";
import { open, type Person, person, textOf } from "../pages/harness";

// A notification's email (TS-049, decision 69): always in the bell, by email
// unless its person turned its kind off, at most 100 a run, given up after a
// day, and the notification itself deleted 90 days after it was made.

const DAY = 24 * 60 * 60 * 1000;

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string; slug: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	mailbox.send.mockClear();
}, 30_000);

const decided = (
	title = "Your timesheet for 9–15 November 2026 was approved.",
): NewNotification => ({
	userId: ada.user.id,
	kind: "week-decided",
	title,
	body: "The reason given: Tuesday & Wednesday",
	path: "?view=week&start=2026-11-09",
});

const sentNow = () => sendWaitingNotifications(new Date());
const stateOf = async () =>
	(
		await env.DB.prepare("select email_state as state from notifications order by rowid").all<{
			state: string;
		}>()
	).results.map(({ state }) => state);

describe("a notification's email", () => {
	it("says the kind's words, the organisation, the notification, where it leads and how to stop it", async () => {
		await notify(organisationScope(env.DB, acme.id), [decided()]);
		expect(await sentNow()).toBe(1);
		const [message] = mailbox.sent();
		expect(message?.to).toBe("ada@example.com");
		expect(message?.subject).toBe(KIND_WORDS["week-decided"].subject);
		expect(message?.text).toContain(
			"In “Acme”: Your timesheet for 9–15 November 2026 was approved.",
		);
		expect(message?.text).toContain("The reason given: Tuesday & Wednesday");
		expect(message?.text).toContain(
			"https://timesifier.example/app/acme?view=week&start=2026-11-09",
		);
		expect(message?.text).toContain("https://timesifier.example/app/acme/account#notifications");
		expect(message?.text).toContain(KIND_WORDS["week-decided"].reason);
		// What a person typed goes in the body alone, escaped: never in the subject.
		expect(message?.html).toContain("Tuesday &amp; Wednesday");
		expect(await stateOf()).toEqual(["sent"]);
		// Sent once.
		expect(await sentNow()).toBe(0);
	});

	it("is not sent when its person turned the kind off; the bell still has it, and other kinds still go", async () => {
		await setNotificationChoice(env.DB, ada.user.id, "week-decided", false);
		await notify(organisationScope(env.DB, acme.id), [
			decided(),
			{ ...decided("Your request for overtime was approved."), kind: "request-decided" },
		]);
		expect(await sentNow()).toBe(1);
		expect(mailbox.sent().map(({ subject }) => subject)).toEqual([
			KIND_WORDS["request-decided"].subject,
		]);
		expect(await stateOf()).toEqual(["skipped", "sent"]);
		expect(
			await env.DB.prepare("select count(*) as n from notifications where read_at is null").first(
				"n",
			),
		).toBe(2);

		// Turned on again, the next one goes.
		await setNotificationChoice(env.DB, ada.user.id, "week-decided", true);
		await notify(organisationScope(env.DB, acme.id), [decided()]);
		expect(await sentNow()).toBe(1);
	});

	it("goes at most 100 a run; the rest wait for the next", async () => {
		const scope = organisationScope(env.DB, acme.id);
		for (let batch = 0; batch < 3; batch++) {
			await notify(
				scope,
				Array.from({ length: 50 }, (_, i) => decided(`Week ${batch * 50 + i}.`)),
			);
		}
		expect(NOTIFICATION_EMAILS_PER_RUN).toBe(100);
		expect(await sentNow()).toBe(100);
		expect(await sentNow()).toBe(50);
		expect(await sentNow()).toBe(0);
		expect(mailbox.sent()).toHaveLength(150);
	});

	it("that has waited more than a day is given up, and one that has not still goes", async () => {
		await notify(organisationScope(env.DB, acme.id), [decided("Old."), decided("New.")]);
		const now = Date.now();
		await env.DB.prepare("update notifications set created_at = ? where title = 'Old.'")
			.bind(now - DAY - 60_000)
			.run();
		await env.DB.prepare("update notifications set created_at = ? where title = 'New.'")
			.bind(now - DAY + 60_000)
			.run();
		expect(await sendWaitingNotifications(new Date(now))).toBe(1);
		expect(mailbox.sent().map(({ text }) => text.includes("New."))).toEqual([true]);
		expect(await stateOf()).toEqual(["skipped", "sent"]);
	});

	it("that cannot be sent stops the run, and it and the rest go on the next", async () => {
		await notify(organisationScope(env.DB, acme.id), [decided("First."), decided("Second.")]);
		mailbox.send.mockRejectedValueOnce(new Error("Email is down"));
		expect(await sentNow()).toBe(0);
		expect(await stateOf()).toEqual(["waiting", "waiting"]);
		expect(await sentNow()).toBe(2);
	});

	it("is sent by the scheduled handler every minute", async () => {
		await notify(organisationScope(env.DB, acme.id), [decided()]);
		const context = createExecutionContext();
		await worker.scheduled(
			createScheduledController({ scheduledTime: Date.now(), cron: EVERY_MINUTE }),
			env,
			context,
		);
		await waitOnExecutionContext(context);
		expect(await stateOf()).toEqual(["sent"]);
	});
});

describe("a notification's keeping", () => {
	it("is 90 days: the daily job deletes older ones, in every organisation, and the notice says so", async () => {
		const now = Date.parse("2026-11-24T03:17:00Z");
		const made = (days: number) =>
			env.DB.prepare(
				"insert into notifications (id, organisation_id, user_id, kind, title, path, email_state, created_at) values (?, ?, ?, 'week-decided', ?, '', 'sent', ?)",
			)
				.bind(uuidv7(), acme.id, ada.user.id, String(days), now - days * DAY)
				.run();
		await made(NOTIFICATION_RETENTION_DAYS - 1);
		await made(NOTIFICATION_RETENTION_DAYS + 1);

		const context = createExecutionContext();
		await worker.scheduled(
			createScheduledController({ scheduledTime: now, cron: DAILY }),
			env,
			context,
		);
		await waitOnExecutionContext(context);

		const { results } = await env.DB.prepare("select title from notifications").all<{
			title: string;
		}>();
		expect(results.map(({ title }) => title)).toEqual([String(NOTIFICATION_RETENTION_DAYS - 1)]);
		expect(NOTIFICATION_RETENTION_DAYS).toBe(90);
		expect(textOf(await (await open("/privacy")).text())).toContain(
			`A notification Each is deleted ${NOTIFICATION_RETENTION_DAYS} days after it was made, by a job that runs every day. Its email is sent within a day of it, or not at all.`,
		);
	});
});
