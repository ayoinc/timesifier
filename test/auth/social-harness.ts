/**
 * Signing in with Google or Microsoft in a test (TS-104), with no network: the
 * provider's token endpoint is answered here, with an ID token carrying the
 * claims a test chooses. Better Auth reads that token as it came, over TLS,
 * from the provider's own endpoint, so it is not signed here.
 */
import { onTestFinished, vi } from "vitest";
import * as z from "zod";
import type { Provider } from "~/auth/providers";
import { get, post, type RequestOptions, sessionCookie, setBinding } from "./harness";

/** What `POST /sign-in/social` answers: the provider's address to send the browser to. */
export const ProviderAddress = z.object({ url: z.url(), redirect: z.boolean() });

/** The cookie that ties the provider's answer to the browser that asked (Better Auth's `state`). */
export const STATE_COOKIE = "__Host-timesifier.state";

const TOKEN_ENDPOINTS: Record<Provider, string> = {
	google: "https://oauth2.googleapis.com/token",
	microsoft: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
};

/** A tenant of Microsoft's, for work accounts. */
export const ACME_TENANT = "0b9c7d5e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";

/** Gives this deployment a client at each provider named, until the test ends. */
export function configureProviders(...providers: Provider[]): void {
	for (const provider of providers) {
		const prefix = provider === "google" ? "GOOGLE" : "MICROSOFT";
		setBinding(`${prefix}_CLIENT_ID`, `${provider}-client-id`);
		setBinding(`${prefix}_CLIENT_SECRET`, `${provider}-client-secret`);
	}
}

function base64url(value: unknown): string {
	return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** An ID token holding `claims`, as the provider's token endpoint would return it. */
function idToken(claims: Record<string, unknown>): string {
	const now = Math.floor(Date.now() / 1000);
	return [
		base64url({ alg: "RS256", typ: "JWT", kid: "test" }),
		base64url({ iat: now, exp: now + 3600, ...claims }),
		"signature",
	].join(".");
}

/**
 * Claims of a Google account at `email`, verified by Google unless a test says
 * otherwise. An address outside Gmail is a Google Workspace account at its own
 * domain (`hd`), the one case beside Gmail where Google's word on the address
 * counts; a test of any other passes `hd` itself, or `hd: undefined`.
 */
export function googleClaims(email: string, extra: Record<string, unknown> = {}) {
	const domain = email.slice(email.lastIndexOf("@") + 1);
	const gmail = domain === "gmail.com" || domain === "googlemail.com";
	return {
		iss: "https://accounts.google.com",
		aud: "google-client-id",
		sub: `google-${email}`,
		email,
		email_verified: true,
		...(gmail ? {} : { hd: domain }),
		name: "Ada Lovelace",
		picture: "https://lh3.googleusercontent.com/a/picture",
		...extra,
	};
}

/** Claims of a Microsoft work account at `email` in `tenant`, its domain verified unless a test says otherwise. */
export function microsoftClaims(
	email: string,
	extra: Record<string, unknown> = {},
	tenant = ACME_TENANT,
) {
	return {
		iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
		aud: "microsoft-client-id",
		tid: tenant,
		oid: `oid-${email}`,
		sub: `sub-${email}`,
		email,
		xms_edov: true,
		name: "Ada Lovelace",
		preferred_username: email,
		...extra,
	};
}

/** Every request the Worker made to a provider's token endpoint, as its body. */
export type TokenRequests = URLSearchParams[];

/** Answers the provider's token endpoint with `claims`, and lets every other request through. */
export function answerTokenEndpoint(
	provider: Provider,
	claims: Record<string, unknown>,
): TokenRequests {
	const seen: TokenRequests = [];
	const real = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		if (request.url !== TOKEN_ENDPOINTS[provider]) return real(input, init);
		seen.push(new URLSearchParams(await request.text()));
		return Response.json({
			access_token: "provider-access-token",
			refresh_token: "provider-refresh-token",
			id_token: idToken(claims),
			token_type: "Bearer",
			expires_in: 3600,
			scope: "openid email profile",
		});
	});
	onTestFinished(() => {
		vi.restoreAllMocks();
	});
	return seen;
}

/** Asks for the provider's address, as the sign-in page's button does. */
export function askProvider(
	provider: string,
	body: Record<string, unknown> = {},
	options: RequestOptions = {},
): Promise<Response> {
	return post("/sign-in/social", { provider, callbackURL: "/app", ...body }, options);
}

/**
 * The whole round trip: ask for the provider's address, and come back to the
 * callback as the provider would send the browser, with a code the token
 * endpoint answers for with `claims`. Returns the callback's answer and the
 * session cookie it set, if any.
 */
export async function signInWith(
	provider: Provider,
	claims: Record<string, unknown>,
	options: RequestOptions & { callbackURL?: string; errorCallbackURL?: string } = {},
) {
	const { callbackURL = "/app", errorCallbackURL, ...request } = options;
	const asked = await askProvider(
		provider,
		{ callbackURL, ...(errorCallbackURL ? { errorCallbackURL } : {}) },
		request,
	);
	if (asked.status !== 200) throw new Error(`sign-in/social answered ${asked.status}`);
	const { url } = ProviderAddress.parse(await asked.json());
	const state = new URL(url).searchParams.get("state") ?? "";
	const stateCookie = asked.headers
		.getSetCookie()
		.find((cookie) => cookie.startsWith(`${STATE_COOKIE}=`));
	const tokenRequests = answerTokenEndpoint(provider, claims);
	const response = await get(
		`/callback/${provider}?${new URLSearchParams({ code: "provider-code", state })}`,
		{
			...request,
			cookie: [request.cookie, stateCookie?.split(";")[0]].filter(Boolean).join("; "),
		},
	);
	const cookie = response.headers
		.getSetCookie()
		.some((line) => line.startsWith("__Host-timesifier.session_token="))
		? sessionCookie(response)
		: null;
	return { asked: url, response, cookie, tokenRequests };
}
