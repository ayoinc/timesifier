import { expect, it } from "vitest";
import {
	DAYS,
	dayTotals,
	duration,
	LOGGED_ENTRIES,
	length,
	loggedToday,
	PROJECTS,
	RHYTHM,
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

it("the day is worked in stretches: equal lengths, a short break between them, a longer one after every fourth", () => {
	for (const [index, entry] of TODAY_ENTRIES.entries()) {
		expect(length(entry), entry.note).toBe(RHYTHM.stretch);
		const next = TODAY_ENTRIES[index + 1];
		if (!next) continue;
		const pause = next.start - entry.end;
		if ((index + 1) % RHYTHM.stretchesToLongBreak === 0) {
			expect(pause, entry.note).toBeGreaterThanOrEqual(RHYTHM.longBreak);
		} else {
			expect(pause, entry.note).toBe(RHYTHM.shortBreak);
		}
	}
	// No two stretches of the day have the same note: a row is told from the next.
	expect(new Set(TODAY_ENTRIES.map((entry) => entry.note)).size).toBe(TODAY_ENTRIES.length);
});

it("the picture of the day stands just after the first longer break: four stretches finished, the fifth running", () => {
	expect(LOGGED_ENTRIES).toHaveLength(RHYTHM.stretchesToLongBreak);
	expect(RUNNING.entry).toBe(TODAY_ENTRIES[LOGGED_ENTRIES.length]);
	expect(TODAY_ENTRIES.slice(0, LOGGED_ENTRIES.length)).toEqual([...LOGGED_ENTRIES]);
	expect(RUNNING.entry.start - (LOGGED_ENTRIES.at(-1)?.end ?? 0)).toBe(RHYTHM.longBreak);
	expect(loggedToday).toBe(LOGGED_ENTRIES.length * RHYTHM.stretch);

	// The time on the running timer is less than the entry it becomes.
	expect(RUNNING.elapsedSeconds).toBeLessThan(length(RUNNING.entry) * 60);
	// By the end of the day the entries are the day's column in the week.
	expect(TODAY_ENTRIES.map(length).reduce((total, each) => total + each, 0)).toBe(dayTotals[TODAY]);
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
	expect(duration(1945)).toBe("32:25");
});
