/**
 * What the log holds when something fails on the server outside
 * authentication: the error's name and the path, and nothing a row or a
 * request carried (docs/security.md, "Never logged").
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleError } from "~/entry.server";
import { captureEmail, type Mailbox, ORIGIN, signIn } from "./auth/harness";
import { freshDatabase } from "./db/database";

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Every line written to the console from here on. */
function logLines(): string[] {
	const lines: string[] = [];
	for (const level of ["debug", "log", "info", "warn", "error"] as const) {
		vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
			lines.push(parts.map(String).join(" "));
		});
	}
	return lines;
}

describe("an error on the server", () => {
	it("in a loader whose database statement fails: a plain 500 page, and the log has the error's name and the path alone", async () => {
		const { cookie } = await signIn(mailbox, "ada@example.com");
		const token = decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";
		// The guard on /app reads the session. D1 refuses the statement.
		await env.DB.exec("drop table sessions");
		const lines = logLines();

		const response = await exports.default.fetch(
			new Request(`${ORIGIN}/app/acme/settings?invitation=0193a1b2-secret-in-the-query`, {
				headers: { Cookie: cookie },
			}),
		);

		const page = await response.text();
		expect(lines.filter((line) => !line.startsWith("auth: "))).toEqual([
			"error: Error at /app/:organisation/settings",
		]);
		expect(response.status).toBe(500);
		expect(page).toContain("An unexpected error occurred.");
		for (const secret of [token, "secret-in-the-query", "sessions", "Failed query"]) {
			expect(secret).not.toBe("");
			expect(lines.join("\n")).not.toContain(secret);
			expect(page).not.toContain(secret);
		}
	});

	it("is logged without its message, the query string or the values in the path", () => {
		const lines = logLines();
		// What Drizzle throws when a statement fails: the message is the statement and its parameters.
		const failure = Object.assign(
			new Error(
				'Failed query: select * from "invitations" where "id" = ?\nparams: ada@example.com',
			),
			{ name: "DrizzleQueryError" },
		);

		handleError(failure, {
			request: new Request(`${ORIGIN}/invitations/0193a1b2-an-id/accept?email=ada@example.com`),
			params: { id: "0193a1b2-an-id" },
		});
		handleError("not even an error", { request: new Request(`${ORIGIN}/app`), params: {} });

		expect(lines).toEqual([
			"error: DrizzleQueryError at /invitations/:id/accept",
			"error: error at /app",
		]);
	});

	it("is not logged when the browser has given up on the request", () => {
		const lines = logLines();
		const gone = new AbortController();
		gone.abort();

		handleError(new Error("aborted"), {
			request: new Request(`${ORIGIN}/app`, { signal: gone.signal }),
			params: {},
		});

		expect(lines).toEqual([]);
	});
});
