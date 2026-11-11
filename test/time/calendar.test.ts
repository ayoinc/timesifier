import { describe, expect, it } from "vitest";
import {
	addDays,
	bounds,
	Day,
	dayOf,
	daysFrom,
	instantAt,
	isoWeekday,
	startOfDay,
} from "~/time/calendar";
import { GRID_DAY_STARTS_AT_MINUTES, gridEntryStart } from "~/time/grid";
import { isTimeZone, TimeZone, zoneOf } from "~/time/zones";

// Days and instants in a time zone (docs/decisions.md entry 26), the rule for
// an hour typed into the week's grid (TS-052), and which zones are accepted.

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;

describe("a local date", () => {
	it.each(["2026-11-11", "2024-02-29"])("%s is a date", (day) => {
		expect(Day.safeParse(day).success).toBe(true);
	});

	it.each(["2026-02-29", "2026-13-01", "2026-1-01", "11/11/2026", "", "2026-11-11T00:00"])(
		"%j is not",
		(day) => {
			expect(Day.safeParse(day).success).toBe(false);
		},
	);

	it("moves by days across months, years and leap days", () => {
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
		expect(addDays("2026-11-11", -14)).toBe("2026-10-28");
	});

	it("knows its day of the week, Monday 1 to Sunday 7", () => {
		expect(isoWeekday("2026-11-09")).toBe(1);
		expect(isoWeekday("2026-11-11")).toBe(3);
		expect(isoWeekday("2026-11-15")).toBe(7);
	});

	it("lists a run of days, both ends included", () => {
		expect(daysFrom("2026-12-30", "2027-01-02")).toEqual([
			"2026-12-30",
			"2026-12-31",
			"2027-01-01",
			"2027-01-02",
		]);
	});
});

describe("the day an instant falls on", () => {
	it("depends on the zone of the person looking", () => {
		const instant = at("2026-03-28T12:30:00Z");
		expect(dayOf(instant, "Europe/London")).toBe("2026-03-28");
		expect(dayOf(instant, "Pacific/Auckland")).toBe("2026-03-29");
		expect(dayOf(instant, "America/Los_Angeles")).toBe("2026-03-28");
		expect(dayOf(new Date(instant), "UTC")).toBe("2026-03-28");
	});

	it("is the day an entry from 23:30 to 00:30 starts on, in London", () => {
		expect(dayOf(at("2026-11-11T23:30:00Z"), "Europe/London")).toBe("2026-11-11");
	});
});

describe("the bounds of a day", () => {
	it("are 23 hours on the day the clocks go forward in London, and 25 on the day they go back", () => {
		const spring = bounds("2026-03-29", "2026-03-29", "Europe/London");
		expect(spring).toEqual({ from: at("2026-03-29T00:00:00Z"), to: at("2026-03-29T23:00:00Z") });
		expect(spring.to - spring.from).toBe(23 * HOUR);

		const autumn = bounds("2026-10-25", "2026-10-25", "Europe/London");
		expect(autumn.to - autumn.from).toBe(25 * HOUR);
	});

	it("start at local midnight in a zone ahead of UTC", () => {
		expect(startOfDay("2026-03-29", "Pacific/Auckland")).toBe(at("2026-03-28T11:00:00Z"));
	});

	it("start where a clock change skips midnight itself", () => {
		// Santiago moves from 00:00 to 01:00 on the first Sunday of September.
		const start = startOfDay("2026-09-06", "America/Santiago");
		expect(dayOf(start, "America/Santiago")).toBe("2026-09-06");
		expect(dayOf(start - 1, "America/Santiago")).toBe("2026-09-05");
	});

	it("hold the week of 2026-03-29 in London, the Sunday with 23 hours included", () => {
		const week = bounds("2026-03-23", "2026-03-29", "Europe/London");
		expect(week.to - week.from).toBe(7 * 24 * HOUR - HOUR);
		// 00:30 local on the Sunday is in the week, and on the Sunday.
		const sunday = at("2026-03-29T00:30:00Z");
		expect(sunday).toBeGreaterThanOrEqual(week.from);
		expect(sunday).toBeLessThan(week.to);
		expect(dayOf(sunday, "Europe/London")).toBe("2026-03-29");
	});
});

