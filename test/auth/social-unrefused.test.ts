/**
 * A personal Microsoft account's address is never written as verified, even
 * were the refusal itself skipped (TS-104 slice 104a). Here `refuseJudged` is
 * replaced by a function that refuses nothing, so the sign-in runs as far as
 * Better Auth takes it; what the user hooks write is then read back.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MICROSOFT_PERSONAL_TENANT } from "~/auth/providers";
import * as Social from "~/auth/social.server";
import { freshDatabase } from "../db/database";
import { captureEmail, countRows, type Mailbox, signIn } from "./harness";
import { configureProviders, microsoftClaims, signInWith } from "./social-harness";

vi.mock("~/auth/social.server", { spy: true });

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	configureProviders("microsoft");
	vi.mocked(Social.refuseJudged).mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

type UserRow = { email: string; email_verified: number };

async function users(): Promise<UserRow[]> {
	const { results } = await env.DB.prepare(
		"select email, email_verified from users order by email",
	).all<UserRow>();
	return results;
}

describe("with the refusal bypassed, a personal Microsoft account", () => {
	it.each([
		["the personal-account tenant", MICROSOFT_PERSONAL_TENANT],
		["no tenant at all", ""],
	])("(%s) makes no verified person, and links to no verified one", async (_, tenant) => {
		const ada = await signIn(mailbox, "ada@outlook.example");
		const sessions = await countRows("sessions");

		// A new address: Better Auth makes the person, since nothing refuses it,
		// and the user hook writes them unverified, whatever Microsoft said.
		const fresh = await signInWith(
			"microsoft",
			microsoftClaims("dan@outlook.example", { email_verified: true, xms_edov: true }, tenant),
		);
		// An address with a verified person: nothing links to an unverified profile.
		const existing = await signInWith(
			"microsoft",
			microsoftClaims("ada@outlook.example", { email_verified: true, xms_edov: true }, tenant),
		);

		expect(await users()).toEqual([
			{ email: "ada@outlook.example", email_verified: 1 },
			{ email: "dan@outlook.example", email_verified: 0 },
		]);
		expect(existing.cookie).toBeNull();
		const accounts = await env.DB.prepare(
			"select users.email from accounts join users on users.id = accounts.user_id where accounts.provider_id = 'microsoft'",
		).all<{ email: string }>();
		expect(accounts.results).toEqual([{ email: "dan@outlook.example" }]);
		// The one session the bypass let through is the unverified person's, and
		// says no provider made it.
		const made = await env.DB.prepare(
			"select users.email, users.email_verified, sessions.sign_in_method from sessions join users on users.id = sessions.user_id where sessions.user_id != ?",
		)
			.bind(ada.user.id)
			.all();
		expect(made.results).toEqual([
			{ email: "dan@outlook.example", email_verified: 0, sign_in_method: null },
		]);
		expect(await countRows("sessions")).toBe(sessions + (fresh.cookie ? 1 : 0));
	});
});
