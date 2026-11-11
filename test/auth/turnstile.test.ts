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
		expect(await countRows("verifications")).toBe(1);
		expect(mailbox.sent()).toHaveLength(1);
	});

	it("refuses a token Turnstile rejects, and creates and sends no code", async () => {
		setBinding("TURNSTILE_SECRET_KEY", TURNSTILE_SECRET_THAT_FAILS);

		const response = await requestCode(EMAIL);

		expect(response.status).toBe(403);
		expect(await countRows("verifications")).toBe(0);
		expect(mailbox.sent()).toEqual([]);
	});

	it("refuses a request with no token, and creates and sends no code", async () => {
		const response = await post("/email-otp/send-verification-otp", {
			email: EMAIL,
			type: "sign-in",
		});

		expect(response.status).toBe(400);
		expect(await countRows("verifications")).toBe(0);
		expect(mailbox.sent()).toEqual([]);
	});

	it("does not stand in front of passkey sign-in", async () => {
		const response = await get("/passkey/generate-authenticate-options");

		expect(response.status).toBe(200);
	});
});
