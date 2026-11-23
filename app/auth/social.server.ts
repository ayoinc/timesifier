/**
 * Signing in with Google or Microsoft (TS-104, decision 62): Better Auth's own
 * providers, held to Timesifier's rules.
 *
 * - A provider is configured only where its client ID and secret are set.
 * - Microsoft takes work and school accounts only: the `organizations`
 *   endpoint, and a refusal of the personal-account tenant should one arrive.
 * - An address counts only when the provider vouches for it: Google's
 *   `email_verified`, where Google controls the mailbox (Gmail, or a Workspace
 *   account whose `hd` is the address's domain); Microsoft's `xms_edov` (the
 *   domain's owner is verified) or `email_verified`. An address the provider
 *   does not vouch for makes no account and links to none: Better Auth links
 *   an existing account only when the provider's address is verified
 *   (`requireLocalEmailVerified`, and no provider is trusted by name), and the
 *   hooks below refuse a new one.
 * - No provider token is kept: the account hooks empty every token column.
 * - Every session says how it was made, and for a provider at which Workspace
 *   domain or Entra tenant (`sessions.sign_in_method`, `sign_in_tenant`).
 *
 * The decision about a provider's profile is made while Better Auth reads it,
 * and acted on at the first write the sign-in would make: a new person, a new
 * link or a session. Each of those throws Better Auth's own `APIError` with a
 * code, which its callback turns into a redirect to the page that started the
 * sign-in, with `?error=<code>`. Nothing is written before the refusal.
 *
 * A refused profile's address is never marked verified, whatever the provider
 * says of it, so nothing downstream can link or vouch for it. The reason a
 * person is given comes from the refusal itself: it is kept in the request's
 * record, and `withSignInRecord` writes it into the error redirect, whichever
 * step of Better Auth's turned the sign-in away.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth/types";
import * as z from "zod";

import {
	type Client,
	clientOf,
	configuredProviders,
	isProvider,
	MICROSOFT_PERSONAL_TENANT,
	type Provider,
	type ProviderSettings,
	type SignInMethod,
} from "./providers";

/** Why a provider's profile was refused: the `error` the sign-in page is sent back with. */
export type Refusal = "personal_microsoft_account" | "email_not_confirmed";

/** What a provider's profile was judged to be. */
export type Verdict =
	| { ok: true; provider: Provider; tenant: string | null }
	| { ok: false; provider: Provider; refusal: Refusal };

