import type { Day } from "~/time/calendar";
import { slugFromName } from "./slug";

/**
 * The name of a file an organisation exports for itself (TS-100): its name
 * slugged, what the file holds, and the day it was exported in the
 * organisation's time zone, as in
 * "acme-co-time-2026-11-02-to-2026-11-08-exported-2026-11-13.csv". Letters,
 * digits and hyphens, so a header carries it as it is. The name is the one the
 * organisation has now, not the slug of its address, which a rename keeps.
 */
export function exportFilename(
	organisationName: string,
	holds: string,
	exportedOn: Day,
	extension: "csv" | "zip",
): string {
	return `${slugFromName(organisationName)}-${holds}-exported-${exportedOn}.${extension}`;
}
