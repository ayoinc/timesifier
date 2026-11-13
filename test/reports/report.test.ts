import { describe, expect, it } from "vitest";
import { GROUPS, type Range } from "~/reports/choices";
import {
	BYTE_ORDER_MARK,
	CSV_COLUMNS,
	csvCell,
	csvLine,
	isoInstant,
	rowCells,
} from "~/reports/csv";
import { dayLabel, hoursAndMinutes, rangeLabel } from "~/reports/format";
import {
	parseReportQuery,
	RANGE_MESSAGES,
	type ReportDays,
	rangeDays,
	reportSearch,
	type SteppedRange,
	steppedRange,
} from "~/reports/query";
import { type ReportEntry, type Row, rowOf, totalsOf } from "~/reports/report";
import { bounds } from "~/time/calendar";
import { parseCsv } from "./csv";

// The arithmetic of a report (TS-014a) and of its export (TS-014b), without the
// database: the range an address asks for, an entry counted whole on the day it
// starts in the viewer's zone (decision 26, TS-091), a running entry counted to
// now, the totals by project, client and day in whole minutes, and the cells of
// the CSV.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const LONDON = "Europe/London";

let ids = 0;
function entry(
	startedAt: string | number,
	endedAt: string | number | null,
	more: Partial<ReportEntry> = {},
): ReportEntry {
	ids += 1;
	return {
		id: `e${String(ids).padStart(4, "0")}`,
		userId: "u1",
		person: "Ada",
		projectId: "p1",
		project: "Site",
		clientId: "c1",
		client: "Initech",
		description: "Work",
		startedAt: typeof startedAt === "number" ? startedAt : Date.parse(startedAt),
		endedAt: endedAt === null ? null : typeof endedAt === "number" ? endedAt : Date.parse(endedAt),
		taskId: null,
		task: null,
		billable: false,
		overtime: false,
		...more,
	};
}

const parse = (fields: Record<string, string>) => parseReportQuery(new URLSearchParams(fields));
/** The query an address asks for, or null when it makes no report. */
const query = (fields: Record<string, string>) => {
	const parsed = parse(fields);
	return parsed && !parsed.problem ? parsed.query : null;
};

describe("the report an address asks for", () => {
	it("is this week by project for everyone the viewer may see when the address says nothing", () => {
		expect(query({})).toEqual({ range: "this-week", group: "project" });
	});

	it("takes the empty fields a form sends as fields not given, and 'everyone' as no person", () => {
		expect(query({ range: "", group: "", person: "everyone", from: "", to: "" })).toEqual({
			range: "this-week",
			group: "project",
		});
	});

	it("takes a custom range with both its days, and a person", () => {
		expect(
			query({ range: "custom", from: "2026-10-01", to: "2026-10-31", group: "day", person: "u2" }),
		).toEqual({
			range: "custom",
			from: "2026-10-01",
			to: "2026-10-31",
			group: "day",
			person: "u2",
		});
	});

	it.each([
		["a range that is not one", { range: "forever" }],
		["a grouping that is not one", { group: "colour" }],
		["a week named by a day that is not a date", { range: "week", from: "2026-02-30" }],
	])("is none for %s, which the form never writes", (_, fields) => {
		expect(parse(fields)).toBeNull();
	});

	it.each([
		[
			"without its last day",
			{ range: "custom", from: "2026-10-01" },
			{ field: "to", message: RANGE_MESSAGES.notADate },
		],
		[
			"with a first day that is not a date",
			{ range: "custom", from: "2026-02-30", to: "2026-03-01" },
			{ field: "from", message: "Enter a date like 2026-11-09" },
		],
		[
			"that runs backwards",
			{ range: "custom", from: "2026-10-02", to: "2026-10-01" },
			{ field: "to", message: "Must be on or after the first day" },
		],
		[
			"longer than a year",
			{ range: "custom", from: "2025-01-01", to: "2026-01-02" },
			{ field: "to", message: "At most 366 days" },
		],
	])("keeps a custom range %s as typed, with the problem under its field", (_, fields, problem) => {
		const parsed = parse(fields);
		expect(parsed?.problem).toEqual(problem);
		const typed: Record<string, string> = fields;
		expect([parsed?.query.from, parsed?.query.to]).toEqual([typed.from, typed.to]);
	});

	it("takes a custom range of a whole leap year", () => {
		expect(query({ range: "custom", from: "2028-01-01", to: "2028-12-31" })).not.toBeNull();
	});
});

