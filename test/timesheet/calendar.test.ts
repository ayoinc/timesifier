import { describe, expect, it } from "vitest";
import { periodContaining } from "~/periods/periods";
import { addDays, type Day, dayOf, daysFrom, instantAt, startOfDay } from "~/time/calendar";
import {
	calendarDays,
	daySegments,
	freeSlots,
	MINUTES_PER_DAY,
	monthAfter,
	monthSheet,
	placeSegments,
	zoomPath,
	zoomStep,
} from "~/timesheet/calendar-sheets";
import { type SheetEntry, totalOf, weekSheet } from "~/timesheet/sheets";
import { calendarPath } from "~/timesheet/views";
import { chosenView } from "~/timesheet/views.server";

// The calendar of Timesheet (TS-062), without the database: its totals are
// the Day and Week views', its blocks are the entries cut at midnight in the
// person's zone, on days of 23 and 25 hours too, and its addresses.

const HOUR = 3_600_000;
const MINUTE = 60_000;
const LONDON = "Europe/London";
const AUCKLAND = "Pacific/Auckland";

let ids = 0;
function entry(startedAt: number, endedAt: number | null, projectId = "p1"): SheetEntry {
	ids += 1;
	return { id: `e${ids}`, projectId, description: null, startedAt, endedAt, overtime: false };
}

/** A small seeded generator, so a failing case can be run again. */
function generator(seed: number) {
	let state = seed >>> 0;
	return (below: number) => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state % below;
	};
}

/** Random entries starting from the day before `first` for `spanDays` days, some running, some past midnight. */
function randomEntries(
	next: (below: number) => number,
	first: Day,
	spanDays: number,
	zone: string,
) {
	const from = instantAt(addDays(first, -1), 0, zone);
	return Array.from({ length: next(60) }, () => {
		const start = from + next((spanDays + 1) * 24 * 60) * MINUTE;
		const running = next(25) === 0;
		return entry(start, running ? null : start + next(20 * 60) * MINUTE, `p${next(4)}`);
	});
}

describe("the calendar's totals", () => {
	it("for random sets of entries, each day's is the Day view's, each week's the Week view's, and the month's the sum of its days", () => {
		for (const zone of [LONDON, AUCKLAND]) {
			for (const month of ["2026-03-01", "2026-10-01", "2026-11-01"]) {
				for (let seed = 1; seed <= 40; seed++) {
					const next = generator(seed);
					const weekStartsOn = 1 + next(7);
					const { days } = calendarDays("month", month, weekStartsOn);
					const entries = randomEntries(next, days[0] as Day, days.length, zone);
					const now = instantAt(days.at(-1) as Day, 12 * 60, zone);
					const sheet = monthSheet(entries, days, month, zone, now);

					for (const week of sheet.weeks) {
						const first = week.days[0]?.day as Day;
						const period = periodContaining(first, weekStartsOn);
						expect(first).toBe(period.startsOn);
						const periodDays = daysFrom(period.startsOn, period.endsOn);
						// The Week view reads only the entries that start in the period.
						const ofPeriod = entries.filter((e) => periodDays.includes(dayOf(e.startedAt, zone)));
						expect(week.total).toBe(weekSheet(ofPeriod, periodDays, zone, now).total);
						for (const { day, total } of week.days) {
							// The Day view: the entries that start on the day, added up.
							const ofDay = entries.filter((e) => dayOf(e.startedAt, zone) === day);
							expect(total, `${zone} ${day} seed ${seed}`).toBe(totalOf(ofDay, now));
						}
					}
					const inMonth = days.filter((day) => day.startsWith(month.slice(0, 7)));
					expect(sheet.total).toBe(
						totalOf(
							entries.filter((e) => inMonth.includes(dayOf(e.startedAt, zone))),
							now,
						),
					);
				}
			}
		}
	});

	it("marks the days of other months, and the busiest day", () => {
		const { days } = calendarDays("month", "2026-11-11", 1);
		const start = instantAt("2026-11-02", 9 * 60, LONDON);
		const sheet = monthSheet(
			[entry(start, start + 3 * HOUR), entry(start + 24 * HOUR, start + 25 * HOUR)],
			days,
			"2026-11-01",
			LONDON,
			start,
		);
		expect(sheet.weeks[0]?.days.map((d) => d.inMonth)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			true,
		]);
		expect(sheet.busiest).toBe(3 * HOUR);
		expect(sheet.total).toBe(4 * HOUR);
	});
});

