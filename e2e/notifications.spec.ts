import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";

import { KIND_WORDS } from "../app/notifications/kinds";
import { notificationChoicesPath } from "../app/notifications/paths";
import { destinationPath, invitationsPath, organisationPath } from "../app/shell/destinations";
import { foundInMessageSentBy, newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { contrast, OVER_SEVERAL_ELEMENTS, problems, UNDER_AN_OVERLAY } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation, INVITATION_LINK } from "./organisation";

// The bell and My account › Notifications in a browser (TS-049). Bob, a
// member, asks for leave; Ada, the owner and so the one who decides it (D6),
// finds it in the bell beside her profile menu, with its count. Opening the
// bell with the keyboard marks everything read and the count goes to 0; the
// item, reached with Tab, leads to Approvals; the list's "Email settings" leads
// to My account › Notifications, where a kind's email is turned off with the
// keyboard and stays off. The band stays 80px tall with the bell in it
// (TS-123). At both window sizes in both schemes, with no WCAG 2.2 A or AA
// violation. Nothing is seeded: every notification is made through the pages,
// so the spec is not among those that write to the database from outside.
// The screenshots go where the card's review reads them.

const SHOTS =
	process.env.SHOT_DIR ??
	"/Users/ayodele.ajayi/Workspace/Personal/cmux-assets/browser/timesifier/TS-049";

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS * 2 });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

/** The local date `offset` days from today in UTC: far enough ahead, it is everybody's future. */
function dayFromToday(offset: number): string {
	const at = new Date();
	at.setUTCDate(at.getUTCDate() + offset);
	return at.toISOString().slice(0, 10);
}

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator, most = 40) {
	for (let step = 0; step < most; step++) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press("Tab");
	}
	throw new Error("Tab never reached the control.");
}

