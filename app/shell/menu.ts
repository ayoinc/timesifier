import { organisationPath } from "./destinations";

// Whether the navigation's column is tucked away for wide work (sweep S2-10,
// decision 66). The choice belongs to the browser, not the account: a cookie
// the server reads, so the page arrives in the shape it was left in, with no
// flash and no inline script, as the colour scheme does. docs/security.md
// describes the cookie.
//
// With script the toggle writes the cookie itself and the page changes at
// once, with no request; without, its form posts to `menuPath`, whose action
// (`app/routes/app/menu.ts`) writes it and sends the browser back.

/** `__Host-`: the browser takes it only over HTTPS, with `Path=/` and no `Domain`. */
export const MENU_COOKIE = "__Host-menu";

/** The one value it holds: the column is hidden. Anything else, or none, is the column shown. */
const HIDDEN = "hidden";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/** The segment below an organisation the toggle's form posts to without script. */
export const MENU_SEGMENT = "menu";

/** The address the toggle's form posts to without script. */
export function menuPath(slug: string): string {
	return `${organisationPath(slug)}/${MENU_SEGMENT}`;
}

/** Whether the `Cookie` header says the column is hidden. No cookie, or any other value, is shown. */
export function readMenuHidden(cookieHeader: string | null): boolean {
	for (const pair of cookieHeader?.split(";") ?? []) {
		const separator = pair.indexOf("=");
		if (separator === -1 || pair.slice(0, separator).trim() !== MENU_COOKIE) continue;
		return pair.slice(separator + 1).trim() === HIDDEN;
	}
	return false;
}

/**
 * The cookie that stores the choice for a year, as `Set-Cookie` sends it and
 * `document.cookie` takes it. Shown is the default, so showing it again
 * removes the cookie. Not `HttpOnly`: the toggle writes it from script, and it
 * identifies nobody and grants nothing.
 */
export function menuCookie(hidden: boolean): string {
	const life = hidden ? ONE_YEAR_IN_SECONDS : 0;
	return `${MENU_COOKIE}=${hidden ? HIDDEN : ""}; Max-Age=${life}; Path=/; Secure; SameSite=Lax`;
}
