import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../db/database";
import {
	captureEmail,
	countRows,
	type Mailbox,
	post,
	requestCode,
	sessionCookie,
	setBinding,
	signIn,
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

/** Every line written to the console while `run` runs. */
async function logLinesDuring(run: () => Promise<unknown>): Promise<string[]> {
	const lines: string[] = [];
	for (const level of ["debug", "log", "info", "warn", "error"] as const) {
		vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
			lines.push(parts.map(String).join(" "));
		});
	}
	await run();
	return lines;
}

function occurrences(text: string, part: string): number {
	return text.split(part).length - 1;
}

describe("the sign-in code email", () => {
	it("comes from no-reply@mail.timesifier.com and carries the code once", async () => {
		await requestCode(EMAIL);
		const code = await mailbox.codeFor(EMAIL);

		expect(mailbox.sent()).toHaveLength(1);
		const [message] = mailbox.sent();
		expect(message?.from).toEqual({ name: "Timesifier", email: "no-reply@mail.timesifier.com" });
		expect(message?.to).toBe(EMAIL);
		expect(occurrences(message?.text ?? "", code)).toBe(1);
		expect(occurrences(message?.html ?? "", code)).toBe(1);
		expect(message?.subject).not.toContain(code);
	});

	it("has no link, image or other remote content", async () => {
		await requestCode(EMAIL);
		await mailbox.codeFor(EMAIL);

		const [message] = mailbox.sent();
		for (const body of [message?.text ?? "", message?.html ?? ""]) {
			expect(body).not.toMatch(/https?:|<img|<a\b|<link|<script|src=|href=/i);
		}
	});
});

describe("sending email", () => {
	it("sends nothing where there is no EMAIL binding, and the log names only the recipient's domain", async () => {
		setBinding("EMAIL", undefined);

		let response: Response | undefined;
		const lines = await logLinesDuring(async () => {
			response = await requestCode(EMAIL);
		});

		expect(response?.status).toBe(200);
		expect(mailbox.send).not.toHaveBeenCalled();
		expect(await countRows("verifications"), "the code is still created").toBe(1);
		expect(lines).toEqual([
			"email: not sent, this environment has no EMAIL binding (recipient at example.com)",
		]);
	});

	it("answers the request and logs no address when Email Service refuses the message", async () => {
		const refusal = Object.assign(new Error(`cannot deliver to ${EMAIL}`), {
			code: "E_SENDER_NOT_VERIFIED",
		});
		mailbox.send.mockRejectedValue(refusal);

		let response: Response | undefined;
		const lines = await logLinesDuring(async () => {
			response = await requestCode(EMAIL);
			await vi.waitFor(() => expect(mailbox.send).toHaveBeenCalled());
		});

		expect(response?.status).toBe(200);
		await vi.waitFor(() =>
			expect(lines).toEqual([
				"email: send failed with E_SENDER_NOT_VERIFIED (recipient at example.com)",
			]),
		);
	});
});

describe("logs", () => {
	it("carry no address, code, cookie or token through a whole sign-in, sign-out and refused attempts", async () => {
		const secrets: string[] = [EMAIL];
		const lines = await logLinesDuring(async () => {
			const { response, cookie } = await signIn(mailbox, EMAIL);
			const code = await mailbox.codeFor(EMAIL);
			const value = sessionCookie(response).split("=")[1] ?? "";
			// The cookie's value is `<token>.<signature>`, URL-encoded.
			secrets.push(code, value, decodeURIComponent(value), value.split(".")[0] ?? "");

			await post("/sign-in/email-otp", { email: EMAIL, otp: "000000" });
			await post("/sign-in/email-otp", { email: EMAIL });
			await post("/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" });
			await post("/revoke-sessions", {}, { cookie });
			await post("/sign-out", {}, { cookie });
		});

		for (const secret of secrets) {
			expect(secret).not.toBe("");
			expect(lines.join("\n")).not.toContain(secret);
		}
	});
});