/** A claim that a provider sends as a boolean, or as its text. */
function isTrue(value: unknown): boolean {
	return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * The domains of Google's own mail. For an address there, Google is the
 * mailbox's provider, and its `email_verified` is its own word.
 */
const GOOGLE_MAIL_DOMAINS: Record<string, true> = { "gmail.com": true, "googlemail.com": true };

/** The domain of an address, in lower case; "" where it has none. */
function domainOf(email: unknown): string {
	if (typeof email !== "string") return "";
	const at = email.lastIndexOf("@");
	return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * A Google profile, as its ID token says it. Google's `email_verified` is
 * authoritative only where Google controls the mailbox: an address at
 * gmail.com or googlemail.com, or a Google Workspace account whose `hd` is
 * the address's own domain. Anywhere else it says only that someone once
 * proved the address to Google, perhaps on a personal Google account made
 * with a mailbox since given to somebody else; that account must neither make
 * a person at the address nor reach the one who has it now. So the address is
 * vouched for in those two cases alone, and any other profile is refused as
 * not confirmed. `hd` is the Workspace domain, and the session's tenant.
 * https://developers.google.com/identity/openid-connect/openid-connect#an-id-tokens-payload
 */
export function judgeGoogle(profile: Record<string, unknown>): Verdict {
	const hd = typeof profile.hd === "string" && profile.hd !== "" ? profile.hd.toLowerCase() : null;
	const domain = domainOf(profile.email);
	const authoritative =
		Object.hasOwn(GOOGLE_MAIL_DOMAINS, domain) || (hd !== null && hd === domain);
	if (!isTrue(profile.email_verified) || !authoritative) {
		return { ok: false, provider: "google", refusal: "email_not_confirmed" };
	}
	return { ok: true, provider: "google", tenant: hd };
}

/**
 * A Microsoft profile, as its ID token says it. A personal account is refused
 * (owner's answer 6). The token's issuer must be the tenant it names: the
 * common endpoint takes tokens from every tenant, so `tid` is believed only
 * where `iss` is `https://login.microsoftonline.com/<tid>/v2.0`, Microsoft's
 * own form for that tenant. An address counts only when Microsoft vouches for
 * its domain: the optional claim `xms_edov`, or `email_verified`. Without
 * either, the `email` claim is whatever the tenant's administrator typed, which
 * is how one tenant could otherwise sign in as a person of another ("nOAuth").
 * https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#validate-the-issuer
 * https://learn.microsoft.com/en-us/entra/identity-platform/migrate-off-email-claim-authorization
 */
export function judgeMicrosoft(profile: Record<string, unknown>): Verdict {
	const tid = typeof profile.tid === "string" ? profile.tid : "";
	const tenant = tid.toLowerCase();
	if (tenant === "" || tenant === MICROSOFT_PERSONAL_TENANT) {
		return { ok: false, provider: "microsoft", refusal: "personal_microsoft_account" };
	}
	if (profile.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) {
		return { ok: false, provider: "microsoft", refusal: "email_not_confirmed" };
	}
	if (!isTrue(profile.xms_edov) && !isTrue(profile.email_verified)) {
		return { ok: false, provider: "microsoft", refusal: "email_not_confirmed" };
	}
	return { ok: true, provider: "microsoft", tenant };
}

const JUDGES: Record<Provider, (profile: Record<string, unknown>) => Verdict> = {
	google: judgeGoogle,
	microsoft: judgeMicrosoft,
};

/**
 * What one request to `/api/auth` has learnt of the person signing in. Each
 * request runs in its own (`withSignInRecord`), so nothing passes between two.
 */
const current = new AsyncLocalStorage<{ verdict?: Verdict }>();

/**
 * Runs `handle` with a fresh record of how this request signs a person in.
 * When the record holds a refusal and the answer sends the browser back with
 * `?error=`, the error is the refusal's own code, so the page says why.
 */
export async function withSignInRecord(handle: () => Promise<Response>): Promise<Response> {
	const record: { verdict?: Verdict } = {};
	const response = await current.run(record, handle);
	return record.verdict && !record.verdict.ok
		? withRefusal(response, record.verdict.refusal)
		: response;
}

/** `response`, with its redirect's `error` replaced by `refusal`; any other answer as it is. */
export function withRefusal(response: Response, refusal: Refusal): Response {
	const to = response.headers.get("Location");
	if (response.status < 300 || response.status >= 400 || !to) return response;
	// Better Auth's error address is this site's own path, or an absolute address on its host.
	const url = new URL(to, "http://relative.invalid");
	if (!url.searchParams.has("error")) return response;
	url.searchParams.set("error", refusal);
	url.searchParams.delete("error_description");
	const location =
		url.origin === "http://relative.invalid"
			? `${url.pathname}${url.search}${url.hash}`
			: url.toString();
	const answer = new Response(response.body, response);
	answer.headers.set("Location", location);
	return answer;
}

/**
 * Whether a provider vouches for the address of the profile this request read:
 * the provider verified it and the sign-in is allowed. `null` where no
 * provider's profile was read, as for a sign-in code.
 */
export function vouchedAddress(): boolean | null {
	const verdict = current.getStore()?.verdict;
	return verdict ? verdict.ok : null;
}

/**
 * A person's row as a hook is about to write it, never marked verified on the
 * word of a refused profile. Each user hook calls it, apart from
 * `refuseJudged`, so a refused profile's address stays unverified even were
 * the refusal itself to be skipped.
 */
export function unvouchedUnverified<Row extends { emailVerified?: boolean | null }>(row: Row): Row {
	return vouchedAddress() === false && row.emailVerified ? { ...row, emailVerified: false } : row;
}

/** Better Auth's view of what a provider says of a person, before it is written anywhere. */
function profileMapper(provider: Provider) {
	// Each provider's profile type is the claims of its ID token, read as claims.
	return (profile: object) => {
		const verdict = JUDGES[provider](profile as Record<string, unknown>);
		const store = current.getStore();
		if (store) store.verdict = verdict;
		// The address counts only when the provider verified it and the sign-in
		// is allowed; any refused profile's address is unverified, so Better Auth
		// links it to nobody. Why it was refused reaches the person through the
		// record (`withSignInRecord`). No picture is kept: it would be an address
		// at the provider, fetched by every page.
		return { emailVerified: verdict.ok, image: undefined };
	};
}

/**
 * The Better Auth `socialProviders` of this deployment: only those whose client
 * is configured. Each asks for the person's name and address and nothing
 * else, and is shown the account chooser, so a shared computer does not sign
 * in whoever was last signed in to the provider.
 */
export function socialProviders(settings: ProviderSettings) {
	const google = clientOf(settings, "google");
	const microsoft = clientOf(settings, "microsoft");
	return {
		...(google && { google: googleOptions(google) }),
		...(microsoft && { microsoft: microsoftOptions(microsoft) }),
	};
}

function googleOptions(client: Client) {
	return {
		...client,
		prompt: "select_account" as const,
		// `openid email profile`, Better Auth's default for Google; no offline access.
		accessType: "online" as const,
		mapProfileToUser: profileMapper("google"),
	};
}

function microsoftOptions(client: Client) {
	return {
		...client,
		// Work and school accounts, from any tenant; never personal ones (answer 6).
		tenantId: "organizations",
		prompt: "select_account" as const,
		// Not `User.Read` or `offline_access`: nothing is read from Microsoft
		// Graph, and no refresh token is wanted.
		disableDefaultScope: true,
		scope: ["openid", "profile", "email"],
		disableProfilePhoto: true,
		mapProfileToUser: profileMapper("microsoft"),
	};
}

/**
 * Throws the refusal of the profile this request read, if it was refused.
 * Called by each hook that writes for a sign-in, before it writes.
 */
export function refuseJudged(): void {
	const verdict = current.getStore()?.verdict;
	if (!verdict || verdict.ok) return;
	throw new APIError("FORBIDDEN", { code: verdict.refusal, message: verdict.refusal });
}

/** How the session this request makes was made: a provider and its tenant, or a code. */
export function signInRecord(path: string | undefined): {
	signInMethod: SignInMethod | null;
	signInTenant: string | null;
} {
	const verdict = current.getStore()?.verdict;
	if (verdict?.ok) return { signInMethod: verdict.provider, signInTenant: verdict.tenant };
	if (path === "/sign-in/email-otp") return { signInMethod: "code", signInTenant: null };
	return { signInMethod: null, signInTenant: null };
}

/** The columns of an `accounts` row that hold a provider's tokens: all of them emptied. */
export const NO_TOKENS = {
	accessToken: null,
	refreshToken: null,
	idToken: null,
	accessTokenExpiresAt: null,
	refreshTokenExpiresAt: null,
	scope: null,
} as const;

/**
 * What `POST /sign-in/social` accepts: a configured provider and the two
 * addresses to come back to, which `redirectRules` holds to this site's own
 * paths. Not `idToken` (a token the browser hands in, a second way in that no
 * page needs), `scopes`, `loginHint`, `additionalData`, `disableRedirect`, or
 * the flag that makes a person only when asked: the strict object refuses
 * every field it does not name.
 */
const SocialSignIn = z.strictObject({
	provider: z.string(),
	callbackURL: z.string().max(2000),
	errorCallbackURL: z.string().max(2000).optional(),
});

/** Holds `POST /sign-in/social` to `SocialSignIn`, and to the providers this deployment has. */
export function socialSignInRules(settings: ProviderSettings): BetterAuthPlugin {
	const offered = configuredProviders(settings);
	return {
		id: "social-sign-in-rules",
		hooks: {
			before: [
				{
					matcher: (ctx) => ctx.path === "/sign-in/social",
					handler: createAuthMiddleware(async (ctx) => {
						const parsed = SocialSignIn.safeParse(ctx.body);
						if (!parsed.success) {
							throw new APIError("BAD_REQUEST", { code: "INVALID_BODY", message: "Invalid body" });
						}
						const { provider } = parsed.data;
						if (!isProvider(provider) || !offered.includes(provider)) {
							throw new APIError("NOT_FOUND", {
								code: "PROVIDER_NOT_FOUND",
								message: "Provider not found",
							});
						}
						return { context: { body: { ...parsed.data, disableRedirect: true } } };
					}),
				},
			],
		},
	};
}
