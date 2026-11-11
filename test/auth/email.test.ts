import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSession } from "~/auth/auth.server";
import { freshDatabase } from "../db/database";
import {
	captureEmail,
	countRows,
	get,
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
	it("sends nothing where there is no EMAIL binding, and the log says nothing about the recipient", async () => {
		setBinding("EMAIL", undefined);

		let response: Response | undefined;
		const lines = await logLinesDuring(async () => {
			response = await requestCode(EMAIL);
		});

		expect(response?.status).toBe(200);
		expect(mailbox.send).not.toHaveBeenCalled();
		expect(await countRows("codes"), "the code is still created").toBe(1);
		expect(lines).toEqual(["email: not sent, this environment has no EMAIL binding"]);
	});

	it("answers the request and logs nothing about the recipient when Email Service refuses the message", async () => {
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
			expect(lines).toEqual(["email: send failed with E_SENDER_NOT_VERIFIED"]),
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

	// D1 refuses or drops a statement now and then. Here a table is gone, which
	// fails the same way: Drizzle throws an error whose message is the statement
	// and its parameters.
	it.each([
		{
			table: "verifications",
			holds: "the address and the code's hash",
			ask: () => requestCode(EMAIL),
			path: "/email-otp/send-verification-otp",
		},
		{
			table: "sessions",
			holds: "the new session's token and the client's address",
			ask: async () =>
				post("/sign-in/email-otp", { email: EMAIL, otp: await mailbox.codeFor(EMAIL) }),
			path: "/sign-in/email-otp",
		},
		{
			table: "rate_limits",
			holds: "the client's address, and the request has an invitation's id in its query string",
			ask: () => get("/organization/get-invitation?id=0193a1b2-secret-invitation-id"),
			path: "/organization/get-invitation",
		},
	])(
		"when a statement on $table fails, which holds $holds, the answer is a plain 500 and the log has the error's name and the path alone",
		async ({ table, ask, path }) => {
			await requestCode(EMAIL);
			await mailbox.codeFor(EMAIL);
			await env.DB.exec(`drop table ${table}`);

			let response: Response | undefined;
			const lines = await logLinesDuring(async () => {
				response = await ask();
			});

			expect(lines.join("\n")).toMatch(new RegExp(`^auth: \\w+ at ${path}$`));
			expect(response?.status).toBe(500);
			expect(await response?.json()).toEqual({
				code: "INTERNAL_SERVER_ERROR",
				message: "Something went wrong",
			});
		},
	);

	it("getSession, when the session cannot be read, puts the session's token in neither its error nor the log", async () => {
		const { cookie } = await signIn(mailbox, EMAIL);
		const token = decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";
		await env.DB.exec("drop table sessions");

		let failure: unknown;
		const lines = await logLinesDuring(async () => {
			failure = await getSession(
				new Request("https://timesifier.com/app", { headers: { Cookie: cookie } }),
			).catch((error: unknown) => error);
		});

		expect(token).not.toBe("");
		expect(lines.join("\n")).toMatch(/^auth: INTERNAL_SERVER_ERROR \w+$/);
		expect(failure).toBeInstanceOf(Error);
		expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(token);
	});
});
