import { SIGNED_OUT } from "./auth-state";
import { expect, test } from "./fixtures";
import { afternoonZone, mondayOf, pastWeekday } from "./timesheet";

// The days the timesheet's specs track time on hold whatever day and hour the
// run is at: CI runs at any hour in UTC, and typed hours never run past now
// (W08), so today just after midnight has room for none. `pastWeekday` is read
// with the browser's clock held at each day of a week, just after its midnight
// and just before the next; `afternoonZone` at every hour of the week.

test.use({ storageState: SIGNED_OUT, timezoneId: "UTC" });

/** Monday 9 to Sunday 15 November 2026, and the weekday before each. */
const WEEK = [
	{ today: "2026-11-09", before: "2026-11-06" },
	{ today: "2026-11-10", before: "2026-11-09" },
	{ today: "2026-11-11", before: "2026-11-10" },
	{ today: "2026-11-12", before: "2026-11-11" },
	{ today: "2026-11-13", before: "2026-11-12" },
	{ today: "2026-11-14", before: "2026-11-13" },
	{ today: "2026-11-15", before: "2026-11-13" },
];

test("the past weekday is the latest Monday to Friday before today, at either end of each day of the week", async ({
	page,
}) => {
	for (const { today, before } of WEEK) {
		for (const time of ["00:05", "23:55"]) {
			await page.clock.setFixedTime(new Date(`${today}T${time}:00Z`));
			expect(await pastWeekday(page), `${today} at ${time}`).toBe(before);
		}
	}
});

test("a day's week starts on its Monday", () => {
	for (const { today } of WEEK) expect(mondayOf(today), today).toBe("2026-11-09");
	expect(mondayOf("2026-11-06")).toBe("2026-11-02");
});

test("the afternoon zone is in the afternoon of UTC's date at every hour of the week", () => {
	for (const { today } of WEEK) {
		for (let hour = 0; hour < 24; hour++) {
			for (const minute of [0, 59]) {
				const now = new Date(
					`${today}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
				);
				const zone = afternoonZone(now);
				const local = new Intl.DateTimeFormat("en-CA", {
					timeZone: zone,
					dateStyle: "short",
					timeStyle: "short",
					hourCycle: "h23",
				}).format(now);
				expect(local, `${now.toISOString()} in ${zone}`).toMatch(
					new RegExp(`^${today}, 1[2-5]:\\d\\d$`),
				);
			}
		}
	}
});