describe("the days of a range", () => {
	const days = (fields: Record<string, string>, today: string, weekStartsOn = 1) => {
		const parsed = query(fields);
		if (!parsed) throw new Error("not a report");
		return rangeDays(parsed, today, weekStartsOn);
	};

	it("this week and last week start on the organisation's first day of the week", () => {
		// Wednesday 11 November 2026.
		expect(days({ range: "this-week" }, "2026-11-11")).toEqual({
			first: "2026-11-09",
			last: "2026-11-15",
		});
		expect(days({ range: "last-week" }, "2026-11-11")).toEqual({
			first: "2026-11-02",
			last: "2026-11-08",
		});
		expect(days({ range: "this-week" }, "2026-11-11", 7)).toEqual({
			first: "2026-11-08",
			last: "2026-11-14",
		});
	});

	it("this month is the calendar month, whatever its length", () => {
		expect(days({ range: "this-month" }, "2026-11-11")).toEqual({
			first: "2026-11-01",
			last: "2026-11-30",
		});
		expect(days({ range: "this-month" }, "2028-02-29")).toEqual({
			first: "2028-02-01",
			last: "2028-02-29",
		});
		expect(days({ range: "this-month" }, "2026-12-31")).toEqual({
			first: "2026-12-01",
			last: "2026-12-31",
		});
	});

	it("a custom range is its two days", () => {
		expect(days({ range: "custom", from: "2026-10-05", to: "2026-10-07" }, "2026-11-11")).toEqual({
			first: "2026-10-05",
			last: "2026-10-07",
		});
	});
});

