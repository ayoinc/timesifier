import { describe, expect, it } from "vitest";

import {
	formatDay,
	formatDayAndTime,
	formatDayWithYear,
	formatDuration,
	formatMonth,
	formatRange,
	formatTime,
	formatTimeRange,
	LOCALE,
} from "../../app/time/format";

// The one way each kind of date is written (audit W06, W12). These run in the
// Workers runtime, the engine that writes the server's HTML; test/node/ checks
// that the same strings come out whatever the machine's own locale and zone.

const at = (iso: string) => Date.parse(iso);
const LONDON = "Europe/London";

describe("a day", () => {
	it("is written in full as weekday, day, month: no comma, the day before the month", () => {
		expect(formatDay("2026-11-11")).toBe("Wednesday 11 November");
		expect(formatDay("2026-11-11", "long")).toBe("Wednesday 11 November");
		expect(formatDay("2027-01-01")).toBe("Friday 1 January");
	});

	it("is written briefly as weekday then day, whatever order the engine's own pattern has", () => {
		expect(formatDay("2026-11-09", "short")).toBe("Mon 9");
		expect(formatDay("2026-11-15", "short")).toBe("Sun 15");
	});

	it("is the same day wherever it is read: a day has no time and no zone", () => {
		expect(formatDay("2026-03-29")).toBe("Sunday 29 March");
		expect(formatDay("2026-10-25")).toBe("Sunday 25 October");
	});

	it("carries its year where asked", () => {
		expect(formatDayWithYear("2026-11-11")).toBe("Wednesday 11 November 2026");
		expect(formatDayWithYear("2028-02-29")).toBe("Tuesday 29 February 2028");
	});
});

describe("a range of days", () => {
	it("names the month and year once inside a month, the dash closed up", () => {
		expect(formatRange("2026-11-09", "2026-11-15")).toBe("9–15 November 2026");
		expect(formatRange("2026-10-01", "2026-10-31")).toBe("1–31 October 2026");
	});

	it("names both months across a month, the dash spaced", () => {
		expect(formatRange("2026-11-30", "2026-12-06")).toBe("30 November – 6 December 2026");
	});

	it("names both years across a year", () => {
		expect(formatRange("2026-12-28", "2027-01-03")).toBe("28 December 2026 – 3 January 2027");
	});

	it("is a single date for one day", () => {
		expect(formatRange("2026-11-11", "2026-11-11")).toBe("11 November 2026");
	});
});

describe("a month", () => {
	it("is its name and year", () => {
		expect(formatMonth("2026-11-11")).toBe("November 2026");
		expect(formatMonth("2027-01-31")).toBe("January 2027");
	});
});

describe("a time of day", () => {
	it("is on the 24-hour clock with two digits each side", () => {
		expect(formatTime(at("2026-11-11T09:30:00Z"), LONDON)).toBe("09:30");
		expect(formatTime(at("2026-11-11T21:33:00Z"), LONDON)).toBe("21:33");
	});

	it("is on the clock of the zone it is asked for, not the machine's", () => {
		expect(formatTime(at("2026-11-11T09:30:00Z"), "Asia/Tokyo")).toBe("18:30");
		expect(formatTime(at("2026-11-11T09:30:00Z"), "America/New_York")).toBe("04:30");
		expect(formatTime(at("2026-11-11T09:30:00Z"), "Asia/Kolkata")).toBe("15:00");
	});

	it("is 00:00 at midnight, never 24:00", () => {
		expect(formatTime(at("2026-11-11T00:00:00Z"), LONDON)).toBe("00:00");
		expect(formatTime(at("2026-11-10T18:30:00Z"), "Asia/Kolkata")).toBe("00:00");
		expect(formatTime(at("2026-11-11T05:00:00Z"), "America/New_York")).toBe("00:00");
		expect(formatTime(at("2026-11-11T00:00:00Z"), "UTC")).toBe("00:00");
	});

	it("follows the clock change on the days it happens", () => {
		// London goes from 01:00 GMT to 02:00 BST on 29 March 2026.
		expect(formatTime(at("2026-03-29T00:59:00Z"), LONDON)).toBe("00:59");
		expect(formatTime(at("2026-03-29T01:00:00Z"), LONDON)).toBe("02:00");
		// And back from 02:00 BST to 01:00 GMT on 25 October 2026: 01:30 comes twice.
		expect(formatTime(at("2026-10-25T00:30:00Z"), LONDON)).toBe("01:30");
		expect(formatTime(at("2026-10-25T01:30:00Z"), LONDON)).toBe("01:30");
		// Santiago skips midnight itself on 6 September 2026.
		expect(formatTime(at("2026-09-06T04:00:00Z"), "America/Santiago")).toBe("01:00");
	});
});

describe("a stretch of time on the clock", () => {
	it("is a start and an end joined by a closed-up en dash", () => {
		expect(formatTimeRange(at("2026-11-11T21:33:00Z"), at("2026-11-12T02:33:00Z"), LONDON)).toBe(
			"21:33–02:33",
		);
	});

	it("ends at now while it runs", () => {
		expect(formatTimeRange(at("2026-11-11T21:33:00Z"), null, LONDON)).toBe("21:33–now");
	});

	it("crosses a clock change by the clock", () => {
		expect(formatTimeRange(at("2026-03-29T00:30:00Z"), at("2026-03-29T01:30:00Z"), LONDON)).toBe(
			"00:30–02:30",
		);
	});
});

describe("a moment", () => {
	it("is the day and the time on the zone's clock", () => {
		expect(formatDayAndTime(at("2026-11-11T09:30:00Z"), LONDON)).toBe(
			"Wednesday 11 November at 09:30",
		);
		// Late on the 10th in UTC is already the 11th in Tokyo.
		expect(formatDayAndTime(at("2026-11-10T22:00:00Z"), "Asia/Tokyo")).toBe(
			"Wednesday 11 November at 07:00",
		);
	});
});

describe("a length of time", () => {
	it("is hours and whole minutes, the seconds dropped", () => {
		expect(formatDuration(18_000)).toBe("5:00");
		expect(formatDuration(420)).toBe("0:07");
		expect(formatDuration(479)).toBe("0:07");
		expect(formatDuration(0)).toBe("0:00");
		expect(formatDuration(360_000)).toBe("100:00");
	});
});

it("takes its names from one fixed locale", () => {
	expect(LOCALE).toBe("en-GB");
});
