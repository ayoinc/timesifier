import * as z from "zod";

// The colour scheme a person has chosen, kept in a cookie so the server can
// render it: the page arrives in the right scheme, with no flash and no inline
// script. "System" is the absence of the cookie. docs/security.md describes it.

/** `__Host-`: the browser takes it only over HTTPS, with `Path=/` and no `Domain`. */
export const COLOR_SCHEME_COOKIE = "__Host-color-scheme";

export const COLOR_SCHEME_CHOICES = ["system", "light", "dark"] as const;
export type ColorSchemeChoice = (typeof COLOR_SCHEME_CHOICES)[number];
/** A scheme that overrides the device setting. */
export type ForcedColorScheme = Exclude<ColorSchemeChoice, "system">;

/** What the colour-scheme form submits. */
export const colorSchemeForm = z.object({ scheme: z.enum(COLOR_SCHEME_CHOICES) });

// Not `HttpOnly`: the value is no secret, and a page may read what it shows.
const ATTRIBUTES = "Path=/; Secure; SameSite=Lax";
const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/** The scheme the `Cookie` header forces, or `null` to follow the device. Any other value is ignored. */
export function readColorScheme(cookieHeader: string | null): ForcedColorScheme | null {
	for (const pair of cookieHeader?.split(";") ?? []) {
		const separator = pair.indexOf("=");
		if (separator === -1 || pair.slice(0, separator).trim() !== COLOR_SCHEME_COOKIE) continue;
		const value = pair.slice(separator + 1).trim();
		return value === "light" || value === "dark" ? value : null;
	}
	return null;
}

/** The `Set-Cookie` value that stores the choice for a year, or deletes the cookie for "system". */
export function colorSchemeCookie(choice: ColorSchemeChoice): string {
	return choice === "system"
		? `${COLOR_SCHEME_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`
		: `${COLOR_SCHEME_COOKIE}=${choice}; Max-Age=${ONE_YEAR_IN_SECONDS}; ${ATTRIBUTES}`;
}
