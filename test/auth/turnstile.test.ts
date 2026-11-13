/**
 * These tests call Turnstile's real `siteverify` endpoint with the test secret
 * keys Cloudflare publishes for the purpose. They need the network.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../db/database";
import {
	captureEmail,
	countRows,
	get,
	type Mailbox,
	post,
	requestCode,
	setBinding,
	TURNSTILE_SECRET_THAT_FAILS,
} from "./harness";

const EMAIL = "ada@example.com";

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Turnstile on the request that sends a sign-in code", () => {
	it("lets the request through with a token Turnstile accepts", async () => {
		const response = await requestCode(EMAIL);

		expect(response.status).toBe(200);
		expect(await countRows("codes")).toBe(1);
		// Sent after the answer, once the platform's brand is read.
		await vi.waitFor(() => expect(mailbox.sent()).toHaveLength(1));
	});

	it("refuses a token Turnstile rejects, and creates and sends no code", async () => {
		setBinding("TURNSTILE_SECRET_KEY", TURNSTILE_SECRET_THAT_FAILS);

		const response = await requestCode(EMAIL);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "VERIFICATION_FAILED" });
		expect(await countRows("codes")).toBe(0);
		expect(mailbox.sent()).toEqual([]);
	});

	it("refuses a request with no token, and creates and sends no code", async () => {
		const response = await post("/email-otp/send-verification-otp", {
			email: EMAIL,
			type: "sign-in",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "MISSING_RESPONSE" });
		expect(await countRows("codes")).toBe(0);
		expect(mailbox.sent()).toEqual([]);
	});

	// With a real secret the answer comes from Cloudflare's servers for a token a
	// person solved, which no test can have. Here `siteverify` is answered for it.
	describe("the site a token was solved on", () => {
		const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

		/** Makes Turnstile accept every token as one solved on `hostname`. */
		function solvedOn(hostname: string | undefined) {
			setBinding("TURNSTILE_SECRET_KEY", "0x4AAAAAAA-a-secret-that-is-not-a-test-secret");
			const real = globalThis.fetch;
			vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
				String(input instanceof Request ? input.url : input) === SITEVERIFY
					? Promise.resolve(Response.json({ success: true, hostname, "error-codes": [] }))
					: real(input, init),
			);
		}

		it.each([
			["production", "https://timesifier.example", "timesifier.example"],
			["preview", "https://pr-12-timesifier.acme.workers.dev", "pr-12-timesifier.acme.workers.dev"],
		])(
			"in %s, accepts one solved on the host the request was made to",
			async (environment, origin, hostname) => {
				setBinding("ENVIRONMENT", environment);
				solvedOn(hostname);

				const response = await requestCode(EMAIL, { origin });

				expect(response.status).toBe(200);
				expect(await countRows("codes")).toBe(1);
			},
		);

		it.each([
			["production", "https://timesifier.example", "elsewhere.example"],
			["production", "https://timesifier.example", "pr-12-timesifier.acme.workers.dev"],
			["production", "https://timesifier.example", "www.timesifier.example"],
			["production", "https://timesifier.example", undefined],
			["preview", "https://pr-12-timesifier.acme.workers.dev", "pr-13-timesifier.acme.workers.dev"],
			["preview", "https://pr-12-timesifier.acme.workers.dev", "timesifier.example"],
			// The hostname of Cloudflare's test keys means nothing without a test secret.
			["production", "https://timesifier.example", "example.com"],
			["preview", "https://pr-12-timesifier.acme.workers.dev", "example.com"],
		])(
			"in %s on %s, refuses one solved on %s, and creates and sends no code",
			async (environment, origin, hostname) => {
				setBinding("ENVIRONMENT", environment);
				solvedOn(hostname);

				const response = await requestCode(EMAIL, { origin });

				expect(response.status).toBe(403);
				expect(await response.json()).toMatchObject({ code: "VERIFICATION_FAILED" });
				expect(await countRows("codes")).toBe(0);
				expect(mailbox.sent()).toEqual([]);
			},
		);

		it("with a test secret, accepts the one hostname Cloudflare's test keys answer with, on any host", async () => {
			setBinding("ENVIRONMENT", "preview");
			const origin = "https://pr-12-timesifier.acme.workers.dev";

			// Not answered for: this is Cloudflare's own answer to its test secret.
			const response = await requestCode(EMAIL, { origin });

			expect(response.status).toBe(200);
			expect(await countRows("codes")).toBe(1);
		});
	});

	it("does not stand in front of a request that sends no code", async () => {
		setBinding("TURNSTILE_SECRET_KEY", TURNSTILE_SECRET_THAT_FAILS);

		const response = await get("/get-session");

		expect(response.status).toBe(200);
	});
});