describe("a range stepped by Previous and Next (TS-059)", () => {
	it("moves a week by a week, and names it by its first day", () => {
		const week = { first: "2026-11-09", last: "2026-11-15" };
		expect(steppedRange("this-week", week, -1)).toEqual({
			range: "week",
			days: { first: "2026-11-02", last: "2026-11-08" },
		});
		expect(steppedRange("last-week", week, 1)).toEqual({
			range: "week",
			days: { first: "2026-11-16", last: "2026-11-22" },
		});
		// Across the end of a year.
		expect(steppedRange("week", { first: "2026-12-28", last: "2027-01-03" }, 1).days).toEqual({
			first: "2027-01-04",
			last: "2027-01-10",
		});
	});

	it("moves a month by a calendar month, whatever the number of its days", () => {
		// A month that ends on the 31st, to one of 30 days and back.
		const october = { first: "2026-10-01", last: "2026-10-31" };
		expect(steppedRange("month", october, 1)).toEqual({
			range: "month",
			days: { first: "2026-11-01", last: "2026-11-30" },
		});
		expect(steppedRange("month", { first: "2026-11-01", last: "2026-11-30" }, -1).days).toEqual(
			october,
		);
		// January, which ends on the 31st, to February of a leap year and of a common one.
		expect(steppedRange("month", { first: "2028-01-01", last: "2028-01-31" }, 1).days).toEqual({
			first: "2028-02-01",
			last: "2028-02-29",
		});
		expect(
			steppedRange("this-month", { first: "2027-03-01", last: "2027-03-31" }, -1).days,
		).toEqual({ first: "2027-02-01", last: "2027-02-28" });
		// Across the end of a year, both ways.
		expect(steppedRange("month", { first: "2026-12-01", last: "2026-12-31" }, 1).days).toEqual({
			first: "2027-01-01",
			last: "2027-01-31",
		});
		expect(steppedRange("month", { first: "2027-01-01", last: "2027-01-31" }, -1).days).toEqual({
			first: "2026-12-01",
			last: "2026-12-31",
		});
	});

	it("moves a custom range by its number of days", () => {
		expect(steppedRange("custom", { first: "2026-10-05", last: "2026-10-14" }, 1)).toEqual({
			range: "custom",
			days: { first: "2026-10-15", last: "2026-10-24" },
		});
		expect(steppedRange("custom", { first: "2026-10-05", last: "2026-10-14" }, -1).days).toEqual({
			first: "2026-09-25",
			last: "2026-10-04",
		});
		// One day, across the end of a month of 31.
		expect(steppedRange("custom", { first: "2026-10-31", last: "2026-10-31" }, 1).days).toEqual({
			first: "2026-11-01",
			last: "2026-11-01",
		});
	});

	it("comes back to the range it left, a step each way, from any range", () => {
		const starts: [Range, ReportDays][] = [
			["week", { first: "2026-02-23", last: "2026-03-01" }],
			["month", { first: "2026-01-01", last: "2026-01-31" }],
			["month", { first: "2024-02-01", last: "2024-02-29" }],
			["custom", { first: "2026-03-29", last: "2026-04-02" }],
		];
		for (const [range, days] of starts) {
			for (const step of [-1, 1] as const) {
				const there = steppedRange(range, days, step);
				expect(steppedRange(there.range, there.days, step === 1 ? -1 : 1).days).toEqual(days);
			}
		}
	});

	it("is an address that reads back as the range it names", () => {
		const back = (stepped: SteppedRange) => {
			const parsed = query(Object.fromEntries(reportSearch({ ...stepped, group: "project" })));
			if (!parsed) throw new Error("not a report");
			return rangeDays(parsed, "2026-11-11", 1);
		};
		const week = steppedRange("this-week", { first: "2026-11-09", last: "2026-11-15" }, -1);
		expect(back(week)).toEqual(week.days);
		const month = steppedRange("this-month", { first: "2026-10-01", last: "2026-10-31" }, 1);
		expect(back(month)).toEqual(month.days);
		const custom = steppedRange("custom", { first: "2026-10-05", last: "2026-10-14" }, 1);
		expect(back(custom)).toEqual(custom.days);
	});

	it("takes a week or a month named by any of its days as the whole of it", () => {
		const parsed = (fields: Record<string, string>) => {
			const each = query(fields);
			if (!each) throw new Error("not a report");
			return rangeDays(each, "2026-11-11", 1);
		};
		expect(parsed({ range: "week", from: "2026-11-12" })).toEqual({
			first: "2026-11-09",
			last: "2026-11-15",
		});
		expect(parsed({ range: "month", from: "2026-10-31" })).toEqual({
			first: "2026-10-01",
			last: "2026-10-31",
		});
		// With no day, the one holding today.
		expect(parsed({ range: "month" })).toEqual({ first: "2026-11-01", last: "2026-11-30" });
	});
});

describe("an entry in a report", () => {
	const week: ReportDays = { first: "2026-11-02", last: "2026-11-08" };
	const counted = (row: Row | null) => row && [row.day, row.minutes, row.running];

	it("is counted on the day it starts, for its whole minutes", () => {
		expect(
			counted(rowOf(entry("2026-11-03T09:00:00Z", "2026-11-03T10:30:59Z"), week, "UTC", 0)),
		).toEqual(["2026-11-03", 90, false]);
	});

	it("21:33 to 02:33 counts whole on its start day, never cut at midnight", () => {
		const row = rowOf(entry("2026-11-03T21:33:00Z", "2026-11-04T02:33:00Z"), week, LONDON, 0);
		expect(counted(row)).toEqual(["2026-11-03", 300, false]);
	});

	it("belongs to the day it starts in the viewer's zone, not in UTC", () => {
		// 20:00 UTC on the 3rd is 09:00 on the 4th in Auckland (UTC+13).
		const row = rowOf(
			entry("2026-11-03T20:00:00Z", "2026-11-04T00:00:00Z"),
			week,
			"Pacific/Auckland",
			0,
		);
		expect(counted(row)).toEqual(["2026-11-04", 240, false]);
	});

	it("is in the range when it starts in it, whole, even when it ends after", () => {
		const day: ReportDays = { first: "2026-11-08", last: "2026-11-08" };
		expect(
			counted(rowOf(entry("2026-11-08T22:00:00Z", "2026-11-09T02:00:00Z"), day, "UTC", 0)),
		).toEqual(["2026-11-08", 240, false]);
	});

	it("is not in the range when it starts outside it, even when it ends in it", () => {
		expect(rowOf(entry("2026-11-10T09:00:00Z", "2026-11-10T10:00:00Z"), week, "UTC", 0)).toBeNull();
		expect(rowOf(entry("2026-11-01T22:00:00Z", "2026-11-02T02:00:00Z"), week, "UTC", 0)).toBeNull();
	});

	it("counts a running entry whole up to now, and says it runs", () => {
		const now = Date.parse("2026-11-05T01:15:30Z");
		expect(counted(rowOf(entry("2026-11-04T23:00:00Z", null), week, "UTC", now))).toEqual([
			"2026-11-04",
			135,
			true,
		]);
	});

	it("is no time when it has no length", () => {
		expect(
			counted(rowOf(entry("2026-11-02T00:00:00Z", "2026-11-02T00:00:00Z"), week, "UTC", 0)),
		).toEqual(["2026-11-02", 0, false]);
	});
});