describe("the calendar's days", () => {
	it("is the period of the day on the week's scale", () => {
		expect(calendarDays("week", "2026-11-11", 1)).toEqual({
			days: daysFrom("2026-11-09", "2026-11-15"),
			month: null,
		});
		expect(calendarDays("week", "2026-11-11", 7).days[0]).toBe("2026-11-08");
	});

	it("is whole periods from the month's first day to its last on the month's scale", () => {
		const november = calendarDays("month", "2026-11-11", 1);
		expect(november.month).toBe("2026-11-01");
		expect(november.days[0]).toBe("2026-10-26");
		expect(november.days.at(-1)).toBe("2026-12-06");
		expect(november.days).toHaveLength(42);
		// February 2027 starts on a Monday and has 28 days: four weeks exactly.
		expect(calendarDays("month", "2027-02-14", 1).days).toEqual(
			daysFrom("2027-02-01", "2027-02-28"),
		);
	});

	it("steps a month at a time, across a year", () => {
		expect(monthAfter("2026-12-01", 1)).toBe("2027-01-01");
		expect(monthAfter("2026-01-01", -1)).toBe("2025-12-01");
		expect(monthAfter("2026-01-01", 13)).toBe("2027-02-01");
	});
});

describe("the week calendar's blocks", () => {
	const week = daysFrom("2026-11-09", "2026-11-15");

	it("cut an entry from 23:30 to 00:30 at midnight in the person's zone", () => {
		const start = instantAt("2026-11-10", 23 * 60 + 30, LONDON);
		const parts = daySegments([entry(start, start + HOUR)], week, LONDON, start + 2 * HOUR);
		expect(parts.get("2026-11-10")).toMatchObject([
			{ from: 23 * 60 + 30, to: MINUTES_PER_DAY, continued: false, goesOn: true },
		]);
		expect(parts.get("2026-11-11")).toMatchObject([
			{ from: 0, to: 30, continued: true, goesOn: false },
		]);
	});

	it("draw a running entry up to now, so it grows as the clock does", () => {
		const start = instantAt("2026-11-11", 9 * 60, LONDON);
		const running = [entry(start, null)];
		expect(daySegments(running, week, LONDON, start + HOUR).get("2026-11-11")?.[0]?.to).toBe(
			10 * 60,
		);
		expect(daySegments(running, week, LONDON, start + 2 * HOUR).get("2026-11-11")?.[0]?.to).toBe(
			11 * 60,
		);
	});

	it("put the same entry on different days for a person in Auckland and one in London", () => {
		const start = Date.parse("2026-11-10T20:00:00Z");
		const one = [entry(start, start + HOUR)];
		expect(daySegments(one, week, LONDON, start).get("2026-11-10")).toHaveLength(1);
		expect(daySegments(one, week, AUCKLAND, start).get("2026-11-11")).toMatchObject([
			{ from: 9 * 60, to: 10 * 60 },
		]);
	});

	it("for random sets of entries, the parts of each entry cover it exactly, wherever the clocks change", () => {
		for (const zone of [LONDON, AUCKLAND]) {
			for (const first of ["2026-03-23", "2026-10-19", "2026-04-01", "2026-09-23"]) {
				const days = daysFrom(first, addDays(first, 13));
				for (let seed = 1; seed <= 40; seed++) {
					const next = generator(seed);
					const entries = randomEntries(next, addDays(first, 1), 11, zone);
					const now = instantAt(days.at(-1) as Day, 0, zone);
					const parts = daySegments(entries, days, zone, now);
					for (const one of entries) {
						const its = [...parts.values()].flat().filter((part) => part.entry === one);
						const covered = its.reduce((sum, part) => sum + part.endsAt - part.startsAt, 0);
						expect(covered).toBe(Math.max(0, (one.endedAt ?? now) - one.startedAt));
						for (const part of its) {
							expect(part.from).toBeGreaterThanOrEqual(0);
							expect(part.to).toBeLessThanOrEqual(MINUTES_PER_DAY);
							expect(part.to).toBeGreaterThanOrEqual(part.from);
							expect(part.startsAt).toBeGreaterThanOrEqual(startOfDay(part.day, zone));
							expect(part.endsAt).toBeLessThanOrEqual(startOfDay(addDays(part.day, 1), zone));
						}
					}
				}
			}
		}
	});

	it("on the 23-hour day in London, an entry from 00:30 to 03:30 lasts two hours and reads 00:30 to 03:30", () => {
		const start = instantAt("2026-03-29", 30, LONDON);
		const end = instantAt("2026-03-29", 3 * 60 + 30, LONDON);
		expect(end - start).toBe(2 * HOUR);
		const parts = daySegments([entry(start, end)], ["2026-03-29"], LONDON, end);
		expect(parts.get("2026-03-29")).toMatchObject([{ from: 30, to: 3 * 60 + 30 }]);
	});

	it("on the 25-hour day in London, a day-long entry is cut at that day's own midnights", () => {
		const from = startOfDay("2026-10-25", LONDON);
		const to = startOfDay("2026-10-26", LONDON);
		expect(to - from).toBe(25 * HOUR);
		const parts = daySegments(
			[entry(from - HOUR, to + HOUR)],
			daysFrom("2026-10-24", "2026-10-26"),
			LONDON,
			to,
		);
		expect(parts.get("2026-10-25")).toMatchObject([
			{ from: 0, to: MINUTES_PER_DAY, startsAt: from, endsAt: to, continued: true, goesOn: true },
		]);
		expect(parts.get("2026-10-26")).toMatchObject([{ from: 0, to: 60 }]);
	});

	it("are placed side by side where they overlap, and leave free slots elsewhere", () => {
		const nine = instantAt("2026-11-11", 9 * 60, LONDON);
		const parts = daySegments(
			[
				entry(nine, nine + 2 * HOUR),
				entry(nine + HOUR, nine + 3 * HOUR),
				entry(nine + 4 * HOUR, nine + 5 * HOUR),
			],
			["2026-11-11"],
			LONDON,
			nine,
		).get("2026-11-11");
		const placed = placeSegments(parts ?? [], 3);
		expect(placed.map((p) => [p.lane, p.lanes])).toEqual([
			[0, 2],
			[1, 2],
			[0, 1],
		]);
		const free = freeSlots(placed, 60);
		expect(free).not.toContain(9 * 60);
		expect(free).not.toContain(11 * 60);
		expect(free).toContain(12 * 60);
		expect(free).not.toContain(13 * 60);
		expect(free).toContain(14 * 60);
	});

	it("are never shorter than the least the zoom draws, even at midnight's edge", () => {
		const late = instantAt("2026-11-11", 23 * 60 + 55, LONDON);
		const parts = daySegments([entry(late, late + 4 * MINUTE)], ["2026-11-11"], LONDON, late);
		const [placed] = placeSegments(parts.get("2026-11-11") ?? [], 12);
		expect(placed).toMatchObject({ row: 288 - 12, rowEnd: 288 });
	});
});

