import { describe, expect, it } from "vitest";
import { periodContaining } from "~/periods/periods";
import { type Day, daysFrom, exactInstantAt, instantAt } from "~/time/calendar";
import { cellText, formatDuration, formatElapsed, TypedHours } from "~/timesheet/durations";
import {
	historyRows,
	isTypable,
	periodState,
	type SheetEntry,
	totalOf,
	weekSheet,
} from "~/timesheet/sheets";
import { chosenView } from "~/timesheet/views.server";

// What the views of Timesheet add up and how they read an address (TS-013,
// TS-046, TS-052), without the database: the sums, the day an entry belongs to,
// a running entry counted to the time of the request, and the clock changes.

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

describe("the week's sheet", () => {
	const week = periodContaining("2026-11-11", 1);
	const days = daysFrom(week.startsOn, week.endsOn);

	it("for random sets of entries, each day's total is the sum of its cells, and the week's the sum of its days and of its projects", () => {
		for (let seed = 1; seed <= 200; seed++) {
			const next = generator(seed);
			const from = instantAt(week.startsOn, 0, LONDON);
			const now = from + 8 * 24 * HOUR;
			const entries = Array.from({ length: next(25) }, () => {
				const start = from + next(7 * 24 * 60) * MINUTE;
				const running = next(20) === 0;
				return entry(start, running ? null : start + next(600) * MINUTE, `p${next(4)}`);
			});
			const sheet = weekSheet(entries, days, LONDON, now);

			sheet.days.forEach(({ total }, index) => {
				expect(total).toBe(
					sheet.rows.reduce((sum, row) => sum + (row.cells[index]?.total ?? 0), 0),
				);
			});
			for (const row of sheet.rows) {
				expect(row.total).toBe(row.cells.reduce((sum, cell) => sum + cell.total, 0));
			}
			const byDays = sheet.days.reduce((sum, day) => sum + day.total, 0);
			const byProjects = sheet.rows.reduce((sum, row) => sum + row.total, 0);
			expect(sheet.total).toBe(byDays);
			expect(sheet.total).toBe(byProjects);
			expect(sheet.total).toBe(totalOf(entries, now));
		}
	});

	it("puts an entry whole in the local day it starts in: 23:30 to 00:30 in London counts under the first day", () => {
		const start = instantAt("2026-11-10", 23 * 60 + 30, LONDON);
		const sheet = weekSheet([entry(start, start + HOUR)], days, LONDON, start + 2 * HOUR);

		expect(sheet.days.find((d) => d.day === "2026-11-10")?.total).toBe(HOUR);
		expect(sheet.days.find((d) => d.day === "2026-11-11")?.total).toBe(0);
	});

	it("counts a running entry from its start to the time of the request", () => {
		const start = instantAt("2026-11-11", 9 * 60, LONDON);
		const sheet = weekSheet([entry(start, null)], days, LONDON, start + 90 * MINUTE);

		expect(sheet.total).toBe(90 * MINUTE);
		expect(sheet.rows[0]?.cells.find((c) => c.day === "2026-11-11")?.running).toBe(true);
	});

	it("puts the same entry on different days for a person in Auckland and one in London", () => {
		const start = Date.parse("2026-11-11T20:00:00Z");
		const one = [entry(start, start + HOUR)];
		const inLondon = weekSheet(one, days, LONDON, start + 2 * HOUR);
		const inAuckland = weekSheet(one, days, AUCKLAND, start + 2 * HOUR);

		expect(inLondon.days.find((d) => d.day === "2026-11-11")?.total).toBe(HOUR);
		expect(inAuckland.days.find((d) => d.day === "2026-11-12")?.total).toBe(HOUR);
	});

	it("in the London week of 2026-03-29, an entry at 00:30 on the Sunday is in Sunday's column, in a week of 23-hour Sunday", () => {
		const clockChange = periodContaining("2026-03-29", 1);
		const sunday = daysFrom(clockChange.startsOn, clockChange.endsOn);
		expect(sunday.at(-1)).toBe("2026-03-29");
		const start = Date.parse("2026-03-29T00:30:00Z");
		const sheet = weekSheet([entry(start, start + HOUR)], sunday, LONDON, start + 2 * HOUR);

		expect(sheet.days.at(-1)).toEqual({ day: "2026-03-29", total: HOUR, overtime: 0 });
		// The day after the period starts at 00:00 on 30 March, 23 hours after the Sunday began.
		expect(instantAt("2026-03-30", 0, LONDON) - instantAt("2026-03-29", 0, LONDON)).toBe(23 * HOUR);
	});

	it("lists a row for each project with time, in the order given, then each added row with empty cells", () => {
		const start = instantAt("2026-11-09", 9 * 60, LONDON);
		const sheet = weekSheet(
			[entry(start, start + HOUR, "b"), entry(start + 2 * HOUR, start + 3 * HOUR, "a")],
			days,
			LONDON,
			start + 4 * HOUR,
			{ projectOrder: ["a", "b", "c"], addedRows: ["c", "a"] },
		);

		expect(sheet.rows.map((row) => row.projectId)).toEqual(["a", "b", "c"]);
		expect(sheet.rows[2]?.cells.every((cell) => cell.total === 0 && cell.entries === 0)).toBe(true);
		expect(sheet.rows[2]?.total).toBe(0);
	});

	it("lets a cell of none or one ended entry, on a day not locked, take typed hours, and no other", () => {
		const start = instantAt("2026-11-09", 9 * 60, LONDON);
		const sheet = weekSheet(
			[
				entry(start, start + HOUR, "one"),
				entry(start, start + HOUR, "two"),
				entry(start + HOUR, start + 2 * HOUR, "two"),
				entry(start, null, "running"),
			],
			days,
			LONDON,
			start + 3 * HOUR,
		);
		const monday = (id: string) => {
			const cell = sheet.rows.find((r) => r.projectId === id)?.cells[0];
			if (!cell) throw new Error(`No Monday cell for ${id}.`);
			return cell;
		};

		expect(isTypable(monday("one"), false)).toBe(true);
		expect(monday("one").entryId).not.toBeNull();
		expect(isTypable(monday("one"), true)).toBe(false);
		expect(isTypable(monday("two"), false)).toBe(false);
		expect(monday("two").total).toBe(2 * HOUR);
		expect(isTypable(monday("running"), false)).toBe(false);
	});

	it("gives a project's overtime a row of its own after its regular time, and counts each day's overtime (TS-095)", () => {
		const start = instantAt("2026-11-09", 9 * 60, LONDON);
		const overtime = { ...entry(start + 8 * HOUR, start + 9 * HOUR, "a"), overtime: true };
		const sheet = weekSheet(
			[entry(start, start + 7 * HOUR, "a"), overtime, entry(start, start + HOUR, "b")],
			days,
			LONDON,
			start + 10 * HOUR,
			{ projectOrder: ["a", "b"] },
		);

		expect(sheet.rows.map((row) => [row.projectId, row.overtime])).toEqual([
			["a", false],
			["a", true],
			["b", false],
		]);
		expect(sheet.rows[1]?.cells[0]).toMatchObject({
			total: HOUR,
			entries: 1,
			entryId: overtime.id,
		});
		expect(sheet.days[0]).toEqual({ day: "2026-11-09", total: 9 * HOUR, overtime: HOUR });
		expect(sheet.total).toBe(9 * HOUR);
	});
});