describe("the totals of a report", () => {
	const week: ReportDays = { first: "2026-11-02", last: "2026-11-08" };
	const rows = [
		entry("2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z", {
			projectId: "p2",
			project: "Billing",
			clientId: null,
			client: null,
		}),
		entry("2026-11-02T23:00:00Z", "2026-11-03T01:00:00Z"),
		entry("2026-11-03T09:00:00Z", "2026-11-03T09:30:00Z", {
			projectId: "p3",
			project: "app",
			clientId: "c2",
			client: "acme",
		}),
	].flatMap((each) => rowOf(each, week, "UTC", 0) ?? []);

	it("by project, in the order of the names", () => {
		expect(totalsOf(rows, "project")).toEqual({
			groups: [
				{ key: "p3", label: "app", minutes: 30, overtimeMinutes: 0 },
				{ key: "p2", label: "Billing", minutes: 60, overtimeMinutes: 0 },
				{ key: "p1", label: "Site", minutes: 120, overtimeMinutes: 0 },
			],
			minutes: 210,
			overtimeMinutes: 0,
		});
	});

	it("by client, the time with no client last", () => {
		expect(totalsOf(rows, "client").groups).toEqual([
			{ key: "c2", label: "acme", minutes: 30, overtimeMinutes: 0 },
			{ key: "c1", label: "Initech", minutes: 120, overtimeMinutes: 0 },
			{ key: "", label: null, minutes: 60, overtimeMinutes: 0 },
		]);
	});

	it("by day, an entry across midnight whole on the day it starts", () => {
		expect(totalsOf(rows, "day").groups).toEqual([
			{ key: "2026-11-02", label: "2026-11-02", minutes: 180, overtimeMinutes: 0 },
			{ key: "2026-11-03", label: "2026-11-03", minutes: 30, overtimeMinutes: 0 },
		]);
	});

	it("hold the overtime of each group and of all apart, within its time (TS-095)", () => {
		const mixed = [
			rowOf(entry("2026-11-02T09:00:00Z", "2026-11-02T16:30:00Z"), week, "UTC", 0),
			rowOf(
				entry("2026-11-02T16:30:00Z", "2026-11-02T17:45:00Z", { overtime: true }),
				week,
				"UTC",
				0,
			),
			rowOf(
				entry("2026-11-03T09:00:00Z", "2026-11-03T09:30:00Z", {
					projectId: "p2",
					project: "Billing",
					overtime: true,
				}),
				week,
				"UTC",
				0,
			),
		].flatMap((row) => (row ? [row] : []));
		expect(totalsOf(mixed, "project")).toEqual({
			groups: [
				{ key: "p2", label: "Billing", minutes: 30, overtimeMinutes: 30 },
				{ key: "p1", label: "Site", minutes: 525, overtimeMinutes: 75 },
			],
			minutes: 555,
			overtimeMinutes: 105,
		});
		const [, second] = mixed;
		if (!second) throw new Error("a row expected");
		expect(rowCells(second, true).at(-1)).toBe("yes");
	});

	it("are nothing when nothing was tracked", () => {
		expect(totalsOf([], "project")).toEqual({ groups: [], minutes: 0, overtimeMinutes: 0 });
	});
});

