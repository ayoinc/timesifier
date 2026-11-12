import type { Browser, Locator, Page } from "@playwright/test";

import { destinationPath, invitationsPath, organisationPath } from "../app/shell/destinations";
import { foundInMessageSentBy, newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, EMPTY_INPUT, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { destinationLinks, expect, openShell, test } from "./fixtures";
import { createOrganisation, INVITATION_LINK } from "./organisation";
import { createProject } from "./timesheet";

// Time off in a browser (TS-061): a member asks for leave and records sick
// leave, the keyboard alone doing the second; the owner approves the first
// from the Requests tab, which the Approvals link counts; and the person is
// shown as on leave on Team > This week and on their own Timesheet. Then every
// page and sheet of it at both window sizes and in both schemes, with no WCAG
// 2.2 A or AA violation. Each test is new people with an organisation of their
// own: what they add is seen by no other test, and nothing is seeded. Leave
// that needs notice is asked for well ahead of it (TS-090): short notice has
// its own spec, `leave-rules.spec.ts`.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** The local date `offset` days from today in UTC. A run of three around it holds everybody's today. */
function dayFromToday(offset: number): string {
	const at = new Date();
	at.setUTCDate(at.getUTCDate() + offset);
	return at.toISOString().slice(0, 10);
}

const navigation = (page: Page) => page.getByRole("navigation", { name: "Main" });
const requestSheet = (page: Page) => page.getByRole("dialog", { name: "Request time off" });

/** Fills in "Request time off" and sends it; returns once the page has said what became of it. */
async function requestLeave(page: Page, kind: string, first: string, last: string, said: string) {
	await page.getByRole("button", { name: "Request time off" }).click();
	const sheet = requestSheet(page);
	await sheet.getByRole("button", { name: /Kind of leave/ }).click();
	await page
		.getByRole("listbox", { name: "Kind of leave" })
		.getByRole("option", { name: kind })
		.click();
	await sheet.getByRole("textbox", { name: "First day" }).fill(first);
	await sheet.getByRole("textbox", { name: "Last day" }).fill(last);
	await sheet.getByRole("button", { name: "Request" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toHaveText(said);
}

/** Ada owns a new organisation; Bob, in a browser of his own, joins it as a member. */
async function adaAndBob(page: Page, browser: Browser, baseURL: string | undefined) {
	const bob = newPerson();
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await createProject(page, slug, "Site");

	// Every day of the week is a working day here, so today is one, whatever day the test runs.
	await openShell(page, destinationPath(slug, "settings"));
	await page.getByRole("button", { name: "Change working week" }).click();
	const week = page.getByRole("dialog", { name: "Change the working week" });
	await week.getByLabel("Saturday").fill("7.5");
	await week.getByLabel("Sunday").fill("7:30");
	await week.getByRole("button", { name: "Save" }).click();
	await expect(week).toBeHidden();
	await expect(page.getByRole("status")).toHaveText("The working week is saved.");
	await expect(page.getByRole("list", { name: "Working week" })).toContainText("Sunday7:30");

	await openShell(page, invitationsPath(slug));
	await page.getByRole("button", { name: "Invite a person" }).click();
	const inviting = page.getByRole("dialog", { name: "Invite a person" });
	await inviting.getByLabel("Email address").fill(bob.email);
	const link = await foundInMessageSentBy(
		() => inviting.getByRole("button", { name: "Send invitation" }).click(),
		INVITATION_LINK,
		"the invitation's link",
	);
	await expect(inviting).toBeHidden();

	const bobs = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(bobs, baseURL);
	const other = await bobs.newPage();
	await other.goto(link);
	await signIn(other, bob.email, other.url());
	await other.getByRole("button", { name: "Join" }).click();
	await expect(other).toHaveURL(organisationPath(slug));
	return { slug, bob, other };
}

test("a member asks for leave and records sick leave; the owner approves; both see who is on leave", async ({
	page,
	browser,
	baseURL,
}) => {
	const { slug, bob, other } = await adaAndBob(page, browser, baseURL);

	// Bob asks for two days of annual leave, ten days from now.
	await openShell(other, destinationPath(slug, "time-off"));
	await expect(other.getByRole("heading", { level: 1, name: "Time off" })).toBeVisible();
	await expect(other.getByRole("list", { name: /Your balance/ })).toContainText("25 days left");
	await requestLeave(
		other,
		"Annual leave",
		dayFromToday(30),
		dayFromToday(31),
		"Requested. It waits for a manager's approval.",
	);
	const mine = other.getByRole("list", { name: "Your requests" });
	await expect(mine).toContainText("Annual leave · Waiting for approval");
	await expect(mine).toContainText("2 days");
	// Waiting days are taken from the balance at once.
	await expect(other.getByRole("list", { name: /Your balance/ })).toContainText("23 days left");
	// A member has no Requests tab: nobody's leave is theirs to decide.
	await expect(other.getByRole("link", { name: /^Requests/ })).toHaveCount(0);

	// He asks for study leave too, thinks again, and withdraws it while it waits.
	await requestLeave(
		other,
		"Study leave",
		dayFromToday(40),
		dayFromToday(42),
		"Requested. It waits for a manager's approval.",
	);
	await mine.getByRole("button", { name: /^Withdraw Study leave/ }).click();
	const withdrawing = other.getByRole("dialog", { name: /^Withdraw your request/ });
	await withdrawing.getByRole("button", { name: "Withdraw" }).click();
	await expect(withdrawing).toBeHidden();
	await expect(other.getByRole("status")).toHaveText("Request withdrawn.");
	await expect(mine).toContainText("Study leave · Withdrawn");

	// He records sick leave over today with the keyboard alone. It needs nobody's approval.
	const button = other.getByRole("button", { name: "Request time off" });
	await button.focus();
	await other.keyboard.press("Enter");
	const sheet = requestSheet(other);
	const kind = sheet.getByRole("button", { name: /Kind of leave/ });
	await kind.focus();
	await other.keyboard.press("Enter");
	const kinds = other.getByRole("listbox", { name: "Kind of leave" });
	await expect(kinds).toBeVisible();
	await other.keyboard.type("Si");
	await expect(kinds.getByRole("option", { name: "Sick leave" })).toBeFocused();
	await other.keyboard.press("Enter");
	await expect(kind).toContainText("Sick leave");
	await sheet.getByRole("textbox", { name: "First day" }).fill(dayFromToday(-1));
	await sheet.getByRole("textbox", { name: "Last day" }).fill(dayFromToday(1));
	const note = sheet.getByLabel("Note (optional)");
	await note.focus();
	await other.keyboard.type("Flu");
	await other.keyboard.press("Enter");
	await expect(sheet).toBeHidden();
	await expect(other.getByRole("status")).toHaveText("Recorded. It needs nobody's approval.");
	await expect(mine).toContainText("Sick leave · Approved");

	// Ada sees one request waiting on the Approvals link, and in the Requests tab of Time off.
	await openShell(page, destinationPath(slug, "time-off"));
	await expect(navigation(page).getByRole("link", { name: "Approvals 1 pending" })).toBeVisible();
	// Eight destinations and a count still fit the bar of a phone, each whole.
	await page.setViewportSize({ width: 390, height: 844 });
	for (const link of await destinationLinks(page).all()) {
		await expect(link).toBeInViewport({ ratio: 1 });
	}
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.getByRole("link", { name: "Requests (1)" }).click();
	const waiting = page.getByRole("list", { name: "Requests waiting for you" });
	await expect(waiting).toContainText(`${bob.email} · Annual leave`);
	await waiting.getByRole("button", { name: /^Approve / }).click();
	const approving = page.getByRole("dialog", { name: /^Approve / });
	await approving.getByLabel("Comment (optional)").fill("Enjoy it");
	await approving.getByRole("button", { name: "Approve" }).click();
	await expect(approving).toBeHidden();
	await expect(page.getByRole("status")).toHaveText("Leave approved.");
	await expect(page.getByText("No request is waiting for you.")).toBeVisible();
	await expect(page.getByRole("list", { name: "Approved leave to come" })).toContainText(
		"Annual leave",
	);
	await expect(
		navigation(page).getByRole("link", { name: "Approvals", exact: true }),
	).toBeVisible();

	// Bob reads the decision.
	await other.reload();
	await expect(mine).toContainText("Annual leave · Approved");
	await expect(mine).toContainText("“Enjoy it”");

	// On Team > This week, Ada sees that Bob is on sick leave today, and the time expected of him.
	await openShell(page, destinationPath(slug, "team"));
	const people = page.getByRole("list", { name: "People" });
	await expect(people).toContainText("On leave · Sick leave");
	await expect(people).toContainText(/logged\d+:\d\d expected/);

	// Bob's own Timesheet says so on the day and in the week's strip.
	await openShell(other, organisationPath(slug));
	await expect(other.getByRole("main")).toContainText("Sick leave. 0:00 expected.");
	await expect(
		other.getByRole("group", { name: "Days of the week" }).locator('a[aria-current="date"]'),
	).toContainText("Sick leave");
	// A whole day of leave takes no time (TS-090): Track time is closed, and says why.
	const track = other.getByRole("button", { name: "Track time" });
	await expect(track).toBeDisabled();
	await expect(track).toHaveAccessibleDescription(
		"You are on sick leave that day: no time can be tracked on it.",
	);
	await other.context().close();
});

test("an owner whom nobody else can decide for is told so, and their leave is approved as it is sent", async ({
	page,
}) => {
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);
	await openShell(page, destinationPath(slug, "time-off"));
	await page.getByRole("button", { name: "Request time off" }).click();
	await expect(requestSheet(page)).toContainText(
		"Nobody else here can decide your leave, so leave that needs approval is approved as soon as you send it.",
	);
	await page.keyboard.press("Escape");
	await requestLeave(
		page,
		"Study leave",
		dayFromToday(40),
		dayFromToday(46),
		"Approved automatically: nobody else can decide it.",
	);
	const mine = page.getByRole("list", { name: "Your requests" });
	await expect(mine).toContainText("Study leave · Approved");
	await expect(mine).toContainText("“Approved automatically: nobody else can decide it”");
	await expect(mine.getByRole("button", { name: /^Withdraw/ })).toHaveCount(0);
});

/** `unmeasurable`: what axe may leave unmeasured, such as an empty field. */
async function expectNoProblems(page: Page, heading: string, unmeasurable: string[] = []) {
	await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
	expect(await problems(page, unmeasurable), `problems in "${heading}"`).toEqual([]);
}

async function expectNoProblemsInSheet(page: Page, sheet: Locator, text: Locator) {
	await expect(sheet).toBeVisible();
	expect(
		await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS, EMPTY_INPUT]),
		"problems with the sheet open",
	).toEqual([]);
	expect(await contrast(text), "contrast of the sheet's text").toBeGreaterThanOrEqual(4.5);
	await page.keyboard.press("Escape");
	await expect(sheet).toBeHidden();
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("Time off, its sheet, and leave on the Timesheet, Team and My account", async ({
				page,
			}) => {
				await signIn(page, newPerson().email);
				const { slug } = await createOrganisation(page);
				await openShell(page, destinationPath(slug, "time-off"));
				await expectNoProblems(page, "Time off");

				await page.getByRole("button", { name: "Request time off" }).click();
				const sheet = requestSheet(page);
				await expectNoProblemsInSheet(page, sheet, sheet.getByText("Half a day", { exact: true }));

				await requestLeave(
					page,
					"Sick leave",
					dayFromToday(-1),
					dayFromToday(1),
					"Recorded. It needs nobody's approval.",
				);
				await requestLeave(
					page,
					"Annual leave",
					dayFromToday(30),
					dayFromToday(36),
					"Approved automatically: nobody else can decide it.",
				);
				await expectNoProblems(page, "Time off", [EMPTY_INPUT]);
				await page.getByRole("link", { name: /^Requests/ }).click();
				await expect(page.getByText("No request is waiting for you.")).toBeVisible();
				await expectNoProblems(page, "Time off");

				await openShell(page, organisationPath(slug));
				await expectNoProblems(page, "Timesheet");

				await openShell(page, destinationPath(slug, "team"));
				await expectNoProblems(page, "Team", [EMPTY_INPUT]);

				await openShell(page, `${organisationPath(slug)}/account`);
				await expect(page.getByRole("list", { name: "Your working week" })).toContainText(
					"Monday7:30",
				);
				await expectNoProblems(page, "My account");
			});
		});
	}
}