describe("hours typed into a cell", () => {
	it.each([
		["1.5", 90],
		["1,5", 90],
		["1:30", 90],
		["2", 120],
		[" 0.25 ", 15],
		["24", 1440],
		["", 0],
	])("reads %j as %i minutes", (typed, minutes) => {
		expect(TypedHours.parse(typed)).toBe(minutes);
	});

	it.each(["abc", "-1", "25", "1:75", "24:01", "1.5h"])("refuses %j", (typed) => {
		expect(TypedHours.safeParse(typed).success).toBe(false);
	});

	it("shows a cell's time as hours and minutes, and nothing for none", () => {
		expect(cellText(90 * MINUTE)).toBe("1:30");
		expect(cellText(0)).toBe("");
	});
});

describe("durations", () => {
	it("are hours and minutes, the seconds dropped", () => {
		expect(formatDuration(7 * HOUR + 5 * MINUTE + 59_000)).toBe("7:05");
	});

	it("a running timer's are hours, minutes and seconds", () => {
		expect(formatElapsed(3723)).toBe("1:02:03");
	});
});

describe("History", () => {
	const current = periodContaining("2026-11-11", 1);
	const now = Date.parse("2026-11-11T12:00:00Z");

	it("lists each period back to the first with an entry, newest first, with its status and total", () => {
		const start = instantAt("2026-10-27", 9 * 60, LONDON);
		const rows = historyRows(
			current,
			[
				{ startsOn: "2026-10-26", endsOn: "2026-11-01", status: "approved", comment: null },
				{ startsOn: "2026-11-02", endsOn: "2026-11-08", status: "returned", comment: "Add Friday" },
			],
			[entry(start, start + 2 * HOUR)],
			LONDON,
			now,
		);

		expect(rows.map((row) => [row.startsOn, row.state, row.total, row.comment])).toEqual([
			["2026-11-09", "not-submitted", 0, null],
			["2026-11-02", "returned", 0, "Add Friday"],
			["2026-10-26", "approved", 2 * HOUR, null],
		]);
	});

	it("calls a withdrawn period not submitted", () => {
		expect(periodState("withdrawn")).toBe("not-submitted");
		expect(periodState(null)).toBe("not-submitted");
		expect(periodState("submitted")).toBe("submitted");
	});
});

