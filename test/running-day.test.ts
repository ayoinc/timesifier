import { expect, it } from "vitest";

import { type Entry, LOGGED_ENTRIES, length, RUNNING } from "~/landing/example-week";
import {
	begin,
	dayAt,
	EXAMPLE_DAY,
	EXAMPLE_WEEK,
	toggled,
	weekAt,
	yearWeek,
} from "~/landing/running-day";

// The day on the home page once its clock runs. Whenever it is looked at, the
// total is the entries shown added to the time on the timer, and nothing on the
// sheet happened before the day began or after now. The tests run in UTC.

const at = (iso: string) => new Date(iso).getTime();
const minutesOf = (entries: readonly Entry[]) =>
	entries.reduce((total, entry) => total + length(entry), 0);

const AFTERNOON = at("2026-11-11T15:02:47Z");

it("before the clock runs, the still example adds up", () => {
	expect(EXAMPLE_DAY.total).toBe(minutesOf(EXAMPLE_DAY.logged) * 60 + EXAMPLE_DAY.elapsed);
	expect(EXAMPLE_DAY.since).toBe(RUNNING.entry.start);
});

it("in the afternoon the day is the example moved to now: the same entries and the same breaks", () => {
	const day = dayAt(begin(AFTERNOON), AFTERNOON);

	expect(day.date).toBe("Wednesday 11 November");
	expect(day.logged.map(length)).toEqual(LOGGED_ENTRIES.map(length));
	// The breaks are the example's too: the timer started as long after the last entry.
	expect(day.since - (day.logged.at(-1)?.end ?? 0)).toBe(
		RUNNING.entry.start - (LOGGED_ENTRIES.at(-1)?.end ?? 0),
	);
	// The timer started on a whole minute, as long ago as the example's has run.
	expect(day.elapsed).toBeGreaterThanOrEqual(RUNNING.elapsedSeconds);
	expect(day.elapsed).toBeLessThan(RUNNING.elapsedSeconds + 60);
	expect((day.since * 60 + day.elapsed) % 86_400).toBe(15 * 3600 + 2 * 60 + 47);
});

it("the day is the visitor's own today, whatever the date", () => {
	const now = at("2027-02-28T22:10:00Z");

	expect(dayAt(begin(now), now)).toMatchObject({
		weekday: "Sunday",
		date: "Sunday 28 February",
	});
});

it("the timer gains a second every second, and the total with it", () => {
	const clock = begin(AFTERNOON);
	const first = dayAt(clock, AFTERNOON);

	for (const seconds of [1, 2, 59, 60, 3600]) {
		const later = dayAt(clock, AFTERNOON + seconds * 1000);
		expect(later.elapsed).toBe(first.elapsed + seconds);
		expect(later.total).toBe(first.total + seconds);
		expect(later.logged).toBe(first.logged);
		expect(later.since).toBe(first.since);
	}
});

it("at every time of day the total is what is shown, added up, and the entries follow one another", () => {
	// Every seven minutes and thirteen seconds through a day and a night.
	for (let now = at("2026-11-11T00:00:00Z"); now < at("2026-11-12T00:00:00Z"); now += 433_000) {
		const day = dayAt(begin(now), now);
		const when = new Date(now).toISOString();

		expect(day.total, when).toBe(minutesOf(day.logged) * 60 + day.elapsed);
		expect(day.elapsed, when).toBeGreaterThan(0);
		expect(day.logged, when).toHaveLength(LOGGED_ENTRIES.length);
		expect(
			day.logged.map((entry) => entry.note),
			when,
		).toEqual(LOGGED_ENTRIES.map((entry) => entry.note));

		let previousEnd = 0;
		for (const entry of day.logged) {
			expect(entry.start, when).toBeGreaterThanOrEqual(previousEnd);
			expect(length(entry), when).toBeGreaterThan(0);
			previousEnd = entry.end;
		}
		expect(day.since, when).toBeGreaterThanOrEqual(previousEnd);
	}
});

