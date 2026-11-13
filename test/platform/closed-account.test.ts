import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformData, uuidv7 } from "~/db";
import worker from "../../workers/app";
import { DAILY } from "../../workers/scheduled";
import {
	captureEmail,
	codeCookie,
	type Mailbox,
	post,
	requestCode,
	signIn,
	whoIs,
} from "../auth/harness";
import { freshDatabase } from "../db/database";
import { answer, value } from "../organisations/harness";

// Closing an account from the console (TS-099): its sessions end at once, and
// it starts no new one, by any sign-in, until it is restored. Every sign-in is
// kept for the account's history as the browser's kind and nothing finer, for
// 90 days.

const DAY = 86_400_000;
const CHROME_ON_MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FIREFOX_ON_WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A sign-in with a code, through the Worker, as the sign-in page makes it. */
async function signingIn(email: string) {
	const client = "198.51.100.77";
	const asked = await requestCode(email, { client });
	expect(asked.status).toBe(200);
	return post(
		"/sign-in/email-otp",
		{ email, otp: await mailbox.codeFor(email) },
		{ client, cookie: codeCookie(asked) },
	);
}

const sessionsOf = (userId: string) =>
	value("select count(*) from sessions where user_id = ?", userId);

describe("a closed account", () => {
	it("loses every session the moment it is closed", async () => {
		const first = await signIn(mailbox, "ada@example.com");
		const second = await signIn(mailbox, "ada@example.com");
		const bola = await signIn(mailbox, "bola@example.com");
		expect(await sessionsOf(first.user.id)).toBe(2);

		expect(await platformData.setAccountClosed(env.DB, first.user.id, new Date())).toBe(true);

		expect(await sessionsOf(first.user.id)).toBe(0);
		expect(await whoIs(first.cookie)).toBeNull();
		expect(await whoIs(second.cookie)).toBeNull();
		expect(await platformData.isAccountClosed(env.DB, first.user.id)).toBe(true);
		// Nobody else's.
		expect(await whoIs(bola.cookie)).toMatchObject({ id: bola.user.id });
		expect(await platformData.setAccountClosed(env.DB, "no-such-account", new Date())).toBe(false);
	});

	it("cannot sign in with a code, and can again once restored", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		await platformData.setAccountClosed(env.DB, ada.user.id, new Date());

		const refused = await signingIn("ada@example.com");

		expect(await answer(refused)).toEqual({
			status: 403,
			body: { code: "ACCOUNT_CLOSED", message: "This account is closed." },
		});
		expect(await sessionsOf(ada.user.id)).toBe(0);

		expect(await platformData.setAccountClosed(env.DB, ada.user.id, null)).toBe(true);
		expect(await platformData.isAccountClosed(env.DB, ada.user.id)).toBe(false);

		const again = await signIn(mailbox, "ada@example.com");
		expect(again.user.id).toBe(ada.user.id);
		expect(await whoIs(again.cookie)).toMatchObject({ id: ada.user.id });
	});
});

describe("the sign-in history", () => {
	it("keeps each sign-in with the browser's kind, and nothing finer", async () => {
		const ada = await signIn(mailbox, "ada@example.com", {
			headers: { "User-Agent": CHROME_ON_MAC },
		});
		await signIn(mailbox, "ada@example.com", { headers: { "User-Agent": FIREFOX_ON_WINDOWS } });

		const kept = await env.DB.prepare(
			"select device from sign_ins where user_id = ? order by created_at, id",
		)
			.bind(ada.user.id)
			.all<{ device: string }>();
		expect(kept.results.map((r) => r.device)).toEqual(["Chrome on macOS", "Firefox on Windows"]);
		// The table has no room for an address or the whole user agent.
		const columns = await env.DB.prepare("select name from pragma_table_info('sign_ins')").all<{
			name: string;
		}>();
		expect(columns.results.map((c) => c.name).sort()).toEqual([
			"created_at",
			"device",
			"id",
			"user_id",
		]);
	});

	it("keeps sign-ins for 90 days: the daily cron deletes older ones", async () => {
		const ada = await signIn(mailbox, "ada@example.com");
		const now = Date.parse("2026-11-12T03:17:00Z");
		const insert = env.DB.prepare(
			"insert into sign_ins (id, user_id, device, created_at) values (?, ?, 'Safari on iOS', ?)",
		);
		await env.DB.batch([
			insert.bind(uuidv7(), ada.user.id, now - 91 * DAY),
			insert.bind(uuidv7(), ada.user.id, now - 90 * DAY - 1),
			insert.bind(uuidv7(), ada.user.id, now - 90 * DAY),
			insert.bind(uuidv7(), ada.user.id, now - 89 * DAY),
		]);
		const total = await value("select count(*) from sign_ins where user_id = ?", ada.user.id);

		await platformData.deleteOldSignIns(env.DB, new Date(now));
		expect(await value("select count(*) from sign_ins where user_id = ?", ada.user.id)).toBe(
			(total ?? 0) - 2,
		);
		expect(await value("select min(created_at) from sign_ins where user_id = ?", ada.user.id)).toBe(
			now - 90 * DAY,
		);

		// The same rule is what the daily cron runs: a day later the 90-day-old one goes too.
		const controller = createScheduledController({ scheduledTime: now + DAY, cron: DAILY });
		const context = createExecutionContext();
		await worker.scheduled(controller, env, context);
		await waitOnExecutionContext(context);
		expect(await value("select min(created_at) from sign_ins where user_id = ?", ada.user.id)).toBe(
			now - 89 * DAY,
		);
	});
});
