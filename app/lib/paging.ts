import { shownName } from "~/organisations/people";

import { RECORD_NAME_MAX_LENGTH } from "./names";

// Lists of people that page and search (TS-113): Team and Default rates show
// 50 people at a time, in the order of the names they are shown by, with a
// filter by name or address. The page and the filter are in the address, so a
// page can be linked and reloaded, and both work without JavaScript. Nothing
// here runs only on the server.

/** How many people a page lists. */
export const PAGE_SIZE = 50;
/** The query of the page shown, from 1; absent on the first. */
export const PAGE_PARAM = "page";
/** The query that narrows a list to the people whose name or address holds it. */
export const FILTER_PARAM = "q";

/** A person as a list of people shows them. */
export interface ListedPerson {
	id: string;
	/** Their name, or their address when they have given none. */
	name: string;
	email: string;
	/** Their address when they have given no name; null when they have. */
	address: string | null;
}

/** The name a list titles a person by (`shownName`): their name, or their address up to the "@". */
export function listedName(person: ListedPerson): string {
	return person.address ? shownName({ email: person.address }) : person.name;
}

/** The filter in the address, trimmed and cut to the length of a name; "" for none. */
export function filterOf(params: URLSearchParams): string {
	return (params.get(FILTER_PARAM) ?? "").trim().slice(0, RECORD_NAME_MAX_LENGTH);
}

/** The page asked for in the address: a whole number from 1, else the first. */
export function pageNumberOf(params: URLSearchParams): number {
	const asked = Number(params.get(PAGE_PARAM));
	return Number.isSafeInteger(asked) && asked > 1 ? asked : 1;
}

/** One page of a list, and where it sits in the whole. */
export interface Page<T> {
	items: T[];
	/** The page shown, from 1. */
	number: number;
	/** How many pages the list fills; 1 for an empty list. */
	pages: number;
	/** How many the whole list holds. */
	total: number;
	/** The place of the page's first item in the list, from 1; 0 when the list is empty. */
	first: number;
}

/** Page `number` of `items`, or the last page when `number` is past it. */
export function pageOf<T>(items: readonly T[], number: number, size = PAGE_SIZE): Page<T> {
	const pages = Math.max(1, Math.ceil(items.length / size));
	const shown = Math.min(Math.max(1, number), pages);
	const start = (shown - 1) * size;
	return {
		items: items.slice(start, start + size),
		number: shown,
		pages,
		total: items.length,
		first: items.length === 0 ? 0 : start + 1,
	};
}

/**
 * The people whose name or address holds `filter`, in any case, ordered by
 * the name they are listed by and then by id; everyone for an empty filter.
 */
export function matchingPeople<P extends ListedPerson>(people: readonly P[], filter: string): P[] {
	const key = filter.toLocaleLowerCase("en");
	return people
		.filter(
			(p) =>
				p.name.toLocaleLowerCase("en").includes(key) ||
				p.email.toLocaleLowerCase("en").includes(key),
		)
		.map((p) => ({ person: p, name: listedName(p) }))
		.sort((a, b) => {
			const byName = a.name.localeCompare(b.name, "en");
			if (byName !== 0) return byName;
			return a.person.id < b.person.id ? -1 : a.person.id > b.person.id ? 1 : 0;
		})
		.map(({ person }) => person);
}

/** The page the address asks for of the people the filter in it matches (`matchingPeople`). */
export function pageOfPeople<P extends ListedPerson>(
	people: readonly P[],
	params: URLSearchParams,
): Page<P> {
	return pageOf(matchingPeople(people, filterOf(params)), pageNumberOf(params));
}

/** A query string, "?a=1&b=2", of the values given; an empty or absent one is left out. */
export function queryOf(values: Record<string, string | number | null | undefined>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
	}
	const query = params.toString();
	return query === "" ? "?" : `?${query}`;
}
