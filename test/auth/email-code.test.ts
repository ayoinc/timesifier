import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_CODE_LENGTH } from "~/auth/code";
import { freshDatabase } from "../db/database";
import {
	captureEmail,
	countRows,
	type Mailbox,
	post,
	requestCode,
	sessionCookie,
	signIn,
	TURNSTILE_TOKEN,
	whoIs,
	wrongCode,
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
		const wrong = wrongCode(right);

		const response = await post("/sign-in/email-otp", { email: EMAIL, otp: wrong });

		expect(response.status).toBe(400);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(await countRows("users")).toBe(0);
		expect(await countRows("sessions")).toBe(0);
	});

	it("stops accepting a code after three wrong attempts, even the right one", async () => {
		await requestCode(EMAIL);
		const right = await mailbox.codeFor(EMAIL);
		const wrong = wrongCode(right);

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
		expect(await mailbox.codeFor("nobody@example.com")).toMatch(/^\d{8}$/);
	});

	it("sends a code of eight digits, the length the sign-in page asks for", async () => {
		await requestCode(EMAIL);
		await vi.waitFor(() => expect(mailbox.sent()).toHaveLength(1));

		const digits = mailbox.sent()[0]?.text.match(/\d+/)?.[0];

		expect(digits).toHaveLength(8);
		expect(SIGN_IN_CODE_LENGTH).toBe(8);
	});

	it("keeps the code in the database as a keyed hash: neither the code nor its plain SHA-256 is there", async () => {
		await requestCode(EMAIL);
		const code = await mailbox.codeFor(EMAIL);
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)),
		);
		const base64 = btoa(String.fromCharCode(...digest));
		// However the digest is written down: Better Auth's own way is the second.
		const plainHashes = [
			base64,
			base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
			Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
		];

		const stored = await env.DB.prepare(
			"select value from verifications where identifier like 'sign-in-otp-%'",
		).first<string>("value");

		expect(stored).toBeTruthy();
		expect(stored).not.toContain(code);
		for (const hash of plainHashes) expect(stored).not.toContain(hash);
	});
});

describe("the codes one address can be sent", () => {
	/** The messages that carry a sign-in code to `email`. */
	const codesSentTo = (email: string) => mailbox.sent().filter(({ to }) => to === email).length;
	/** Asks from a client of its own, so the limit of three a minute per client is never what answers. */
	let clients = 0;
	const ask = (email: string) => requestCode(email, { client: `192.0.2.${++clients}` });

	it("are five in an hour, whoever asks and however the address is written: the sixth request is answered like the first and nothing is issued or sent", async () => {
		const first = await ask(EMAIL);
		for (const written of ["ADA@example.com", "Ada@Example.COM", EMAIL, EMAIL]) await ask(written);
		await vi.waitFor(() => expect(codesSentTo(EMAIL)).toBe(5));

		const sixth = await ask(EMAIL);
		// A request for somebody else is served, and its message comes after
		// anything the sixth would have sent.
		const other = await ask("grace@example.com");
		await mailbox.codeFor("grace@example.com");

		expect([first.status, sixth.status, other.status]).toEqual([200, 200, 200]);
		expect(await sixth.text()).toBe(await first.text());
		expect([...sixth.headers.keys()].sort()).toEqual([...first.headers.keys()].sort());
		expect(codesSentTo(EMAIL)).toBe(5);
		expect(
			await env.DB.prepare(
				"select count(*) as n from verifications where identifier = 'sign-in-otp-ada@example.com'",
			).first("n"),
			"codes stored",
		).toBe(5);
	});

	it("are counted over any hour, not over hours by the clock", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.now();
		const at = async (minutes: number) => {
			vi.setSystemTime(start + minutes * 60_000);
			await ask(EMAIL);
			// A message to somebody else marks the point by which one would have been sent.
			await ask(`at-${minutes}@example.com`);
			await mailbox.codeFor(`at-${minutes}@example.com`);
			return codesSentTo(EMAIL);
		};

		const sent = [];
		for (const minutes of [0, 15, 30, 45, 50, 59, 61, 62]) sent.push(await at(minutes));

		// Five by minute 50. Refused at 59. At 61 the first is over an hour old;
		// at 62 the last hour again holds five.
		expect(sent).toEqual([1, 2, 3, 4, 5, 5, 6, 6]);
	});

	it("keeps no address in the row that counts them", async () => {
		await ask(EMAIL);
		await mailbox.codeFor(EMAIL);

		const { results } = await env.DB.prepare(
			"select identifier, value from verifications where identifier not like 'sign-in-otp-%'",
		).all<{ identifier: string; value: string }>();

		expect(results).toHaveLength(1);
		expect(JSON.stringify(results)).not.toMatch(/ada|example/i);
	});

	it("does not count a request that Turnstile refused", async () => {
		for (let n = 0; n < 5; n++) {
			await requestCode(EMAIL, {
				client: `192.0.2.${++clients}`,
				headers: { "x-captcha-response": "" },
			});
		}

		await ask(EMAIL);

		expect(await mailbox.codeFor(EMAIL)).toMatch(/^\d{8}$/);
	});
});

describe("what is not offered", () => {
	it("has no password sign-up or sign-in", async () => {
		const credentials = { email: EMAIL, password: "correct horse battery staple", name: "Ada" };

		const signUp = await post("/sign-up/email", credentials);
		const signInWithPassword = await post("/sign-in/email", credentials);

		expect(signUp.status).toBe(404);
		expect(signInWithPassword.status).toBe(404);
		expect(await countRows("users")).toBe(0);
	});

	it.each([
		"/email-otp/request-password-reset",
		"/forget-password/email-otp",
		"/email-otp/reset-password",
		"/email-otp/request-email-change",
		"/email-otp/change-email",
		"/email-otp/verify-email",
		"/email-otp/check-verification-otp",
	])("answers 404 on %s, and sends nothing", async (path) => {
		const response = await post(path, { email: EMAIL, otp: "000000", password: "x".repeat(16) });

		expect(response.status).toBe(404);
		expect(mailbox.sent()).toEqual([]);
	});

	it.each(["email-verification", "forget-password", "change-email"])(
		"refuses a request for a %s code, even for an address with an account: nothing is stored or sent",
		async (type) => {
			await signIn(mailbox, EMAIL);

			const response = await post(
				"/email-otp/send-verification-otp",
				{ email: EMAIL, type },
				{ headers: { "x-captcha-response": TURNSTILE_TOKEN } },
			);

			expect(response.status).toBe(400);
			expect(await countRows("codes")).toBe(0);
			expect(mailbox.sent(), "only the sign-in code from before").toHaveLength(1);
		},
	);

	it.each([
		["a name", { name: "A name of a stranger's choosing" }],
		["an image", { image: "https://elsewhere.example/tracker.png" }],
	])("takes %s from nobody, not even for a new account", async (_name, extra) => {
		await requestCode(EMAIL);
		const otp = await mailbox.codeFor(EMAIL);

		const response = await post("/sign-in/email-otp", { email: EMAIL, otp, ...extra });

		expect(response.status).toBe(400);
		expect(await countRows("users")).toBe(0);
	});

	it("answers 415 to a body that is not JSON", async () => {
		const response = await post("/sign-in/email-otp", "email=ada", {
			headers: { "Content-Type": "text/plain" },
		});

		expect(response.status).toBe(415);
	});
});
