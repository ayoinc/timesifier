import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../db/database";
import { captureEmail, get, type Mailbox, post, signIn } from "./harness";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the auth tables in app/db/schema.ts", () => {
	it("pass Better Auth's own schema check; rename a property there and this fails", async () => {
		// Better Auth compares its models and its plugins' with the Drizzle tables
		// it was given. Every request waits for that check and fails when a table
		// or field is missing; it warns when an adapter has no check to run.
		const complaints = [vi.spyOn(console, "warn"), vi.spyOn(console, "error")];

		const response = await get("/get-session");

		expect(response.status).toBe(200);
		for (const complaint of complaints) expect(complaint).not.toHaveBeenCalled();
	});

	it("get UUIDv7 ids and millisecond timestamps from Better Auth, like every other table", async () => {
		const before = Date.now();
		await signIn(mailbox, "ada@example.com");
		await post("/sign-in/email-otp", { email: "ada@example.com", otp: "000000" });

		const user = await env.DB.prepare("select * from users").first();
		const session = await env.DB.prepare("select * from sessions").first();
		const limit = await env.DB.prepare("select * from rate_limits").first();

		expect(user?.id).toMatch(UUID_V7);
		expect(user?.email_verified).toBe(1);
		expect(user?.created_at).toBeGreaterThanOrEqual(before);
		expect(session?.id).toMatch(UUID_V7);
		expect(session?.user_id).toBe(user?.id);
		// Seven days from now, in milliseconds.
		expect(session?.expires_at).toBeGreaterThan(before + 6 * 86_400_000);
		expect(session?.expires_at).toBeLessThan(before + 8 * 86_400_000);
		expect(limit?.id).toMatch(UUID_V7);
		expect(limit?.last_request).toBeGreaterThanOrEqual(before);
	});

	it("lose a person's sessions and passkeys when the person is deleted", async () => {
		const { user } = await signIn(mailbox, "ada@example.com");
		await env.DB.prepare(
			"insert into passkeys (id, user_id, public_key, credential_id, counter, device_type, backed_up, created_at) values ('p1', ?, 'k', 'c', 0, 'singleDevice', 0, 0)",
		)
			.bind(user.id)
			.run();

		await env.DB.prepare("delete from users where id = ?").bind(user.id).run();

		expect(await env.DB.prepare("select count(*) as n from sessions").first("n")).toBe(0);
		expect(await env.DB.prepare("select count(*) as n from passkeys").first("n")).toBe(0);
	});
});
