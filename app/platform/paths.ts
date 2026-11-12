// The addresses of the platform console (TS-099). Every page is under
// `/platform`; nothing else writes one of these addresses.

export const PLATFORM_PATH = "/platform";
export const VERIFY_PATH = `${PLATFORM_PATH}/verify`;
export const ORGANISATIONS_PATH = `${PLATFORM_PATH}/organisations`;
export const ACCOUNTS_PATH = `${PLATFORM_PATH}/accounts`;
export const MAIL_PATH = `${PLATFORM_PATH}/mail`;
export const PLATFORM_ACTIVITY_PATH = `${PLATFORM_PATH}/activity`;

/**
 * The header the sign-in page sends with the code when a new person asked for
 * the newsletter; the account is created with it on (TS-099). It changes
 * nothing for an account that exists.
 */
export const NEWSLETTER_HEADER = "x-timesifier-newsletter";

// An organisation's own pages that TS-099 adds, below Workspace settings and
// My account, so the navigation marks those as current.

/** Where an owner grants and revokes support access. */
export const SUPPORT_ACCESS_SEGMENT = "settings/support";
/** Where an owner reads the anonymised wellbeing signals. */
export const WELLBEING_SEGMENT = "settings/wellbeing";
/** A person's own data, as a ZIP. */
export const PERSONAL_DATA_SEGMENT = "account/data";

export function organisationConsolePath(id: string): string {
	return `${ORGANISATIONS_PATH}/${encodeURIComponent(id)}`;
}

export function supportViewPath(id: string): string {
	return `${organisationConsolePath(id)}/support`;
}

export function accountConsolePath(id: string): string {
	return `${ACCOUNTS_PATH}/${encodeURIComponent(id)}`;
}

/** The console's sections, in the order its tabs show them. */
export const CONSOLE_TABS = [
	{ href: PLATFORM_PATH, label: "Health" },
	{ href: ORGANISATIONS_PATH, label: "Organisations" },
	{ href: ACCOUNTS_PATH, label: "Accounts" },
	{ href: MAIL_PATH, label: "Mail" },
	{ href: PLATFORM_ACTIVITY_PATH, label: "Log" },
] as const;

/** A path inside the console to go back to after the step-up, or the console's first page. */
export function safeConsoleNext(next: string | null): string {
	if (!next?.startsWith(`${PLATFORM_PATH}/`) || next.startsWith(VERIFY_PATH)) return PLATFORM_PATH;
	if (/[\\\s]/.test(next)) return PLATFORM_PATH;
	return next;
}
