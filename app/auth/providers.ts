/**
 * Signing in with Google or Microsoft (TS-104, decision 62): which providers
 * this deployment offers, and the words the pages use for them. Nothing here
 * reaches the network or the database, so the sign-in page, the settings page
 * and the public pages read the same answer.
 */

/** The identity providers a person may sign in with, besides an emailed code. */
export const PROVIDERS = ["google", "microsoft"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** How a session was made: an emailed code, or one of the providers. */
export type SignInMethod = "code" | Provider;

/**
 * The deployment's settings for the providers (docs/security.md, "Secrets").
 * Each ID is a variable and each secret a secret; all four are optional, and a
 * provider is offered only where both of its own are set.
 */
export type ProviderSettings = {
	readonly [Name in
		| "GOOGLE_CLIENT_ID"
		| "GOOGLE_CLIENT_SECRET"
		| "MICROSOFT_CLIENT_ID"
		| "MICROSOFT_CLIENT_SECRET"]?: unknown;
};

/** A provider's client at the provider, as the deployment's settings give it. */
export type Client = { clientId: string; clientSecret: string };

const SETTINGS: Record<Provider, { id: keyof ProviderSettings; secret: keyof ProviderSettings }> = {
	google: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
	microsoft: { id: "MICROSOFT_CLIENT_ID", secret: "MICROSOFT_CLIENT_SECRET" },
};

/** The provider's client, or `null` where its ID or its secret is not set. */
export function clientOf(settings: ProviderSettings, provider: Provider): Client | null {
	const [clientId = "", clientSecret = ""] = [SETTINGS[provider].id, SETTINGS[provider].secret].map(
		(name) => {
			const value = settings[name];
			return typeof value === "string" ? value.trim() : "";
		},
	);
	return clientId !== "" && clientSecret !== "" ? { clientId, clientSecret } : null;
}

/** The providers this deployment offers: those whose ID and secret are both set. */
export function configuredProviders(settings: ProviderSettings): Provider[] {
	return PROVIDERS.filter((provider) => clientOf(settings, provider) !== null);
}

export function isProvider(value: unknown): value is Provider {
	return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** Each provider's name, as a button and a sentence say it. */
export const PROVIDER_NAMES: Record<Provider, string> = {
	google: "Google",
	microsoft: "Microsoft",
};

/**
 * The tenant Microsoft gives every personal account (`tid`): Outlook.com,
 * Hotmail, Live and Xbox. Timesifier takes work and school accounts only
 * (owner's answer 6), so a token from this tenant is refused even though the
 * `organizations` endpoint should never issue one.
 * https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
 */
export const MICROSOFT_PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * Why a provider's sign-in was refused, as the `error` the sign-in page is
 * sent back with, and what the page says for each. Better Auth's own codes
 * that can follow a provider's round trip are here too.
 */
export const SIGN_IN_REFUSALS: Record<string, string> = {
	personal_microsoft_account:
		"Microsoft sign-in takes work or school accounts only. Sign in with a code sent to your email instead.",
	email_not_confirmed:
		"Your provider does not confirm this address. Sign in with a code sent to your email instead.",
	account_not_linked:
		"Your provider does not confirm this address. Sign in with a code sent to your email instead.",
	email_not_found:
		"Your provider did not tell us your email address. Sign in with a code sent to your email instead.",
	access_denied: "Sign-in was cancelled. Try again, or sign in with a code.",
};

/** What the sign-in page says for an `error` it was sent back with; one sentence for any other. */
export function refusalWords(code: string): string {
	return Object.hasOwn(SIGN_IN_REFUSALS, code)
		? (SIGN_IN_REFUSALS[code] as string)
		: "That sign-in did not work. Try again, or sign in with a code.";
}

/** How a session's method reads beside the device in the platform console: "with Microsoft". */
export function methodWords(method: string | null): string {
	return isProvider(method)
		? `with ${PROVIDER_NAMES[method]}`
		: method === "code"
			? "with a code"
			: "";
}