describe("the calendar's address", () => {
	const query = (text: string) => chosenView(new URLSearchParams(text), 1);

	it("is the week of today in detail by default, or of a day, at a zoom, or a month", () => {
		expect(query("view=calendar")).toEqual({
			view: "calendar",
			scale: "week",
			date: null,
			zoom: "detailed",
		});
		expect(query("view=calendar&date=2026-11-11&zoom=compact")).toEqual({
			view: "calendar",
			scale: "week",
			date: "2026-11-11",
			zoom: "compact",
		});
		expect(query("view=calendar&scale=month&date=2026-11-01")).toMatchObject({
			scale: "month",
			date: "2026-11-01",
		});
	});

	it.each([
		"view=calendar&scale=year",
		"view=calendar&zoom=huge",
		"view=calendar&date=2026-02-30",
		"view=calendar&scale=month&zoom=compact",
		"view=calendar&start=2026-11-09",
	])("answers %j with 400", (text) => {
		let thrown: unknown;
		try {
			query(text);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({ init: { status: 400 } });
	});

	it("is written with its defaults left out, and read back the same", () => {
		expect(calendarPath("acme")).toBe("/app/acme?view=calendar");
		const path = calendarPath("acme", { scale: "month", date: "2026-11-01" });
		expect(path).toBe("/app/acme?view=calendar&scale=month&date=2026-11-01");
		expect(chosenView(new URL(path, "https://x").searchParams, 1)).toMatchObject({
			scale: "month",
		});
	});

	it("zooms from the month to the week, the week in detail and the Day view, and back", () => {
		expect(zoomStep("month", -1)).toBeNull();
		expect(zoomStep("month", 1)).toBe("compact");
		expect(zoomStep("compact", 1)).toBe("detailed");
		expect(zoomStep("detailed", 1)).toBe("day");
		expect(zoomStep("day", 1)).toBeNull();
		expect(zoomPath("acme", "compact", "2026-11-11")).toBe(
			"/app/acme?view=calendar&date=2026-11-11&zoom=compact",
		);
		expect(zoomPath("acme", "day", "2026-11-11")).toBe("/app/acme?day=2026-11-11");
	});
});
