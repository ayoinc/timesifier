import { describe, expect, it } from "vitest";
import { GROUPS } from "~/reports/choices";
import {
	BYTE_ORDER_MARK,
	CSV_COLUMNS,
	csvCell,
	csvFilename,
	csvLine,
	isoInstant,
	pieceCells,
} from "~/reports/csv";
import { dayLabel, hoursAndMinutes, rangeLabel } from "~/reports/format";
import { parseReportQuery, type ReportDays, rangeDays } from "~/reports/query";
import { type Piece, piecesOf, type ReportEntry, totalsOf } from "~/reports/report";
import { bounds } from "~/time/calendar";
import { parseCsv } from "./csv";

// The arithmetic of a report (TS-014a) and of its export (TS-014b), without the
// database: the range an address asks for, an entry cut at each local midnight
// and clipped to the range, a running entry counted to now, the totals by
// project, client and day, and the cells of the CSV.

const SECOND = 1000;
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
		...more,
	};
}

const query = (fields: Record<string, string>) => parseReportQuery(new URLSearchParams(fields));

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
		["a custom range without its last day", { range: "custom", from: "2026-10-01" }],
		[
			"a custom range that runs backwards",
			{ range: "custom", from: "2026-10-02", to: "2026-10-01" },
		],
		["a day that is not a date", { range: "custom", from: "2026-02-30", to: "2026-03-01" }],
		[
			"a custom range longer than a year",
			{ range: "custom", from: "2025-01-01", to: "2026-01-02" },
		],
	])("is none for %s", (_, fields) => {
		expect(query(fields)).toBeNull();
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

describe("an entry in a report", () => {
	const week: ReportDays = { first: "2026-11-02", last: "2026-11-08" };

	it("is one piece when it starts and ends on one day", () => {
		const pieces = piecesOf(entry("2026-11-03T09:00:00Z", "2026-11-03T10:30:00Z"), week, "UTC", 0);
		expect(pieces.map(({ day, seconds }) => [day, seconds])).toEqual([["2026-11-03", 5400]]);
	});

	it("is cut at local midnight: 23:30 to 00:30 is half an hour on each day", () => {
		const pieces = piecesOf(entry("2026-11-03T23:30:00Z", "2026-11-04T00:30:00Z"), week, LONDON, 0);
		expect(pieces.map(({ day, seconds }) => [day, seconds])).toEqual([
			["2026-11-03", 1800],
			["2026-11-04", 1800],
		]);
	});

	it("is cut at the midnight of the organisation's zone, not of UTC", () => {
		// 22:00 to 02:00 UTC is 09:00 to 13:00 in Auckland (UTC+13): one day there.
		const pieces = piecesOf(
			entry("2026-11-03T20:00:00Z", "2026-11-04T00:00:00Z"),
			week,
			"Pacific/Auckland",
			0,
		);
		expect(pieces.map(({ day, seconds }) => [day, seconds])).toEqual([["2026-11-04", 4 * 3600]]);
	});

	it("keeps only what falls in the range", () => {
		const range: ReportDays = { first: "2026-11-04", last: "2026-11-04" };
		const pieces = piecesOf(entry("2026-11-03T22:00:00Z", "2026-11-05T02:00:00Z"), range, "UTC", 0);
		expect(pieces.map(({ day, seconds }) => [day, seconds])).toEqual([["2026-11-04", 24 * 3600]]);
	});

	it("has no pieces when it is outside the range", () => {
		expect(piecesOf(entry("2026-11-10T09:00:00Z", "2026-11-10T10:00:00Z"), week, "UTC", 0)).toEqual(
			[],
		);
		expect(piecesOf(entry("2026-11-01T09:00:00Z", "2026-11-02T00:00:00Z"), week, "UTC", 0)).toEqual(
			[],
		);
	});

	it("counts a day of 25 hours when the clocks go back", () => {
		const range: ReportDays = { first: "2026-10-25", last: "2026-10-25" };
		const { from, to } = bounds(range.first, range.last, LONDON);
		const pieces = piecesOf(entry(from - HOUR, to + HOUR), range, LONDON, 0);
		expect(pieces.map(({ seconds }) => seconds)).toEqual([25 * 3600]);
	});

	it("counts a running entry up to now, and says the piece is running", () => {
		const now = Date.parse("2026-11-05T01:15:00Z");
		const pieces = piecesOf(entry("2026-11-04T23:00:00Z", null), week, "UTC", now);
		expect(pieces.map(({ day, seconds, running }) => [day, seconds, running])).toEqual([
			["2026-11-04", 3600, false],
			["2026-11-05", 4500, true],
		]);
	});

	it("counts a running entry that started after the range only where it falls", () => {
		const now = Date.parse("2026-11-12T10:00:00Z");
		const pieces = piecesOf(entry("2026-11-08T22:00:00Z", null), week, "UTC", now);
		expect(pieces.map(({ day, seconds, running }) => [day, seconds, running])).toEqual([
			["2026-11-08", 7200, false],
		]);
	});

	it("is one piece of no length, on its day, when it has no length", () => {
		const pieces = piecesOf(entry("2026-11-02T00:00:00Z", "2026-11-02T00:00:00Z"), week, "UTC", 0);
		expect(pieces.map(({ day, seconds }) => [day, seconds])).toEqual([["2026-11-02", 0]]);
	});

	it("counts whole seconds, so its pieces add up to it", () => {
		const pieces = piecesOf(
			entry(Date.parse("2026-11-03T23:59:59.900Z"), Date.parse("2026-11-04T00:00:01.100Z")),
			week,
			"UTC",
			0,
		);
		expect(pieces.map(({ seconds }) => seconds)).toEqual([1, 1]);
	});
});

describe("the totals of a report", () => {
	const week: ReportDays = { first: "2026-11-02", last: "2026-11-08" };
	const pieces = [
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
	].flatMap((each) => piecesOf(each, week, "UTC", 0));

	it("by project, in the order of the names", () => {
		expect(totalsOf(pieces, "project")).toEqual({
			groups: [
				{ key: "p3", label: "app", seconds: 1800 },
				{ key: "p2", label: "Billing", seconds: 3600 },
				{ key: "p1", label: "Site", seconds: 7200 },
			],
			seconds: 12_600,
		});
	});

	it("by client, the time with no client last", () => {
		expect(totalsOf(pieces, "client").groups).toEqual([
			{ key: "c2", label: "acme", seconds: 1800 },
			{ key: "c1", label: "Initech", seconds: 7200 },
			{ key: "", label: null, seconds: 3600 },
		]);
	});

	it("by day, an entry across midnight on both days", () => {
		expect(totalsOf(pieces, "day").groups).toEqual([
			{ key: "2026-11-02", label: "2026-11-02", seconds: 7200 },
			{ key: "2026-11-03", label: "2026-11-03", seconds: 5400 },
		]);
	});

	it("are nothing when nothing was tracked", () => {
		expect(totalsOf([], "project")).toEqual({ groups: [], seconds: 0 });
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

describe("a property of every report", () => {
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
		"seed %i: each grouping's totals add up to the total, which is the time of the entries in the range",
		(seed) => {
			const next = random(seed);
			const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
			const zone = pick(ZONES);
			const { from, to } = bounds(RANGE.first, RANGE.last, zone);
			const now = from + Math.floor(next() * (to - from + 10 * 24 * HOUR));
			const entries = Array.from({ length: 1 + Math.floor(next() * 40) }, () => {
				// Starting up to three days either side of the range, for up to three days.
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

			const pieces: Piece[] = entries.flatMap((each) => piecesOf(each, RANGE, zone, now));
			// The time of the entries in the range, worked out another way: the overlap of each with it.
			const expected = entries.reduce((sum, each) => {
				const end = Math.floor((each.endedAt ?? Math.max(now, each.startedAt)) / SECOND);
				const overlap =
					Math.min(end, Math.floor(to / SECOND)) -
					Math.max(Math.floor(each.startedAt / SECOND), Math.floor(from / SECOND));
				return sum + Math.max(0, overlap);
			}, 0);

			for (const grouping of GROUPS) {
				const totals = totalsOf(pieces, grouping);
				expect(totals.groups.reduce((sum, group) => sum + group.seconds, 0)).toBe(totals.seconds);
				expect(totals.seconds).toBe(expected);
			}
			for (const piece of pieces) {
				expect(piece.start).toBeGreaterThanOrEqual(Math.floor(from / SECOND) * SECOND);
				expect(piece.end).toBeLessThanOrEqual(to);
				expect(piece.seconds).toBeGreaterThanOrEqual(0);
				const day = bounds(piece.day, piece.day, zone);
				expect(piece.start).toBeGreaterThanOrEqual(Math.floor(day.from / SECOND) * SECOND);
				expect(piece.end).toBeLessThanOrEqual(day.to);
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
			"entry_id,person,project,client,description,started_at,ended_at,duration_seconds\r\n",
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

	it("is a piece: times in UTC to the second, its length in seconds", () => {
		const [first, second] = piecesOf(
			entry("2026-11-03T23:30:00.400Z", "2026-11-04T00:30:00Z", { id: "e1", description: "=1+1" }),
			week,
			"UTC",
			0,
		);
		if (!first || !second) throw new Error("two pieces expected");
		expect(pieceCells(first, true)).toEqual([
			"e1",
			"Ada",
			"Site",
			"Initech",
			"=1+1",
			"2026-11-03T23:30:00Z",
			"2026-11-04T00:00:00Z",
			"1800",
		]);
		expect(pieceCells(second, false)).toEqual([
			"e1",
			"Ada",
			"Site",
			"",
			"=1+1",
			"2026-11-04T00:00:00Z",
			"2026-11-04T00:30:00Z",
			"1800",
		]);
		expect(csvLine(pieceCells(first, true))).toContain(",'=1+1,");
	});

	it("has no end while its entry runs", () => {
		const now = Date.parse("2026-11-04T10:00:00Z");
		const [piece] = piecesOf(
			entry("2026-11-04T09:00:00Z", null, { description: null, clientId: null, client: null }),
			week,
			"UTC",
			now,
		);
		if (!piece) throw new Error("a piece expected");
		expect(pieceCells(piece, true).slice(3)).toEqual(["", "", "2026-11-04T09:00:00Z", "", "3600"]);
	});

	it("is in a file named for the organisation and the range", () => {
		expect(csvFilename("acme", "2026-11-02", "2026-11-08")).toBe(
			"timesifier-acme-2026-11-02-to-2026-11-08.csv",
		);
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
		expect(dayLabel("2026-11-02")).toBe("Mon 2 Nov");
		// ICU puts a thin or a plain space round the dash, by its version.
		expect(rangeLabel("2026-11-02", "2026-11-08")).toMatch(/^2\s?–\s?8 November 2026$/);
		expect(rangeLabel("2026-11-02", "2026-11-02")).toBe("2 November 2026");
	});
});
