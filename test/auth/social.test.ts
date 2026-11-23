/**
 * Signing in with Google or Microsoft (TS-104 slice 104a, decision 62). The
 * provider is never reached: its token endpoint is answered by the test with
 * an ID token of the test's choosing (social-harness.ts).
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MICROSOFT_PERSONAL_TENANT } from "~/auth/providers";
import { judgeGoogle, judgeMicrosoft } from "~/auth/social.server";
import { freshDatabase } from "../db/database";
import {
	captureEmail,
	countRows,
	get,
	type Mailbox,
	ORIGIN,
	SESSION_COOKIE,
	setBinding,
	signIn,
	whoIs,
} from "./harness";
import {
	ACME_TENANT,
	answerTokenEndpoint,
	askProvider,
	configureProviders,
	googleClaims,
	microsoftClaims,
	ProviderAddress,
	STATE_COOKIE,
	signInWith,
} from "./social-harness";

const EMAIL = "ada@acme.example";

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function accountRows() {
	const { results } = await env.DB.prepare(
		"select user_id, provider_id, account_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope from accounts order by created_at",
	).all();
	return results;
}

async function sessionRows() {
	const { results } = await env.DB.prepare(
		"select user_id, sign_in_method, sign_in_tenant from sessions order by created_at",
	).all();
	return results;
}

/** Where a redirect sends the browser, as a path and query on this site. */
function location(response: Response): string {
	const to = new URL(response.headers.get("Location") ?? "", ORIGIN);
	return `${to.pathname}${to.search}`;
}

function errorOf(response: Response): string | null {
	return new URL(response.headers.get("Location") ?? "", ORIGIN).searchParams.get("error");
}

describe("the sign-in page's buttons", () => {
	async function signInPage() {
		const response = await exports.default.fetch(new Request(`${ORIGIN}/sign-in`));
		expect(response.status).toBe(200);
		return response.text();
	}

	it("appear only where the client is configured", async () => {
		const none = await signInPage();
		expect(none).not.toContain("Continue with Google");
		expect(none).not.toContain("Continue with Microsoft");

		configureProviders("microsoft");
		const microsoftOnly = await signInPage();
		expect(microsoftOnly).toContain("Continue with Microsoft");
		expect(microsoftOnly).not.toContain("Continue with Google");

		configureProviders("google");
		const both = await signInPage();
		expect(both).toContain("Continue with Google");
		expect(both).toContain("Continue with Microsoft");
	});

	it("a provider whose ID is set without its secret, or its secret without its ID, is not offered", async () => {
		configureProviders("google");
		setBinding("GOOGLE_CLIENT_SECRET", "");
		expect(await signInPage()).not.toContain("Continue with Google");
		expect((await askProvider("google")).status).toBe(404);
	});
});

