import { SIGNED_OUT } from "./auth-state";
import { expect, test } from "./fixtures";

// Every link on the public pages leads somewhere. A link is followed the way a
// browser would follow it: the page it names must answer, and a place on a page
// must be an element that is there and says something.

test.use({ storageState: SIGNED_OUT });

const PAGES = ["/", "/privacy", "/terms"] as const;

for (const path of PAGES) {
	test(`every link on ${path} leads to a page or a place that exists`, async ({
		page,
		context,
		baseURL,
	}) => {
		await page.goto(path);
		const links = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((link) => ({
				href: link.href,
				words: (link.textContent ?? "").trim(),
			})),
		);
		expect(links.length).toBeGreaterThan(3);

		const followed = new Map<string, string>();
		for (const { href, words } of links) {
			// A link says where it goes.
			expect(words, href).not.toBe("");
			followed.set(href, words);
		}

		for (const [href, words] of followed) {
			const address = new URL(href);
			if (address.protocol === "mailto:") {
				// Mail goes to an address at our own domain.
				expect(address.pathname, words).toMatch(/^[a-z.-]+@timesifier\.com$/);
				continue;
			}

			// Everything else is a page of our own.
			expect(address.origin, words).toBe(baseURL);
			const response = await context.request.get(address.pathname + address.search, {
				maxRedirects: 0,
			});
			expect(response.status(), `${words} (${href})`).toBe(200);
			expect(response.headers()["content-type"], words).toContain("text/html");

			if (address.hash === "") continue;
			const target = address.pathname === path ? page : await context.newPage();
			if (target !== page) await target.goto(address.pathname);
			const place = target.locator(`[id="${decodeURIComponent(address.hash.slice(1))}"]`);
			await expect(place, `${words} (${href})`).toHaveCount(1);
			expect(
				((await place.textContent()) ?? "").trim().length,
				`${words} (${href})`,
			).toBeGreaterThan(0);
			if (target !== page) await target.close();
		}
	});
}

test("the home page is reached from the name at the top of each notice", async ({ page }) => {
	for (const path of ["/privacy", "/terms"]) {
		await page.goto(path);
		await page.getByRole("banner").getByRole("link", { name: "Timesifier" }).click();
		await expect(page).toHaveURL("/");
	}
});
