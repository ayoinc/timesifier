import type { Request } from "@playwright/test";

import { BROWSER_ERROR_FIELDS, BROWSER_ERRORS_PATH } from "../app/browser-errors/report";
import { SIGNED_OUT } from "./auth-state";
import { problems } from "./axe";
import { expect, takenOver, test } from "./fixtures";
import { ownOrganisation } from "./organisation";

// What a page tells the application when it fails in the browser (TS-107d):
// each distinct error once, by its name and its route's pattern, and nothing a
// person typed, nothing of the page's address. And the footer's way to the
// status page (TS-107c).

/** Words that stand for what a person typed: in the error's message, the query and the fragment. */
const TYPED = "ada-typed-4f2a9c";

test.describe("an error in a page", () => {
	test.use({ thrown: [TYPED] });

	test("sends exactly one report per distinct error, of exactly its fields, holding neither the address nor the message", async ({
		page,
	}) => {
		const slug = await ownOrganisation(page);
		const reports: Request[] = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname === BROWSER_ERRORS_PATH) reports.push(request);
		});
		await page.goto(`/app/${slug}/expenses?search=${TYPED}#${TYPED}`);
		await takenOver(page);
		const address = page.url();

		// The same error twice, and a rejection nothing handles.
		await page.evaluate((typed) => {
			for (const _ of [1, 2]) {
				setTimeout(() => {
					throw new TypeError(typed);
				});
			}
			setTimeout(() => void Promise.reject(new RangeError(typed)));
		}, TYPED);

		await expect.poll(() => reports.length).toBe(2);
		// Nothing more arrives.
		await page.waitForTimeout(500);
		expect(reports).toHaveLength(2);

		const bodies = reports.map((request) => request.postDataJSON() as Record<string, unknown>);
		for (const body of bodies) {
			expect(Object.keys(body)).toEqual([...BROWSER_ERROR_FIELDS]);
			expect(body.route).toBe("/app/:organisation/expenses");
			expect(body.release).toMatch(/^[0-9a-f]{8}$/);
			expect(Date.parse(String(body.time))).not.toBeNaN();
			const values = JSON.stringify(body);
			for (const secret of [TYPED, slug, address, new URL(address).search, "localhost"]) {
				expect(values).not.toContain(secret);
			}
		}
		expect(bodies.map(({ kind, name }) => [kind, name])).toEqual([
			["error", "TypeError"],
			["rejection", "RangeError"],
		]);
		// Sent to the same origin, with no address of the page in the request.
		for (const request of reports) {
			expect(new URL(request.url()).origin).toBe(new URL(address).origin);
			expect(new URL(request.url()).search).toBe("");
		}
	});
});

test.describe("the footer", () => {
	test.use({ storageState: SIGNED_OUT });

	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 1280, height: 800 },
	]) {
		test(`links to the status page under Company, ${viewport.width}px wide`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.goto("/privacy");

			const company = page.getByRole("contentinfo").getByRole("navigation", { name: "Company" });
			await expect(company.getByRole("link", { name: "Status" })).toHaveAttribute(
				"href",
				// OUTSIDE_LINKS.status in app/landing/Site.tsx.
				"https://status.timesifier.com/",
			);
			expect(await problems(page)).toEqual([]);
		});
	}
});
