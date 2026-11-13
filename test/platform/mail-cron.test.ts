import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformData } from "~/db";
import { DAILY_MAIL_CAP, MAIL_BATCH } from "~/platform/limits";
import { isUnsubscribeSignature, kindOfLinkWord, sendWaitingMail } from "~/platform/mail.server";
import worker from "../../workers/app";
import { EVERY_MINUTE } from "../../workers/scheduled";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { value } from "../organisations/harness";

// The mailings' queue (TS-099): each run of the minute's cron sends at most
// `MAIL_BATCH` waiting deliveries, never more than `DAILY_MAIL_CAP` in a UTC
// day; a person who has turned the kind off or whose account was closed since
// is skipped; a message Email Service did not take stays waiting and the run
// stops. Every message carries a signed one-press unsubscribe link and the
// headers that offer it (RFC 8058).

const NOW = new Date("2026-11-12T12:00:00Z");
const MINUTE = 60_000;

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** `count` account holders, `u-0001` onwards, with announcements on as every account starts. */
async function accounts(count: number) {
	await env.DB.prepare(
		`with recursive n(i) as (select 1 union all select i + 1 from n where i < ?1)
		 insert into users (id, name, email, email_verified, created_at, updated_at)
		 select printf('u-%04d', i), 'Person ' || i, 'person' || i || '@example.com', 1, ?2, ?2 from n`,
	)
		.bind(count, NOW.getTime() - 60 * MINUTE)
		.run();
}

/** An announcement to everyone who has them on, written by `u-0001`. */
function announce() {
	return platformData.createMailing(env.DB, {
		kind: "announcement",
		subject: "Something new",
		body: "Timesifier does more now.\n\nRead about it on the site.",
		sentBy: "u-0001",
	});
}

const waiting = () => value("select count(*) from mailing_deliveries where sent_at is null");
const outcome = (userId: string) =>
	value<string | null>("select outcome from mailing_deliveries where user_id = ?", userId);

