import * as z from "zod";

// The colour scheme of the page. Light is the product's face: a person who has
// chosen nothing gets it, whatever their device prefers. Dark, and following the
// device, are choices made in Settings and kept in a cookie so the server can
// render them: the page arrives in the right scheme, with no flash and no
// inline script. docs/security.md describes the cookie.

/** `__Host-`: the browser takes it only over HTTPS, with `Path=/` and no `Domain`. */
export const COLOR_SCHEME_COOKIE = "__Host-color-scheme";

/** In the order Settings offers them. `system` follows the device. */
export const COLOR_SCHEME_CHOICES = ["light", "dark", "system"] as const;
export type ColorSchemeChoice = (typeof COLOR_SCHEME_CHOICES)[number];
/** A scheme that holds whatever the device prefers. */
export type ForcedColorScheme = Exclude<ColorSchemeChoice, "system">;

/** What a person who has chosen nothing gets. */
const DEFAULT_COLOR_SCHEME: ForcedColorScheme = "light";

/** What the colour-scheme form submits. */
export const colorSchemeForm = z.object({ scheme: z.enum(COLOR_SCHEME_CHOICES) });

// Not `HttpOnly`: the value is no secret, and a page may read what it shows.
const ATTRIBUTES = "Path=/; Secure; SameSite=Lax";
const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

const isChoice = (value: string): value is ColorSchemeChoice =>
	(COLOR_SCHEME_CHOICES as readonly string[]).includes(value);

/** The choice in the `Cookie` header. No cookie, or any value that is not a choice, is light. */
export function readColorScheme(cookieHeader: string | null): ColorSchemeChoice {
	for (const pair of cookieHeader?.split(";") ?? []) {
		const separator = pair.indexOf("=");
		if (separator === -1 || pair.slice(0, separator).trim() !== COLOR_SCHEME_COOKIE) continue;
		const value = pair.slice(separator + 1).trim();
		return isChoice(value) ? value : DEFAULT_COLOR_SCHEME;
	}
	return DEFAULT_COLOR_SCHEME;
}

/** The `Set-Cookie` value that stores the choice for a year. */
export function colorSchemeCookie(choice: ColorSchemeChoice): string {
	return `${COLOR_SCHEME_COOKIE}=${choice}; Max-Age=${ONE_YEAR_IN_SECONDS}; ${ATTRIBUTES}`;
}