describe("asking for a provider's address", () => {
	it("answers with the provider's address, carrying the state, and sets the state cookie", async () => {
		configureProviders("google", "microsoft");

		const google = await askProvider("google");
		expect(google.status).toBe(200);
		const { url, redirect } = ProviderAddress.parse(await google.json());
		expect(redirect).toBe(false);
		const to = new URL(url);
		expect(to.origin).toBe("https://accounts.google.com");
		expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
		expect(to.searchParams.get("scope")?.split(" ").sort()).toEqual(["email", "openid", "profile"]);
		expect(to.searchParams.get("prompt")).toBe("select_account");
		expect(to.searchParams.get("access_type")).toBe("online");
		expect(to.searchParams.get("state")).toBeTruthy();

		const microsoft = await askProvider("microsoft");
		const microsoftURL = new URL(ProviderAddress.parse(await microsoft.json()).url);
		expect(`${microsoftURL.origin}${microsoftURL.pathname}`).toBe(
			"https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
		);
		expect(microsoftURL.searchParams.get("scope")?.split(" ").sort()).toEqual([
			"email",
			"openid",
			"profile",
		]);

		const state = google.headers.getSetCookie().find((c) => c.startsWith(`${STATE_COOKIE}=`));
		expect(state).toBeDefined();
		expect(state).toMatch(/; Secure/i);
		expect(state).toMatch(/; HttpOnly/i);
		expect(state).toMatch(/; SameSite=Lax/i);
		expect(state).toMatch(/; Path=\//i);
		expect(state).not.toMatch(/; Domain=/i);
	});

	it.each([
		["a provider the deployment has no client for", { provider: "google" }, 404],
		["a provider Better Auth has but Timesifier does not offer", { provider: "github" }, 404],
		["an ID token handed in by the browser", { idToken: { token: "x" } }, 400],
		["extra scopes", { scopes: ["https://www.googleapis.com/auth/drive"] }, 400],
		["a login hint", { loginHint: "ada@acme.example" }, 400],
		["a callback on another site", { callbackURL: "https://evil.example/app" }, 403],
		["an error callback on another site", { errorCallbackURL: "//evil.example" }, 403],
	])("refuses %s", async (_, body, status) => {
		configureProviders("microsoft");
		const response = await askProvider("microsoft", body);
		expect(response.status).toBe(status);
	});
});

describe("Google", () => {
	beforeEach(() => configureProviders("google"));

	it("signs a new person in, verified, with the Workspace domain on the session", async () => {
		const { response, cookie, tokenRequests } = await signInWith(
			"google",
			googleClaims(EMAIL, { hd: "acme.example" }),
		);

		expect(response.status).toBe(302);
		expect(location(response)).toBe("/app");
		expect(cookie).not.toBeNull();
		const user = await whoIs(cookie ?? "");
		expect(user).toMatchObject({ email: EMAIL, emailVerified: true });
		expect(await sessionRows()).toEqual([
			{ user_id: user?.id, sign_in_method: "google", sign_in_tenant: "acme.example" },
		]);
		// The code was exchanged once, with the verifier this browser's state holds.
		expect(tokenRequests).toHaveLength(1);
		expect(tokenRequests[0]?.get("code_verifier")).toBeTruthy();
	});

	it("a personal Google account signs in, with no domain on the session", async () => {
		const { cookie } = await signInWith("google", googleClaims("ada@gmail.com"));

		expect(cookie).not.toBeNull();
		expect(await sessionRows()).toMatchObject([{ sign_in_method: "google", sign_in_tenant: null }]);
	});

	it("a person made by code who signs in with Google at the same address lands in the same account", async () => {
		const { user } = await signIn(mailbox, EMAIL);

		const { cookie } = await signInWith("google", googleClaims(EMAIL));

		expect((await whoIs(cookie ?? ""))?.id).toBe(user.id);
		expect(await countRows("users")).toBe(1);
		expect(await accountRows()).toMatchObject([{ user_id: user.id, provider_id: "google" }]);
	});

	it("returns to the same account next time, by the account's id at Google", async () => {
		const first = await signInWith("google", googleClaims(EMAIL));
		const second = await signInWith("google", googleClaims(EMAIL));

		expect((await whoIs(second.cookie ?? ""))?.id).toBe((await whoIs(first.cookie ?? ""))?.id);
		expect(await accountRows()).toHaveLength(1);
	});

	it("an address Google does not say is verified signs nobody in, makes nobody, and links to nobody", async () => {
		const { user } = await signIn(mailbox, EMAIL);

		const linking = await signInWith("google", googleClaims(EMAIL, { email_verified: false }));
		const making = await signInWith(
			"google",
			googleClaims("bob@acme.example", { email_verified: false }),
		);

		for (const { response, cookie } of [linking, making]) {
			expect(response.status).toBe(302);
			expect(location(response)).toMatch(/^\/sign-in\?error=/);
			expect(cookie).toBeNull();
		}
		// The refusal's own code, not Better Auth's "account_not_linked" (social.server.ts, `withSignInRecord`).
		expect(errorOf(linking.response)).toBe("email_not_confirmed");
		expect(errorOf(making.response)).toBe("email_not_confirmed");
		expect(await accountRows()).toEqual([]);
		expect(await countRows("users")).toBe(1);
		expect((await sessionRows()).map((row) => row.user_id)).toEqual([user.id]);
	});

	it("a verified address Google does not control, with no Workspace domain, links to nobody, makes nobody and signs nobody in", async () => {
		// A personal Google account made long ago with victim@acme.com, a mailbox
		// since given to somebody else, who signed up here by code.
		const victim = "victim@acme.com";
		const { user } = await signIn(mailbox, victim);

		const linking = await signInWith(
			"google",
			googleClaims(victim, { email_verified: true, hd: undefined }),
		);
		const making = await signInWith(
			"google",
			googleClaims("nobody-yet@acme.com", { email_verified: true, hd: undefined }),
		);
		// Nor a Workspace account at another domain that claims this address.
		const elsewhere = await signInWith(
			"google",
			googleClaims(victim, { email_verified: true, hd: "evil.example" }),
		);

		for (const { response, cookie } of [linking, making, elsewhere]) {
			expect(response.status).toBe(302);
			expect(errorOf(response)).toBe("email_not_confirmed");
			expect(cookie).toBeNull();
		}
		expect(await accountRows()).toEqual([]);
		expect(await countRows("users")).toBe(1);
		expect((await sessionRows()).map((row) => row.user_id)).toEqual([user.id]);
	});

	it("no provider token is stored", async () => {
		await signInWith("google", googleClaims(EMAIL));
		await signInWith("google", googleClaims(EMAIL));

		expect(await accountRows()).toEqual([
			expect.objectContaining({
				access_token: null,
				refresh_token: null,
				id_token: null,
				access_token_expires_at: null,
				refresh_token_expires_at: null,
				scope: null,
			}),
		]);
	});

	it("keeps no picture from Google", async () => {
		await signInWith("google", googleClaims(EMAIL));

		const row = await env.DB.prepare("select image from users").first<{ image: string | null }>();
		expect(row?.image).toBeNull();
	});
});

describe("Microsoft", () => {
	beforeEach(() => configureProviders("microsoft"));

	it("signs a work account in, with its tenant on the session", async () => {
		const { response, cookie } = await signInWith("microsoft", microsoftClaims(EMAIL));

		expect(location(response)).toBe("/app");
		expect(await whoIs(cookie ?? "")).toMatchObject({ email: EMAIL, emailVerified: true });
		expect(await sessionRows()).toMatchObject([
			{ sign_in_method: "microsoft", sign_in_tenant: ACME_TENANT },
		]);
	});

	it("links to a person made by code when Microsoft says the domain is verified (xms_edov or email_verified)", async () => {
		const ada = await signIn(mailbox, EMAIL);
		const bob = await signIn(mailbox, "bob@acme.example");

		const byDomain = await signInWith("microsoft", microsoftClaims(EMAIL));
		const byAddress = await signInWith(
			"microsoft",
			microsoftClaims("bob@acme.example", { xms_edov: undefined, email_verified: true }),
		);

		expect((await whoIs(byDomain.cookie ?? ""))?.id).toBe(ada.user.id);
		expect((await whoIs(byAddress.cookie ?? ""))?.id).toBe(bob.user.id);
		expect(await countRows("users")).toBe(2);
	});

	it("an unverified Microsoft address links to nothing, and makes nobody", async () => {
		const { user } = await signIn(mailbox, EMAIL);

		const linking = await signInWith("microsoft", microsoftClaims(EMAIL, { xms_edov: false }));
		const making = await signInWith(
			"microsoft",
			microsoftClaims("carol@acme.example", { xms_edov: undefined }),
		);

		expect(errorOf(linking.response)).toBe("email_not_confirmed");
		expect(errorOf(making.response)).toBe("email_not_confirmed");
		for (const { cookie } of [linking, making]) expect(cookie).toBeNull();
		expect(await accountRows()).toEqual([]);
		expect(await countRows("users")).toBe(1);
		expect((await sessionRows()).map((row) => row.user_id)).toEqual([user.id]);
	});

	it("a token whose issuer is not the tenant it names links to nothing, makes nobody and signs nobody in", async () => {
		const { user } = await signIn(mailbox, EMAIL);
		const otherTenant = "0b5ce2b8-3a2f-4f8e-9d38-6a4f2a1e0c77";

		for (const iss of [
			`https://login.microsoftonline.com/${otherTenant}/v2.0`,
			"https://login.microsoftonline.com/common/v2.0",
			`https://sts.windows.net/${ACME_TENANT}/`,
			undefined,
		]) {
			const { response, cookie } = await signInWith("microsoft", microsoftClaims(EMAIL, { iss }));
			expect(errorOf(response), String(iss)).toBe("email_not_confirmed");
			expect(cookie).toBeNull();
		}
		expect(await accountRows()).toEqual([]);
		expect(await countRows("users")).toBe(1);
		expect((await sessionRows()).map((row) => row.user_id)).toEqual([user.id]);
	});

	it.each([
		["the personal-account tenant", MICROSOFT_PERSONAL_TENANT],
		["no tenant at all", ""],
	])(
		"refuses a personal account (%s), with words that point to the code, and writes nothing",
		async (_, tenant) => {
			await signIn(mailbox, "ada@outlook.example");
			const before = await countRows("sessions");

			const fresh = await signInWith(
				"microsoft",
				microsoftClaims("dan@outlook.example", {}, tenant),
			);
			const existing = await signInWith(
				"microsoft",
				microsoftClaims("ada@outlook.example", {}, tenant),
			);

			for (const { response, cookie } of [fresh, existing]) {
				expect(errorOf(response)).toBe("personal_microsoft_account");
				expect(cookie).toBeNull();
			}
			expect(await accountRows()).toEqual([]);
			expect(await countRows("users")).toBe(1);
			expect(await countRows("sessions")).toBe(before);

			const page = await exports.default.fetch(new Request(`${ORIGIN}${location(fresh.response)}`));
			expect(await page.text()).toContain("work or school accounts only");
		},
	);

	it("an account linked before is refused once it is in the personal tenant", async () => {
		await signInWith("microsoft", microsoftClaims(EMAIL));
		const sessions = await countRows("sessions");

		const again = await signInWith(
			"microsoft",
			microsoftClaims(EMAIL, {}, MICROSOFT_PERSONAL_TENANT),
		);

		expect(errorOf(again.response)).toBe("personal_microsoft_account");
		expect(await countRows("sessions")).toBe(sessions);
	});

	it("no provider token is stored", async () => {
		await signInWith("microsoft", microsoftClaims(EMAIL));

		expect(await accountRows()).toEqual([
			expect.objectContaining({ access_token: null, refresh_token: null, id_token: null }),
		]);
	});
});

describe("the callback's answer", () => {
	beforeEach(() => configureProviders("google", "microsoft"));

	it.each(["google", "microsoft"] as const)(
		"from %s carries the security headers, and a session cookie with every flag",
		async (provider) => {
			const claims = provider === "google" ? googleClaims(EMAIL) : microsoftClaims(EMAIL);
			const { response } = await signInWith(provider, claims);

			// A redirect loads nothing, so it gets the policy under which nothing loads.
			expect(response.status).toBe(302);
			expect(response.headers.get("Content-Security-Policy")).toBe(
				"default-src 'none'; frame-ancestors 'none'",
			);
			expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(response.headers.get("Strict-Transport-Security")).toBeTruthy();
			const session = response.headers
				.getSetCookie()
				.find((line) => line.startsWith(`${SESSION_COOKIE}=`));
			expect(session).toMatch(/; Secure/i);
			expect(session).toMatch(/; HttpOnly/i);
			expect(session).toMatch(/; SameSite=Lax/i);
			expect(session).toMatch(/; Path=\//i);
			expect(session).not.toMatch(/; Domain=/i);
			// The state cookie is spent.
			const state = response.headers
				.getSetCookie()
				.find((line) => line.startsWith(`${STATE_COOKIE}=`));
			expect(state).toMatch(/Max-Age=0/i);
		},
	);

	it("without the state cookie of the browser that asked, signs nobody in", async () => {
		const asked = await askProvider("google");
		const { url } = ProviderAddress.parse(await asked.json());
		const state = new URL(url).searchParams.get("state") ?? "";
		answerTokenEndpoint("google", googleClaims(EMAIL));

		const response = await get(`/callback/google?code=c&state=${state}`);

		expect(response.status).toBe(302);
		expect(errorOf(response)).toMatch(/state/);
		expect(response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
			false,
		);
		expect(await countRows("users")).toBe(0);
	});
});

describe("the rules, on the claims alone", () => {
	it("Google: a verified address is taken only where Google holds the mailbox, with `hd` as its tenant", () => {
		const workspace = { email: "ada@acme.example", email_verified: true, hd: "Acme.Example" };
		expect(judgeGoogle(workspace)).toEqual({
			ok: true,
			provider: "google",
			tenant: "acme.example",
		});
		expect(judgeGoogle({ email: "ada@gmail.com", email_verified: "true" })).toMatchObject({
			ok: true,
			tenant: null,
		});
		expect(judgeGoogle({ email: "Ada@GoogleMail.com", email_verified: true })).toMatchObject({
			ok: true,
		});
		const refused = { ok: false, refusal: "email_not_confirmed" };
		// Verified, but at a mailbox Google does not hold: a recycled address.
		expect(judgeGoogle({ email: "ada@acme.example", email_verified: true })).toMatchObject(refused);
		expect(
			judgeGoogle({ email: "ada@acme.example", email_verified: true, hd: "other.example" }),
		).toMatchObject(refused);
		expect(
			judgeGoogle({ email: "ada@gmail.com.evil.example", email_verified: true }),
		).toMatchObject(refused);
		expect(judgeGoogle({ ...workspace, email_verified: false })).toMatchObject(refused);
		expect(judgeGoogle({ email_verified: true, hd: "acme.example" })).toMatchObject(refused);
		expect(judgeGoogle({})).toMatchObject(refused);
	});

	it("Microsoft: a work account whose domain or address is verified, from its own tenant's issuer, is taken; nothing else", () => {
		const iss = `https://login.microsoftonline.com/${ACME_TENANT}/v2.0`;
		expect(judgeMicrosoft({ iss, tid: ACME_TENANT, xms_edov: true })).toMatchObject({ ok: true });
		expect(judgeMicrosoft({ iss, tid: ACME_TENANT, xms_edov: "1" })).toMatchObject({ ok: true });
		expect(judgeMicrosoft({ iss, tid: ACME_TENANT, email_verified: true })).toMatchObject({
			ok: true,
		});
		expect(judgeMicrosoft({ iss, tid: ACME_TENANT })).toMatchObject({
			ok: false,
			refusal: "email_not_confirmed",
		});
		expect(judgeMicrosoft({ iss, tid: ACME_TENANT, xms_edov: false })).toMatchObject({
			ok: false,
		});
		expect(
			judgeMicrosoft({
				iss: `https://login.microsoftonline.com/${MICROSOFT_PERSONAL_TENANT}/v2.0`,
				tid: MICROSOFT_PERSONAL_TENANT,
				xms_edov: true,
			}),
		).toMatchObject({ ok: false, refusal: "personal_microsoft_account" });
		expect(judgeMicrosoft({ iss, xms_edov: true })).toMatchObject({ ok: false });
	});

	it("Microsoft: `tid` is believed only from `https://login.microsoftonline.com/<tid>/v2.0`", () => {
		const refused = { ok: false, refusal: "email_not_confirmed" };
		for (const iss of [
			undefined,
			"",
			"https://login.microsoftonline.com/common/v2.0",
			"https://login.microsoftonline.com/organizations/v2.0",
			"https://login.microsoftonline.com/0b5ce2b8-3a2f-4f8e-9d38-6a4f2a1e0c77/v2.0",
			`https://sts.windows.net/${ACME_TENANT}/`,
			`https://login.microsoftonline.com/${ACME_TENANT}/v2.0/`,
			`http://login.microsoftonline.com/${ACME_TENANT}/v2.0`,
			`https://login.microsoftonline.com.evil.example/${ACME_TENANT}/v2.0`,
		]) {
			expect(judgeMicrosoft({ iss, tid: ACME_TENANT, xms_edov: true }), String(iss)).toMatchObject(
				refused,
			);
		}
	});
});
