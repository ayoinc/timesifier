import { destinationPath, organisationPath } from "../app/shell/destinations";
import { newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// Approvals opens on a view that has an address (TS-094, audit W13): the latest
// week with something pending, else the current one, on its first status with
// somebody in it, written into the address bar so that a decision leaves the
// page where it is. Its weeks are stepped with the PeriodStepper (W23), whose
// arrows are 44px (W10). Each test is a person of their own, with an
// organisation of their own.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
]) {
	for (const colorScheme of ["light", "dark"] as const) {
		test.describe(`in a window ${viewport.width}px wide, in the ${colorScheme} scheme`, () => {
			test.use({ viewport, chosenScheme: colorScheme });

			test("opens on this week with its view in the address, and steps weeks with the keyboard", async ({
				page,
			}) => {
				await signIn(page, newPerson().email);
				const { slug } = await createOrganisation(page);
				await openShell(page, organisationPath(slug));
				const here = destinationPath(slug, "approvals");
				await openShell(page, here);

				// Nothing is pending anywhere: this week, on Pending, in the address.
				await expect(page).toHaveURL(
					new RegExp(`${here}\\?week=\\d{4}-\\d\\d-\\d\\d&status=pending$`),
				);
				const weeks = page.getByRole("group", { name: "Weeks" });
				const previous = weeks.getByRole("link", { name: "Previous week" });
				const box = await previous.boundingBox();
				expect(box?.width).toBeGreaterThanOrEqual(44);
				expect(box?.height).toBeGreaterThanOrEqual(44);
				expect(await problems(page)).toEqual([]);

				const thisWeek = new URL(page.url()).searchParams.get("week");
				await previous.focus();
				await page.keyboard.press("Enter");
				await expect(weeks.getByRole("link", { name: "This week" })).toBeVisible();
				await weeks.getByRole("link", { name: "Next week" }).focus();
				await page.keyboard.press("Enter");
				await expect(page).toHaveURL(new RegExp(`week=${thisWeek}`));
			});
		});
	}
}
