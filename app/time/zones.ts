import * as z from "zod";

/**
 * Time zones (docs/decisions.md entry 26). A zone is an IANA name such as
 * `Europe/London`, accepted only if it is `UTC` or `Intl` knows it.
 */

let known: ReadonlySet<string> | undefined;

/** Whether `name` is a zone this application accepts. */
export function isTimeZone(name: string): boolean {
	known ??= new Set(Intl.supportedValuesOf("timeZone"));
	return name === "UTC" || known.has(name);
}

/** A zone as a form carries it. */
export const TimeZone = z.string().max(64).refine(isTimeZone, "Not a known time zone.");

/**
 * The zone a person's days are counted in: their own, or, until they have
 * set one, their organisation's default (TS-048), which is `UTC` until an
 * owner or admin chooses another.
 */
export function zoneOf(person: { timeZone: string | null }, organisation: { timeZone: string }) {
	return person.timeZone ?? organisation.timeZone;
}
