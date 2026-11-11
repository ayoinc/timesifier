/**
 * Workspace settings, General (TS-048): what an owner or admin sets for
 * everyone in the organisation besides its name. The organisation's default
 * time zone, which a person's days are counted in until they set their own
 * (`zoneOf` in `app/time/zones.ts`); the day its weeks start on, which every
 * timesheet period starts on (`periodContaining` in `app/periods/periods.ts`);
 * and whether Clients is shown (`canSee` in `app/shell/destinations.ts`).
 */

/** The days a week may start on, by ISO weekday: 1 is Monday, 7 is Sunday. */
export const WEEKDAYS = [
	{ id: "1", label: "Monday" },
	{ id: "2", label: "Tuesday" },
	{ id: "3", label: "Wednesday" },
	{ id: "4", label: "Thursday" },
	{ id: "5", label: "Friday" },
	{ id: "6", label: "Saturday" },
	{ id: "7", label: "Sunday" },
] as const;

/** The name of an ISO weekday. */
export function weekdayName(weekday: number): string {
	return WEEKDAYS[weekday - 1]?.label ?? `${weekday}`;
}

/** A zone's name as a person reads it: `America/New_York` as "America/New York". */
export function zoneLabel(zone: string): string {
	return zone.replaceAll("_", " ");
}