/** A small, seeded generator (mulberry32), so a failing case can be run again. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

describe("a property of every report (W07)", () => {
	const ZONES = [
		"UTC",
		LONDON,
		"America/New_York",
		"Pacific/Auckland",
		"Asia/Kolkata",
		"Australia/Lord_Howe",
	];
	const RANGE: ReportDays = { first: "2026-10-20", last: "2026-11-05" };

	it.each(Array.from({ length: 60 }, (_, seed) => seed))(
		"seed %i: every total, as written, is the sum of its rows as written, in every grouping and in Entries",
		(seed) => {
			const next = random(seed);
			const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
			const zone = pick(ZONES);
			const { from, to } = bounds(RANGE.first, RANGE.last, zone);
			const now = from + Math.floor(next() * (to - from + 10 * 24 * HOUR));
			const entries = Array.from({ length: 1 + Math.floor(next() * 40) }, () => {
				// Starting up to three days either side of the range, for up to three days, to the millisecond.
				const startedAt = from - 3 * 24 * HOUR + Math.floor(next() * (to - from + 6 * 24 * HOUR));
				const running = next() < 0.1;
				const project = pick(["p1", "p2", "p3", "p4"]);
				const client = pick(["c1", "c2", null]);
				return entry(startedAt, running ? null : startedAt + Math.floor(next() * 3 * 24 * HOUR), {
					projectId: project,
					project: project.toUpperCase(),
					clientId: client,
					client: client?.toUpperCase() ?? null,
				});
			});

			const rows = entries.flatMap((each) => rowOf(each, RANGE, zone, now) ?? []);
			// Read back what the page writes: "H:MM" to minutes.
			const read = (written: string) => {
				const [hours, minutes] = written.split(":").map(Number) as [number, number];
				return hours * 60 + minutes;
			};
			const written = (minutes: number) => read(hoursAndMinutes(minutes * 60));

			// The entries that start in the range, and only they, each whole.
			const starting = entries.filter((each) => each.startedAt >= from && each.startedAt < to);
			expect(rows.map((row) => row.entry.id).sort()).toEqual(
				starting.map((each) => each.id).sort(),
			);
			const entriesTotal = rows.reduce((sum, row) => sum + written(row.minutes), 0);

			for (const grouping of GROUPS) {
				const totals = totalsOf(rows, grouping);
				const shown = totals.groups.reduce((sum, group) => sum + written(group.minutes), 0);
				expect(shown).toBe(written(totals.minutes));
				expect(entriesTotal).toBe(written(totals.minutes));
			}
			for (const row of rows) {
				const end = row.entry.endedAt ?? Math.max(now, row.entry.startedAt);
				expect(row.minutes).toBe(Math.floor((end - row.entry.startedAt) / MINUTE));
				const day = bounds(row.day, row.day, zone);
				expect(row.start).toBeGreaterThanOrEqual(day.from);
				expect(row.start).toBeLessThan(day.to);
			}
		},
	);
});

describe("a cell of the CSV", () => {
	it.each([
		['=HYPERLINK("http://x")', '"\'=HYPERLINK(""http://x"")"'],
		["+1+1", "'+1+1"],
		["-2", "'-2"],
		["@SUM(A1)", "'@SUM(A1)"],
		["\tcmd", "'\tcmd"],
		["\rcmd", '"\'\rcmd"'],
	])("cannot start a formula: %j is written %j", (value, written) => {
		expect(csvCell(value)).toBe(written);
	});

	it.each([
		["plain", "plain"],
		["a, b", '"a, b"'],
		['say "hi"', '"say ""hi"""'],
		["two\nlines", '"two\nlines"'],
		["Zoë’s café", "Zoë’s café"],
		["", ""],
	])("%j is written %j", (value, written) => {
		expect(csvCell(value)).toBe(written);
	});

	it("ends each line with CRLF", () => {
		expect(csvLine(["a", "b"])).toBe("a,b\r\n");
		expect(csvLine(CSV_COLUMNS)).toBe(
			"entry_id,person,project,client,description,started_at,ended_at,duration_seconds,overtime\r\n",
		);
	});

	it("starts the file with the byte order mark Excel reads UTF-8 by", () => {
		expect([...new TextEncoder().encode(BYTE_ORDER_MARK)]).toEqual([0xef, 0xbb, 0xbf]);
	});
});

describe("a property of every export", () => {
	/** What a description may hold that a CSV must take care over, and some that it need not. */
	const PARTS = [
		",",
		'"',
		"\n",
		"\r",
		"\r\n",
		"=",
		"+",
		"-",
		"@",
		"\t",
		"'",
		" ",
		"a",
		"Z",
		"é",
		"日",
		"😀",
		"1",
	];

	it.each(Array.from({ length: 100 }, (_, seed) => seed))(
		"seed %i: every row parses back, by RFC 4180, to the values written, a formula's start defused",
		(seed) => {
			const next = random(1000 + seed);
			const text = () =>
				Array.from(
					{ length: Math.floor(next() * 12) },
					() => PARTS[Math.floor(next() * PARTS.length)],
				).join("");
			const rows = Array.from({ length: 1 + Math.floor(next() * 5) }, () => [
				text(),
				text(),
				text(),
			]);
			const file = rows.map(csvLine).join("");

			const defused = (value: string) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
			expect(parseCsv(file)).toEqual(rows.map((row) => row.map(defused)));
		},
	);
});