describe("sending the waiting mail", () => {
	it("sends at most a batch a run, oldest first, and stops when nothing waits", async () => {
		await accounts(MAIL_BATCH + 5);
		expect((await announce()).recipients).toBe(MAIL_BATCH + 5);

		expect(await sendWaitingMail(NOW)).toBe(MAIL_BATCH);
		expect(mailbox.send).toHaveBeenCalledTimes(MAIL_BATCH);
		expect(await waiting()).toBe(5);
		expect(mailbox.sent()[0]?.to).toBe("person1@example.com");

		expect(await sendWaitingMail(new Date(NOW.getTime() + MINUTE))).toBe(5);
		expect(await sendWaitingMail(new Date(NOW.getTime() + 2 * MINUTE))).toBe(0);
		expect(mailbox.send).toHaveBeenCalledTimes(MAIL_BATCH + 5);
		expect(
			await value(
				"select count(*) from mailing_deliveries where outcome = 'sent' and sent_at is not null",
			),
		).toBe(MAIL_BATCH + 5);
	});

	it("stops at the day's cap, counting the UTC day, and goes on the next day", async () => {
		await accounts(DAILY_MAIL_CAP + 10);
		await announce();
		// All but three of the day's messages were sent this morning; one more, yesterday, does not count.
		await env.DB.prepare(
			`update mailing_deliveries set sent_at = ?, outcome = 'sent'
			 where user_id in (select id from users order by id limit ?)`,
		)
			.bind(Date.parse("2026-11-12T00:30:00Z"), DAILY_MAIL_CAP - 3)
			.run();
		await env.DB.prepare(
			"update mailing_deliveries set sent_at = ?, outcome = 'sent' where user_id = ?",
		)
			.bind(Date.parse("2026-11-11T23:59:00Z"), `u-${String(DAILY_MAIL_CAP - 2).padStart(4, "0")}`)
			.run();

		expect(await sendWaitingMail(NOW)).toBe(3);
		expect(await sendWaitingMail(new Date(NOW.getTime() + MINUTE))).toBe(0);
		expect(mailbox.send).toHaveBeenCalledTimes(3);
		expect(await waiting()).toBe(9);

		// Midnight UTC starts a new day's cap.
		expect(await sendWaitingMail(new Date("2026-11-13T00:00:00Z"))).toBe(9);
		expect(await waiting()).toBe(0);
	});

	it("skips a person who turned the kind off or whose account was closed since", async () => {
		await accounts(4);
		await announce();
		await platformData.setMailChoice(env.DB, "u-0002", "announcement", false);
		await platformData.setAccountClosed(env.DB, "u-0003", NOW);

		expect(await sendWaitingMail(NOW)).toBe(2);

		expect(mailbox.sent().map((m) => m.to)).toEqual(["person1@example.com", "person4@example.com"]);
		expect([
			await outcome("u-0001"),
			await outcome("u-0002"),
			await outcome("u-0003"),
			await outcome("u-0004"),
		]).toEqual(["sent", "skipped", "skipped", "sent"]);
		expect(await waiting()).toBe(0);
		// A skipped message is no message: it takes nothing of the day's cap.
		expect(await platformData.sentSince(env.DB, new Date("2026-11-12T00:00:00Z"))).toBe(2);
	});

	it("stops, and leaves the message waiting, when Email Service does not take it", async () => {
		await accounts(4);
		await announce();
		mailbox.send
			.mockResolvedValueOnce({ messageId: "1" })
			.mockRejectedValueOnce(
				Object.assign(new Error("refused"), { code: "E_RATE_LIMIT_EXCEEDED" }),
			);
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await sendWaitingMail(NOW)).toBe(1);

		expect(mailbox.send).toHaveBeenCalledTimes(2);
		expect(await outcome("u-0001")).toBe("sent");
		expect(await outcome("u-0002")).toBeNull();
		expect(await waiting()).toBe(3);

		// The next run starts again with the one that failed.
		expect(await sendWaitingMail(new Date(NOW.getTime() + MINUTE))).toBe(3);
		expect(mailbox.sent().at(1)?.to).toBe("person2@example.com");
		expect(mailbox.sent().at(2)?.to).toBe("person2@example.com");
	});

	it("puts a signed one-press unsubscribe link in every message, and its headers", async () => {
		await accounts(3);
		await announce();
		await platformData.setMailChoice(env.DB, "u-0002", "newsletter", true);
		await platformData.createMailing(env.DB, {
			kind: "newsletter",
			subject: "November",
			body: "The month's news.",
			sentBy: "u-0001",
		});

		expect(await sendWaitingMail(NOW)).toBe(4);

		for (const [message] of mailbox.send.mock.calls) {
			const { to, text, html, headers } = message as {
				to: string;
				text: string;
				html: string;
				headers?: Record<string, string>;
			};
			expect(headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
			const link = headers?.["List-Unsubscribe"]?.match(/^<(.+)>$/)?.[1] ?? "";
			const [, word, userId, signature] =
				new URL(link).pathname.match(/^\/unsubscribe\/([^/]+)\/([^/]+)\/([^/]+)$/) ?? [];
			const kind = kindOfLinkWord(word ?? "");
			expect(kind).not.toBeNull();
			expect(to).toBe(`person${Number(userId?.slice(2))}@example.com`);
			expect(
				await isUnsubscribeSignature(kind ?? "announcement", userId ?? "", signature ?? ""),
			).toBe(true);
			// The link is in the message itself too, for a mail program that offers no button.
			expect(text).toContain(link);
			expect(html).toContain(link);
			// And it signs that kind for that person only.
			const other = kind === "newsletter" ? "announcement" : "newsletter";
			expect(await isUnsubscribeSignature(other, userId ?? "", signature ?? "")).toBe(false);
			expect(await isUnsubscribeSignature(kind ?? "announcement", "u-0009", signature ?? "")).toBe(
				false,
			);
		}
		expect(
			mailbox
				.sent()
				.filter((m) => m.subject === "November")
				.map((m) => m.to),
		).toEqual(["person2@example.com"]);
	});
});

describe("the minute's cron", () => {
	it("sends the waiting mail", async () => {
		await accounts(2);
		await announce();

		const controller = createScheduledController({
			scheduledTime: NOW.getTime(),
			cron: EVERY_MINUTE,
		});
		const context = createExecutionContext();
		await worker.scheduled(controller, env, context);
		await waitOnExecutionContext(context);

		expect(mailbox.sent().map((m) => m.to)).toEqual(["person1@example.com", "person2@example.com"]);
		expect(await waiting()).toBe(0);
	});
});
