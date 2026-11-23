import { execFileSync } from "node:child_process";

import { destinationPath } from "../app/shell/destinations";
import { ARRIVAL, newPerson, ownAddress, signIn, TIME_WITH_TURNS } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation } from "./organisation";

// The data processing agreement (TS-105, docs/decisions.md entry 60), a journey
// of the organisations' (e2e/organisations-journeys.spec.ts). Creating an
// organisation accepts it; an organisation that holds an older version, or
// none, is asked once, in Workspace settings, of its owners, and nothing waits
// on it. Such an organisation is made by writing to the database, so this file
// is one of those that run after every other, one test at a time
// (playwright.config.ts).

test.describe("the data processing agreement", () => {
	test.use({ storageState: SIGNED_OUT });
	test.describe.configure({ timeout: 2 * TIME_WITH_TURNS });

	test.beforeEach(async ({ context, baseURL }) => {
		await ownAddress(context, baseURL);
	});

	test("is accepted by creating an organisation; one that has not accepted it asks its owner once, in Settings, and blocks nothing", async ({
		page,
	}) => {
		await signIn(page, newPerson().email);

		// Creating one says what it accepts, with both documents a link away.
		await expect(page).toHaveURL(ARRIVAL);
		const main = page.getByRole("main");
		await expect(main).toContainText(
			"By creating it you accept the terms and the data processing agreement for it.",
		);
		await expect(main.getByRole("link", { name: "terms", exact: true })).toHaveAttribute(
			"href",
			"/terms",
		);
		await expect(
			main.getByRole("link", { name: "data processing agreement", exact: true }),
		).toHaveAttribute("href", "/dpa");
		const { name, slug } = await createOrganisation(page);
		const settings = destinationPath(slug, "settings");
		const ask = page.getByRole("region", { name: "Accept the data processing agreement" });

		// Accepted at creation: nothing is asked.
		await openShell(page, settings);
		await expect(page.getByRole("heading", { level: 2, name: "General" })).toBeVisible();
		await expect(ask).toHaveCount(0);

		// An organisation made before the agreement holds no version.
		forgetAcceptance(slug);
		for (const viewport of [
			{ width: 390, height: 844 },
			{ width: 1280, height: 800 },
		]) {
			await page.setViewportSize(viewport);
			await openShell(page, settings);
			await expect(ask, `${viewport.width}px`).toBeVisible();
			await expect(ask.getByRole("link", { name: "data processing agreement" })).toHaveAttribute(
				"href",
				"/dpa",
			);
			await expect(ask).toContainText(`processes the personal data in ${name} for it`);
			expect(await problems(page), `${viewport.width}px`).toEqual([]);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
				`${viewport.width}px`,
			).toBeLessThanOrEqual(0);
		}

		// Nothing waits on it: the rest of Settings, and the Timesheet, work as before.
		await expect(page.getByRole("button", { name: "Rename" })).toBeEnabled();
		await page.getByRole("navigation").getByRole("link", { name: "Timesheet" }).click();
		await expect(page.getByRole("heading", { level: 1, name: "Timesheet" })).toBeFocused();
		await expect(ask).toHaveCount(0);

		// Accepting it, with the keyboard: the page says so, and the ask is gone for good.
		await openShell(page, settings);
		const accept = ask.getByRole("button", { name: "Accept the agreement" });
		await accept.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("status")).toHaveText(
			`The data processing agreement is accepted for ${name}.`,
		);
		await expect(ask).toHaveCount(0);
		await page.reload();
		await expect(page.getByRole("heading", { level: 2, name: "General" })).toBeVisible();
		await expect(ask).toHaveCount(0);
		expect(acceptedVersion(slug)).not.toBeNull();
	});
});

/**
 * Runs SQL against the database the test server uses. A write while the
 * server writes finds it locked, so a refused one is tried again.
 */
function sql(command: string): string {
	for (let attempt = 1; ; attempt++) {
		try {
			return execFileSync(
				"pnpm",
				["exec", "wrangler", "d1", "execute", "DB", "--local", "--json", "--command", command],
				{ encoding: "utf8", stdio: "pipe" },
			);
		} catch (error) {
			if (attempt === 5) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
		}
	}
}

/** Makes the organisation one created before the agreement: it holds no version of it. */
function forgetAcceptance(slug: string) {
	sql(
		`update organisations set dpa_version = null, dpa_accepted_at = null, dpa_accepted_by = null where slug = '${slug}'`,
	);
}

/** The version of the agreement the organisation holds, as the database has it. */
function acceptedVersion(slug: string): string | null {
	const out = sql(`select dpa_version from organisations where slug = '${slug}'`);
	const [result] = JSON.parse(out.slice(out.indexOf("["))) as {
		results: { dpa_version: string | null }[];
	}[];
	return result?.results[0]?.dpa_version ?? null;
}
