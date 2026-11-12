import { organisationPath } from "../app/shell/destinations";
import { expect, openShell, test } from "./fixtures";
import { homeOrganisation } from "./organisation";

// Every page writes a date one way, whatever the browser's language and zone
// (audit W06, W12; app/time/format.ts). The Timesheet is read here in a browser
// set to US English in California, whose own way would be "November 9 – 15,
// 2026" and "Wednesday, November 11". Its text must be the server's, so the page
// hydrates without React's error #418 ("text content does not match"). The
// fixtures already fail a test on any uncaught error; the 418 is checked by name
// as well, so a failure says what it is.

test.use({ locale: "en-US", timezoneId: "America/Los_Angeles" });

const WEEKDAY = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const MONTH =
	"(?:January|February|March|April|May|June|July|August|September|October|November|December)";
/** "9–15 November 2026", "30 November – 6 December 2026", "28 December 2026 – 3 January 2027". */
const RANGE = new RegExp(
	`^(?:\\d{1,2}–\\d{1,2} ${MONTH} \\d{4}|\\d{1,2} ${MONTH} – \\d{1,2} ${MONTH} \\d{4}|\\d{1,2} ${MONTH} \\d{4} – \\d{1,2} ${MONTH} \\d{4})$`,
);

test("the Timesheet hydrates with the server's dates in a browser of another locale and zone", async ({
	page,
}) => {
	const hydrationErrors: string[] = [];
	page.on("pageerror", (error) => {
		if (error.message.includes("418")) hydrationErrors.push(error.message);
	});
	const timesheet = organisationPath(homeOrganisation().slug);

	// The Day view: today's heading, and the week's days above it.
	await openShell(page, timesheet);
	const main = page.getByRole("main");
	await expect(
		main.getByText(new RegExp(`^Today, ${WEEKDAY} \\d{1,2} ${MONTH}$`)).first(),
	).toBeVisible();
	// Each day's short date: the first part of its link. A day off is marked after it (TS-061).
	const days = page
		.getByRole("group", { name: "Days of the week" })
		.locator('a > span:first-child > [aria-hidden="true"]');
	await expect(days).toHaveCount(7);
	for (const label of await days.allTextContents()) {
		expect(label).toMatch(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}$/);
	}

	// The Week view: its period.
	await openShell(page, `${timesheet}?view=week`);
	await expect(main.getByText(RANGE).first()).toBeVisible();
	await expect(main).not.toContainText(new RegExp(`${MONTH} \\d{1,2}(?:,| –)`));

	expect(hydrationErrors, "React error #418: the server's text and the browser's differ").toEqual(
		[],
	);
});
