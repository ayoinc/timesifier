// Relative: routes.ts reads this file when the routes are built, without the `~` alias.
import { nameKey } from "../lib/names";
import { destinationPath } from "../shell/destinations";

/**
 * What the pages of projects and clients share with the browser
 * (TS-011a, TS-011b, TS-057). The rules that read the database are in
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

/**
 * The query that narrows a list to the records whose name has the words
 * typed, kept in the address so a search can be linked to and reloaded:
 * `?q=acme` (TS-057). The list is narrowed on the server, and with script in
 * the page as each key is typed (TS-114, `projectMatches`).
 */
export const SEARCH_PARAM = "q";

/** The words an address searches for, the space round them cut: "" when it searches for nothing. */
export function searchIn(search: URLSearchParams): string {
	return search.get(SEARCH_PARAM)?.trim() ?? "";
}

/**
 * Whether a project is one the words `query` find, as `listProjects` finds it:
 * by its name, or by its client's while the organisation shows clients.
 */
export function projectMatches(
	project: { name: string; client: { key: string } | null },
	query: string,
	byClient: boolean,
): boolean {
	const key = nameKey(query);
	return (
		nameKey(project.name).includes(key) ||
		(byClient && (project.client?.key.includes(key) ?? false))
	);
}

/** Whether a move from `current` to `next` changes the words searched for and nothing else. */
export function onlySearchChanged(current: URL, next: URL): boolean {
	if (current.pathname !== next.pathname) return false;
	const a = new URLSearchParams(current.search);
	const b = new URLSearchParams(next.search);
	a.delete(SEARCH_PARAM);
	b.delete(SEARCH_PARAM);
	return a.toString() === b.toString();
}

/**
 * What a list's filters keep of the address when they apply: the tab, when it
 * is Archived, so a search does not move the person back to Active.
 */
export function keptTab(search: URLSearchParams): Record<string, string> | undefined {
	return shownIn(search) === ARCHIVED ? { [SHOW_PARAM]: ARCHIVED } : undefined;
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

/** A project as Projects groups it: under its client, or none. `key` is the client's `name_key`. */
export interface Grouped {
	client: { id: string; name: string; key: string; archived: boolean } | null;
}

/** One client's projects, or (`client` null) the projects with none. */
export interface ClientGroup<P extends Grouped> {
	client: P["client"];
	projects: P[];
}

/**
 * The projects under their client: one group for each client, in the order of
 * the clients' names, then the projects with no client. Within a group the
 * projects keep the order they came in (TS-057).
 */
export function groupedByClient<P extends Grouped>(projects: readonly P[]): ClientGroup<P>[] {
	const groups = new Map<string | null, ClientGroup<P>>();
	for (const project of projects) {
		const id = project.client?.id ?? null;
		const group: ClientGroup<P> = groups.get(id) ?? { client: project.client, projects: [] };
		group.projects.push(project);
		groups.set(id, group);
	}
	return [...groups.values()].sort((a, b) => {
		if (a.client === null || b.client === null) return a.client === null ? 1 : -1;
		return a.client.key < b.client.key ? -1 : a.client.key > b.client.key ? 1 : 0;
	});
}

/** The route parameter that names a project on its own page (harvest-taste.md item 11). */
export const PROJECT_PARAM = "projectId";

/** What follows Projects in the address of the default rates: each person's and each task's (TS-067). */
export const DEFAULT_RATES_SEGMENT = "rates";

/** The address of the project `id`'s own page in the organisation `slug`; `tab` picks one of its tabs. */
export function projectPath(slug: string, id: string, tab?: ProjectTab): string {
	const path = `${destinationPath(slug, "projects")}/${id}`;
	return tab === undefined || tab === "overview" ? path : `${path}?${TAB_PARAM}=${tab}`;
}

/** The address of the default rates in the organisation `slug`. */
export function defaultRatesPath(slug: string): string {
	return `${destinationPath(slug, "projects")}/${DEFAULT_RATES_SEGMENT}`;
}

/** The tabs of a project's page, in order: what it has come to, its tasks, its people and its settings. */
export const PROJECT_TABS = ["overview", "tasks", "team", "settings"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

/** The query that picks a project page's tab, kept in the address so a tab can be linked to. */
export const TAB_PARAM = "tab";

/** The tab an address asks for: Overview unless it names another. */
export function projectTabIn(search: URLSearchParams): ProjectTab {
	const asked = search.get(TAB_PARAM);
	return PROJECT_TABS.find((tab) => tab === asked) ?? "overview";
}