it("early in the day the entries are shorter, and none of them is before the day began", () => {
	const now = at("2026-11-11T01:30:10Z");
	const day = dayAt(begin(now), now);

	expect(day.date).toBe("Wednesday 11 November");
	expect(day.logged[0]?.start).toBeGreaterThanOrEqual(0);
	expect(minutesOf(day.logged)).toBeLessThan(minutesOf(LOGGED_ENTRIES));
	// What the timer shows started before now and after the last entry ended.
	expect(day.since * 60 + day.elapsed).toBe(1 * 3600 + 30 * 60 + 10);
});

it("too soon after midnight for a day to have happened, the sheet stays the dated example and its timer still runs", () => {
	const now = at("2026-07-03T00:04:00Z");
	const clock = begin(now);

	expect(dayAt(clock, now)).toEqual(EXAMPLE_DAY);
	expect(dayAt(clock, now + 5000).elapsed).toBe(EXAMPLE_DAY.elapsed + 5);
});

it("stopping holds the time, and starting again goes on from where it stopped", () => {
	const running = begin(AFTERNOON);
	const stopped = toggled(running, AFTERNOON + 4000);
	const held = dayAt(stopped, AFTERNOON + 4000);

	expect(held.elapsed).toBe(dayAt(running, AFTERNOON).elapsed + 4);
	expect(dayAt(stopped, AFTERNOON + 90_000)).toEqual(held);

	const again = toggled(stopped, AFTERNOON + 90_000);
	expect(dayAt(again, AFTERNOON + 90_000)).toEqual(held);
	expect(dayAt(again, AFTERNOON + 93_000).elapsed).toBe(held.elapsed + 3);
	expect(dayAt(again, AFTERNOON + 93_000).total).toBe(held.total + 3);
});

// The week in its year, counted as ISO 8601 counts it.

const weekOf = (iso: string) => {
	const { year, week, months } = yearWeek(at(iso));
	return { year, week, weeks: months.reduce((total, each) => total + each, 0) };
};

it("the example's week is the forty-sixth of a year of fifty-three", () => {
	expect(EXAMPLE_WEEK).toMatchObject({ year: 2026, week: 46 });
	expect(weekOf("2026-11-11T12:00:00Z")).toEqual({ year: 2026, week: 46, weeks: 53 });
});

it("a week belongs to the year its Thursday is in", () => {
	// Thursday 1 January 2026 is in the first week of 2026, and so is the Monday before it.
	expect(weekOf("2026-01-01T12:00:00Z")).toMatchObject({ year: 2026, week: 1 });
	expect(weekOf("2025-12-29T12:00:00Z")).toMatchObject({ year: 2026, week: 1 });
	// Friday 1 January 2027 is still in the last week of 2026.
	expect(weekOf("2027-01-01T12:00:00Z")).toEqual({ year: 2026, week: 53, weeks: 53 });
	expect(weekOf("2027-01-04T12:00:00Z")).toEqual({ year: 2027, week: 1, weeks: 52 });
	expect(weekOf("2024-12-30T12:00:00Z")).toMatchObject({ year: 2025, week: 1 });
});

it("every month of any year has four or five weeks, and the weeks before this month are fewer than this week", () => {
	for (let year = 2024; year <= 2032; year += 1) {
		const { months, week } = yearWeek(at(`${year}-08-15T12:00:00Z`));
		const weeks = months.reduce((total, each) => total + each, 0);

		expect(months).toHaveLength(12);
		expect([52, 53]).toContain(weeks);
		for (const count of months) expect([4, 5]).toContain(count);
		expect(week).toBeGreaterThan(0);
		expect(week).toBeLessThanOrEqual(weeks);
	}
});

it("the week follows the visitor's clock, and stays the example's while the sheet does", () => {
	expect(weekAt(begin(AFTERNOON), AFTERNOON)).toEqual(yearWeek(AFTERNOON));

	const justAfterMidnight = at("2027-07-03T00:04:00Z");
	expect(weekAt(begin(justAfterMidnight), justAfterMidnight)).toBe(EXAMPLE_WEEK);
});
