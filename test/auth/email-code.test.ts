import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../db/database";
import {
	captureEmail,
	countRows,
	type Mailbox,
	post,
	requestCode,
	sessionCookie,
	signIn,
	whoIs,
} from "./harness";

const EMAIL = "ada@example.com";

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("signing in with a code sent by email", () => {
	it("creates one user with a verified address and signs them in, the first time", async () => {
		expect((await requestCode(EMAIL)).status).toBe(200);
		expect(await countRows("users"), "asking for a code creates no account").toBe(0);

		const response = await post("/sign-in/email-otp", {
			email: EMAIL,
			otp: await mailbox.codeFor(EMAIL),
		});

		expect(response.status).toBe(200);
		expect(await countRows("users")).toBe(1);
		expect(await whoIs(sessionCookie(response))).toMatchObject({
			email: EMAIL,
			emailVerified: true,
		});
	});

	it("reaches the same user when they sign in again with a new code", async () => {
		const first = await signIn(mailbox, EMAIL);
		const second = await signIn(mailbox, EMAIL);

		expect(second.user.id).toBe(first.user.id);
		expect(second.cookie).not.toBe(first.cookie);
		expect(await countRows("users")).toBe(1);
		expect(mailbox.sent()).toHaveLength(2);
	});

	it("refuses a wrong code and creates no user and no session", async () => {
		await requestCode(EMAIL);
		const right = await mailbox.codeFor(EMAIL);
		const wrong = right === "000000" ? "000001" : "000000";

		const response = await post("/sign-in/email-otp", { email: EMAIL, otp: wrong });

		expect(response.status).toBe(400);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(await countRows("users")).toBe(0);
		expect(await countRows("sessions")).toBe(0);
	});

	it("stops accepting a code after three wrong attempts, even the right one", async () => {
		await requestCode(EMAIL);
		const right = await mailbox.codeFor(EMAIL);
		const wrong = right === "000000" ? "000001" : "000000";

		for (let attempt = 1; attempt <= 3; attempt++) {
			const refused = await post("/sign-in/email-otp", { email: EMAIL, otp: wrong });
			expect(refused.status, `wrong attempt ${attempt}`).toBe(400);
		}
		const response = await post("/sign-in/email-otp", { email: EMAIL, otp: right });

		expect(response.status).toBe(403);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(await countRows("sessions")).toBe(0);
	});

	it("refuses a code that is more than five minutes old", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		await requestCode(EMAIL);
		const code = await mailbox.codeFor(EMAIL);

		vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
		const response = await post("/sign-in/email-otp", { email: EMAIL, otp: code });

		expect(response.status).toBe(400);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(await countRows("sessions")).toBe(0);
	});

	it("accepts a code once", async () => {
		await requestCode(EMAIL);
		const code = await mailbox.codeFor(EMAIL);
		expect((await post("/sign-in/email-otp", { email: EMAIL, otp: code })).status).toBe(200);

		const again = await post("/sign-in/email-otp", { email: EMAIL, otp: code });

		expect(again.status).toBe(400);
		expect(await countRows("sessions")).toBe(1);
	});

	it("answers a request for a code the same way whether or not the address has an account", async () => {
		await signIn(mailbox, EMAIL);

		const known = await requestCode(EMAIL);
		const unknown = await requestCode("nobody@example.com");

		expect(unknown.status).toBe(known.status);
		expect(await unknown.text()).toBe(await known.text());
		expect(unknown.headers.getSetCookie()).toEqual(known.headers.getSetCookie());
		expect(await mailbox.codeFor("nobody@example.com")).toMatch(/^\d{6}$/);
	});

	it("keeps a hash of the code in the database, never the code", async () => {
		await requestCode(EMAIL);
		const code = await mailbox.codeFor(EMAIL);

		const stored = await env.DB.prepare("select value from verifications").first<string>("value");

		expect(stored).toBeTruthy();
		expect(stored).not.toContain(code);
	});
});