describe("a wall time on a day", () => {
	it("is the instant its clock shows it", () => {
		expect(instantAt("2026-11-11", 9 * 60, "Europe/London")).toBe(at("2026-11-11T09:00:00Z"));
		expect(instantAt("2026-07-01", 9 * 60, "Europe/London")).toBe(at("2026-07-01T08:00:00Z"));
		expect(instantAt("2026-07-01", 9 * 60, "Pacific/Auckland")).toBe(at("2026-06-30T21:00:00Z"));
	});

	it("skipped by the clock is read as that many minutes after the change", () => {
		// 01:30 does not exist in London on 2026-03-29: the clocks go from 01:00 to 02:00.
		expect(instantAt("2026-03-29", 90, "Europe/London")).toBe(at("2026-03-29T01:30:00Z"));
	});

	it("passed twice by the clock is the first of the two", () => {
		// 01:30 happens twice in London on 2026-10-25, first in summer time.
		expect(instantAt("2026-10-25", 90, "Europe/London")).toBe(at("2026-10-25T00:30:00Z"));
	});
});

describe("an hour typed into the week's grid (TS-052)", () => {
	const zone = "Europe/London";
	const now = at("2026-11-11T15:00:00Z");

	it("starts at 09:00 in the person's zone on a day with no entries", () => {
		expect(GRID_DAY_STARTS_AT_MINUTES).toBe(9 * 60);
		expect(gridEntryStart("2026-07-01", zone, [], now)).toBe(at("2026-07-01T08:00:00Z"));
	});

	it("starts when the day's last entry ends", () => {
		const entries = [
			{ startedAt: at("2026-11-10T09:00:00Z"), endedAt: at("2026-11-10T12:00:00Z") },
			{ startedAt: at("2026-11-10T13:00:00Z"), endedAt: at("2026-11-10T14:30:00Z") },
			// Another day's entry, which ends later, does not count.
			{ startedAt: at("2026-11-11T08:00:00Z"), endedAt: at("2026-11-11T10:00:00Z") },
		];
		expect(gridEntryStart("2026-11-10", zone, entries, now)).toBe(at("2026-11-10T14:30:00Z"));
	});

	it("counts an entry by the day it starts on, and a running one as ending now", () => {
		const entries = [
			{
				startedAt: new Date(at("2026-11-10T23:30:00Z")),
				endedAt: new Date(at("2026-11-11T00:30:00Z")),
			},
			{ startedAt: at("2026-11-11T13:00:00Z"), endedAt: null },
		];
		expect(gridEntryStart("2026-11-10", zone, entries, now)).toBe(at("2026-11-11T00:30:00Z"));
		expect(gridEntryStart("2026-11-11", zone, entries, now)).toBe(now);
	});
});

describe("a time zone", () => {
	it.each(["UTC", "Europe/London", "Pacific/Auckland"])("%s is accepted", (zone) => {
		expect(isTimeZone(zone)).toBe(true);
		expect(TimeZone.safeParse(zone).success).toBe(true);
	});

	it.each(["Europe/Atlantis", "", "GMT+1", "europe/london"])("%j is not", (zone) => {
		expect(TimeZone.safeParse(zone).success).toBe(false);
	});

	it("is the person's own, or their organisation's until they set one", () => {
		expect(zoneOf({ timeZone: "Europe/London" }, { timeZone: "UTC" })).toBe("Europe/London");
		expect(zoneOf({ timeZone: null }, { timeZone: "Pacific/Auckland" })).toBe("Pacific/Auckland");
	});
});