describe("the address of a view", () => {
	const query = (text: string) => chosenView(new URLSearchParams(text), 1);

	it("is the Day view of today by default, or of a day", () => {
		expect(query("")).toEqual({ view: "day", day: null });
		expect(query("day=2026-11-11")).toEqual({ view: "day", day: "2026-11-11" });
	});

	it("is the Week view of this week, or of the week starting on a Monday", () => {
		expect(query("view=week")).toEqual({ view: "week", start: null });
		expect(query("view=week&start=2026-11-09")).toEqual({ view: "week", start: "2026-11-09" });
	});

	it.each([
		"day=2026-13-01",
		"day=tomorrow",
		"view=week&start=2026-11-11",
		"view=week&start=nope",
		"view=month",
		"view=history&day=2026-11-11",
		"colour=red",
	])("answers %j with 400", (text) => {
		let thrown: unknown;
		try {
			query(text);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({ init: { status: 400 } });
	});

	it("follows the organisation's week start", () => {
		expect(chosenView(new URLSearchParams("view=week&start=2026-11-08"), 7)).toEqual({
			view: "week",
			start: "2026-11-08" as Day,
		});
	});
});

describe("a day and a time typed by a person", () => {
	it("is read in their zone", () => {
		expect(exactInstantAt("2026-11-11", 9 * 60, LONDON)).toBe(Date.parse("2026-11-11T09:00:00Z"));
		expect(exactInstantAt("2026-07-01", 9 * 60, LONDON)).toBe(Date.parse("2026-07-01T08:00:00Z"));
	});

	it("is none in the hour a clock change skips", () => {
		expect(exactInstantAt("2026-03-29", 60 + 30, LONDON)).toBeNull();
		expect(exactInstantAt("2026-03-29", 2 * 60 + 30, LONDON)).toBe(
			Date.parse("2026-03-29T01:30:00Z"),
		);
	});
});
