/**
 * What a deployment tells the Worker about itself: where it is served, which
 * Turnstile widget is its own, which address its mail comes from, its
 * secrets, and who the platform's owners are (TS-099).
 * docs/security.md, "Secrets", lists every one and where it is set.
 *
 * None has a default in the code. A value that is missing is never guessed:
 * the code that needs it fails, and the log names what was missing. A missing
 * `PLATFORM_OWNERS` closes the platform console to everyone.
 */
export type Setting =
	| "ENVIRONMENT"
	| "APP_HOST"
	| "PREVIEW_HOST_SUFFIX"
	| "TURNSTILE_SITE_KEY"
	| "EMAIL_FROM"
	| "BETTER_AUTH_SECRET"
	| "TURNSTILE_SECRET_KEY"
	| "PLATFORM_OWNERS";

/** Anything that may carry the settings: the Worker's `env`, or a part of it. */
export type Settings = { readonly [Name in Setting]?: unknown };

/** The setting's value, or `undefined` where it is missing, empty or not text. */
export function setting(env: Settings, name: Setting): string | undefined {
	const value = env[name];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The setting's value, which must be there and, where a `shape` is given, must
 * match it. Otherwise this throws, and the log gets one line that names the
 * setting and never holds its value, so that a deployment's fault can be read
 * there: React Router logs an error's name and nothing else (docs/security.md,
 * "Never logged").
 */
export function required(env: Settings, name: Setting, shape?: RegExp): string {
	const value = setting(env, name);
	if (value !== undefined && (!shape || shape.test(value))) return value;
	const fault = `${name} is ${value === undefined ? "not set" : "not valid"}`;
	console.error(`deployment: ${fault}`);
	throw new Error(fault);
}
