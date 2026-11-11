import { expect, it } from "vitest";
import {
	DAYS,
	dayTotals,
	duration,
	LOGGED_ENTRIES,
	length,
	loggedToday,
	PROJECTS,
	RUNNING,
	TODAY,
	TODAY_ENTRIES,
	week,
	weekTotal,
} from "~/landing/example-week";

// The home page shows a day and the week that day is in. They are one example:
// the day's entries are what the week's table says about that day, and every
// total is the sum of what is shown under it.

it("the day's entries are what the week shows for that day, project by project", () => {
	for (const project of PROJECTS) {
		const fromEntries = TODAY_ENTRIES.filter((entry) => entry.project === project)
			.map(length)
			.reduce((total, each) => total + each, 0);
		expect(fromEntries, project).toBe(week.find((row) => row.project === project)?.days[TODAY]);
	}
});

it("the entries of the day follow one another without overlapping", () => {
	for (const [index, entry] of TODAY_ENTRIES.entries()) {
		expect(entry.end).toBeGreaterThan(entry.start);
		const next = TODAY_ENTRIES[index + 1];
		if (next) expect(next.start).toBeGreaterThanOrEqual(entry.end);
	}
});

it("the running entry is the last of the day, and what is logged is everything before it", () => {
	expect(RUNNING.entry).toBe(TODAY_ENTRIES.at(-1));
	expect([...LOGGED_ENTRIES, RUNNING.entry]).toEqual([...TODAY_ENTRIES]);
	expect(loggedToday + length(RUNNING.entry)).toBe(dayTotals[TODAY]);

	// The time on the running timer is less than the entry it becomes.
	const [hours = 0, minutes = 0] = RUNNING.elapsed.split(":").map(Number);
	expect(hours * 60 + minutes).toBeLessThan(length(RUNNING.entry));
});

it("the week's total is the sum of its rows and of its columns", () => {
	const byRow = week.reduce((total, row) => total + row.total, 0);
	const byColumn = dayTotals.reduce((total, each) => total + each, 0);
	expect(dayTotals).toHaveLength(DAYS.length);
	expect(byRow).toBe(weekTotal);
	expect(byColumn).toBe(weekTotal);
});

it("a length of time is written in hours and minutes", () => {
	expect(duration(0)).toBe("0:00");
	expect(duration(45)).toBe("0:45");
	expect(duration(150)).toBe("2:30");
	expect(duration(1935)).toBe("32:15");
});
