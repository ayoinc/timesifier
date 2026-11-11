import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../db/database";
import { captureEmail, post, requestCode } from "./harness";

const EMAIL = "ada@example.com";

/** One attempt on each rate-limited path, as the client at `client` would make it. */
const attempts: Record<
	string,
	(client: string, headers?: Record<string, string>) => Promise<Response>
> = {
	"signing in with an email code": (client, headers) =>
		post("/sign-in/email-otp", { email: EMAIL, otp: "000000" }, { client, headers }),
	"signing in with a passkey": (client, headers) =>
		post("/passkey/verify-authentication", { response: {} }, { client, headers }),
};

async function statusesOf(count: number, attempt: () => Promise<Response>): Promise<number[]> {
	const statuses: number[] = [];
	// One after another, as a person or a script retrying would send them.
	for (let n = 0; n < count; n++) statuses.push((await attempt()).status);
	return statuses;
}

beforeEach(async () => {
	await freshDatabase();
	captureEmail();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("the sign-in rate limit", () => {
	it.each(Object.entries(attempts))(
		"%s: the 11th attempt in a minute from one client is answered 429, the first ten are not",
		async (_name, attempt) => {
			const statuses = await statusesOf(11, () => attempt("203.0.113.7"));

			expect(statuses.slice(0, 10)).not.toContain(429);
			expect(statuses[10]).toBe(429);
		},
	);

	it("asking for an email code: the 4th request in a minute from one client is answered 429, the first three are served", async () => {
		const statuses = await statusesOf(4, () => requestCode(EMAIL, { client: "203.0.113.7" }));

		expect(statuses).toEqual([200, 200, 200, 429]);
		expect((await requestCode(EMAIL, { client: "203.0.113.8" })).status).toBe(200);
	});

	it("counts each client on its own", async () => {
		const attempt = attempts["signing in with an email code"];
		if (!attempt) throw new Error("no such attempt");
		await statusesOf(11, () => attempt("203.0.113.7"));

		expect((await attempt("203.0.113.7")).status).toBe(429);
		expect((await attempt("203.0.113.8")).status).not.toBe(429);
	});

	it("identifies the client by CF-Connecting-IP, so a forged X-Forwarded-For buys nothing", async () => {
		let forged = 0;
		const statuses = await statusesOf(11, () =>
			post(
				"/sign-in/email-otp",
				{ email: EMAIL, otp: "000000" },
				{ client: "203.0.113.7", headers: { "X-Forwarded-For": `198.51.100.${++forged}` } },
			),
		);

		expect(statuses[10]).toBe(429);
	});

	it("lets the client try again 60 seconds after its last allowed attempt, not before", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const attempt = () => post("/sign-in/email-otp", { email: EMAIL, otp: "000000" });
		await statusesOf(10, attempt);
		const lastAllowed = Date.now();

		vi.setSystemTime(lastAllowed + 59_000);
		const tooSoon = await attempt();
		vi.setSystemTime(lastAllowed + 61_000);
		const afterTheWindow = await attempt();

		expect(tooSoon.status).toBe(429);
		expect(Number(tooSoon.headers.get("X-Retry-After"))).toBeGreaterThan(0);
		expect(afterTheWindow.status).not.toBe(429);
	});

	it("measures the minute from the last allowed attempt: ten spaced attempts are still followed by a 429", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const attempt = () => post("/sign-in/email-otp", { email: EMAIL, otp: "000000" });
		const start = Date.now();

		const statuses: number[] = [];
		for (let n = 0; n < 11; n++) {
			// 30 seconds apart: never more than two attempts in any one minute.
			vi.setSystemTime(start + n * 30_000);
			statuses.push((await attempt()).status);
		}

		expect(statuses.slice(0, 10)).not.toContain(429);
		expect(statuses[10]).toBe(429);
	});
});