/** Ada owns a new organisation; Bob, in a browser of his own, joins it as a member. */
async function adaAndBob(page: Page, browser: Browser, baseURL: string | undefined) {
	const bob = newPerson();
	await signIn(page, newPerson().email);
	const { slug } = await createOrganisation(page);

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

/**
 * Bob asks for a week of annual leave, a month ahead. A new organisation works
 * Monday to Friday and has no public holidays (they are added one at a time in
 * Settings), so any seven days hold five working days, whatever day the test
 * runs. Two days were enough on most days, but on a Thursday they were a
 * Saturday and a Sunday, which hold no working day to take, and the sheet
 * refused them.
 */
async function requestLeave(other: Page, slug: string) {
	await openShell(other, destinationPath(slug, "time-off"));
	await other.getByRole("button", { name: "Request time off" }).click();
	const sheet = other.getByRole("dialog", { name: "Request time off" });
	await sheet.getByRole("button", { name: /Kind of leave/ }).click();
	await other
		.getByRole("listbox", { name: "Kind of leave" })
		.getByRole("option", { name: "Annual leave" })
		.click();
	await sheet.getByRole("textbox", { name: "First day" }).fill(dayFromToday(30));
	await sheet.getByRole("textbox", { name: "Last day" }).fill(dayFromToday(36));
	await sheet.getByRole("button", { name: "Request" }).click();
	await expect(sheet).toBeHidden();
	await expect(other.getByRole("status")).toHaveText(
		"Requested. It waits for a manager's approval.",
	);
	// The week took five working days: the organisation works Monday to Friday
	// and no public holiday fell in it.
	const mine = other.getByRole("list", { name: "Your requests" });
	await expect(mine).toContainText("Annual leave · Waiting for approval");
	await expect(mine).toContainText("5 days");
}

/** The band at the top of every page of an organisation. */
const band = (page: Page) => page.getByRole("banner");

/** The band's height, which the bell must not change (TS-123). */
async function bandHeight(page: Page): Promise<number | undefined> {
	return (await band(page).boundingBox())?.height;
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		const at = `${viewport.width}-${colorScheme}`;

		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("the bell counts what waits, opening it reads everything, and an item leads to its page", async ({
				page,
				browser,
				baseURL,
			}) => {
				mkdirSync(SHOTS, { recursive: true });
				const { slug, bob, other } = await adaAndBob(page, browser, baseURL);
				await requestLeave(other, slug);

				// Ada's band: the bell, beside the profile menu, says one is unread; the band is 80px.
				await openShell(page, organisationPath(slug));
				const bell = band(page).getByRole("button", { name: "1 unread notification" });
				await expect(bell).toBeVisible();
				await expect(bell).toHaveText("1");
				expect(await bandHeight(page)).toBe(80);
				const box = await bell.boundingBox();
				expect(box?.width).toBe(40);
				expect(box?.height).toBe(40);
				expect(await problems(page)).toEqual([]);
				await band(page).screenshot({ path: join(SHOTS, `band-${at}.png`) });

				// Opened with the keyboard: the list as it stood, every one now read, the count gone.
				await bell.focus();
				await page.keyboard.press("Enter");
				const list = page.getByRole("dialog", { name: "Notifications" });
				const item = list.getByRole("link", {
					name: new RegExp(`^Unread: ${bob.email} asked for Annual leave: `),
				});
				await expect(item).toBeVisible();
				const read = band(page).getByRole("button", { name: "Notifications", exact: true });
				await expect(read).toBeVisible();
				await expect(read).toHaveText("");
				expect(await bandHeight(page)).toBe(80);
				// Whole in the window, at either size.
				await expect(list).toBeInViewport({ ratio: 1 });
				// The item's words lie over the list and the page behind it: axe cannot
				// measure them, so they are measured here.
				expect(await problems(page, [UNDER_AN_OVERLAY, OVER_SEVERAL_ELEMENTS])).toEqual([]);
				expect(
					await contrast(item.getByText(new RegExp(`${bob.email} asked for`))),
				).toBeGreaterThanOrEqual(4.5);
				await page.screenshot({ path: join(SHOTS, `list-${at}.png`) });

				// Escape closes it and gives the focus back to the bell.
				await page.keyboard.press("Escape");
				await expect(list).toBeHidden();
				await expect(read).toBeFocused();

				// Read again from the server, it stays read.
				await openShell(page, organisationPath(slug));
				await expect(read).toBeVisible();
				await read.focus();
				await page.keyboard.press("Enter");
				const sameItem = list.getByRole("link", {
					name: new RegExp(`^${bob.email} asked for Annual leave: `),
				});
				await expect(sameItem).toBeVisible();

				// The item, reached with Tab, leads to Approvals; its heading takes the focus.
				await tabTo(page, sameItem);
				await page.keyboard.press("Enter");
				await expect(list).toBeHidden();
				await expect(page).toHaveURL(new RegExp(`${destinationPath(slug, "approvals")}(\\?|$)`));
				await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeFocused();

				// Its "Email settings" leads to My account › Notifications.
				await read.focus();
				await page.keyboard.press("Enter");
				const settings = list.getByRole("link", { name: "Email settings" });
				await tabTo(page, settings);
				await page.keyboard.press("Enter");
				await expect(list).toBeHidden();
				await expect(page).toHaveURL(new RegExp(`${notificationChoicesPath(slug)}$`));
				const section = page.getByRole("region", { name: "Notifications" });
				// The section arrives in view below the band, its rule above the heading not under it.
				const heading = section.getByRole("heading", { level: 2, name: "Notifications" });
				await expect(heading).toBeInViewport({ ratio: 1 });
				expect((await section.boundingBox())?.y).toBeGreaterThanOrEqual(80);
				// The scan waits for the page's transition to end, so the picture is of the page arrived at.
				expect(await problems(page)).toEqual([]);
				await page.screenshot({ path: join(SHOTS, `account-arrival-${at}.png`) });

				// An owner may be told of everything; each kind's email is on until turned off.
				const waiting = section.getByRole("switch", { name: KIND_WORDS["request-waiting"].label });
				await expect(waiting).toBeChecked();
				await expect(
					section.getByRole("switch", { name: KIND_WORDS["approvals-reminder"].label }),
				).toBeVisible();
				await tabTo(page, waiting);
				await page.keyboard.press("Space");
				await expect(page.getByRole("status").first()).toHaveText(
					`You will no longer get an email for “${KIND_WORDS["request-waiting"].label}”. It still shows in the bell.`,
				);
				await expect(waiting).not.toBeChecked();
				expect(await problems(page)).toEqual([]);
				await page.screenshot({ path: join(SHOTS, `account-${at}.png`) });
				await openShell(page, notificationChoicesPath(slug));
				await expect(waiting).not.toBeChecked();

				// Bob, a member, is offered only what can reach him: nothing waits for him to decide.
				await openShell(other, notificationChoicesPath(slug));
				const his = other.getByRole("region", { name: "Notifications" });
				await expect(
					his.getByRole("switch", { name: KIND_WORDS["week-decided"].label }),
				).toBeVisible();
				await expect(
					his.getByRole("switch", { name: KIND_WORDS["request-waiting"].label }),
				).toHaveCount(0);
				await expect(
					band(other).getByRole("button", { name: "Notifications", exact: true }),
				).toBeVisible();
				expect(await bandHeight(other)).toBe(80);
				await other.context().close();
			});
		});
	}
}