describe("a row of the CSV", () => {
	const week: ReportDays = { first: "2026-11-02", last: "2026-11-08" };

	it("is one entry, across midnight too: times in UTC to the second, its whole minutes in seconds", () => {
		const row = rowOf(
			entry("2026-11-03T23:30:00.400Z", "2026-11-04T00:30:59Z", { id: "e1", description: "=1+1" }),
			week,
			"UTC",
			0,
		);
		if (!row) throw new Error("a row expected");
		expect(rowCells(row, true)).toEqual([
			"e1",
			"Ada",
			"Site",
			"Initech",
			"=1+1",
			"2026-11-03T23:30:00Z",
			"2026-11-04T00:30:59Z",
			"3600",
			"no",
		]);
		expect(rowCells(row, false)[3]).toBe("");
		expect(csvLine(rowCells(row, true))).toContain(",'=1+1,");
	});

	it("has no end while its entry runs", () => {
		const now = Date.parse("2026-11-04T10:00:00Z");
		const row = rowOf(
			entry("2026-11-04T09:00:00Z", null, { description: null, clientId: null, client: null }),
			week,
			"UTC",
			now,
		);
		if (!row) throw new Error("a row expected");
		expect(rowCells(row, true).slice(3)).toEqual([
			"",
			"",
			"2026-11-04T09:00:00Z",
			"",
			"3600",
			"no",
		]);
	});

	it("writes an instant to the second, in UTC", () => {
		expect(isoInstant(Date.parse("2026-11-02T09:00:00.999Z"))).toBe("2026-11-02T09:00:00Z");
	});
});

describe("the words of a report", () => {
	it("writes lengths as hours and minutes, the seconds dropped", () => {
		expect([0, 59, 60, 5400, 36_000 + 59 * 60 + 59, 100 * 3600].map(hoursAndMinutes)).toEqual([
			"0:00",
			"0:00",
			"0:01",
			"1:30",
			"10:59",
			"100:00",
		]);
	});

	it("names days and ranges", () => {
		expect(dayLabel("2026-11-02")).toBe("Monday 2 November");
		expect(rangeLabel("2026-11-02", "2026-11-08")).toBe("2–8 November 2026");
		expect(rangeLabel("2026-11-02", "2026-11-02")).toBe("2 November 2026");
	});
});
