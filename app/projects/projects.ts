/**
 * What the pages of projects and clients share with the browser
 * (TS-011a, TS-011b). The rules that read the database are in
 * `projects.server.ts` and `app/clients/clients.server.ts`.
 */

/** The value of a project's client field that means it has none. No client's id is this word. */
export const NO_CLIENT = "none";

/**
 * The query that picks the tab of a list of records, kept in the address so
 * the archived list can be linked to and reloaded: `?show=archived`.
 */
export const SHOW_PARAM = "show";
export const ARCHIVED = "archived";
export const ACTIVE = "active";
export type Shown = typeof ACTIVE | typeof ARCHIVED;

/** The tab an address asks for: Archived when it says so, Active otherwise. */
export function shownIn(search: URLSearchParams): Shown {
	return search.get(SHOW_PARAM) === ARCHIVED ? ARCHIVED : ACTIVE;
}

/** The query for a tab: none for Active, the default. */
export function searchFor(shown: Shown): Record<string, string> {
	return shown === ARCHIVED ? { [SHOW_PARAM]: ARCHIVED } : {};
}

/**
 * Whether a route's data must be read again for a move from `current` to
 * `next`: not when only the tab in the address changed, because the loader
 * already sent both lists. A form sent to the page always reads it again.
 */
export function onlyTabChanged(current: URL, next: URL): boolean {
	if (current.pathname !== next.pathname) return false;
	const a = new URLSearchParams(current.search);
	const b = new URLSearchParams(next.search);
	a.delete(SHOW_PARAM);
	b.delete(SHOW_PARAM);
	return a.toString() === b.toString();
}
