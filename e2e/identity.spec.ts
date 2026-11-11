import type { Page } from "@playwright/test";

import { SIGNED_OUT } from "./auth-state";
import { expect, test } from "./fixtures";

// The product's mark: beside its name at the top and the foot of the public
// pages, as the icon of every page, and on the picture a shared link is shown
// with. The files are our own, from our own host.

test.use({ storageState: SIGNED_OUT });

const PAGES = ["/", "/privacy", "/terms"] as const;

for (const path of PAGES) {
	test(`${path}: the name is read once at the top, with the mark beside it as decoration`, async ({
		page,
	}) => {
		await page.goto(path);
		const home = page.getByRole("banner").getByRole("link", { name: "Timesifier", exact: true });

		// One link, named by the word alone: the drawing adds nothing to what is read out.
		await expect(home).toHaveCount(1);
		await expect(page.getByRole("banner").getByRole("img")).toHaveCount(0);
		// The mark is drawn, beside the name and no taller than the band's type allows.
		const mark = await home.locator("svg").boundingBox();
		const name = await home.boundingBox();
		expect(mark?.width).toBeGreaterThan(16);
		expect(mark?.height).toBeGreaterThan(16);
		expect(mark?.height).toBeLessThanOrEqual(name?.height ?? 0);

		// The foot carries the same lockup.
		await expect(page.getByRole("contentinfo").locator("svg")).toHaveCount(1);
		await expect(page.getByRole("contentinfo")).toContainText("Timesifier");
	});

	test(`${path}: the picture for a shared link is ours, 1200 by 630, and named in full`, async ({
		page,
		request,
		baseURL,
	}) => {
		await page.goto(path);
		const content = (selector: string) => page.locator(selector).getAttribute("content");

		const image = new URL((await content('meta[property="og:image"]')) ?? "");
		// The origin is the one the page was asked for on: no host is written in the code.
		expect(image.origin).toBe(new URL(baseURL ?? "").origin);
		expect(await content('meta[name="twitter:image"]')).toBe(image.href);
		expect(await content('meta[name="twitter:card"]')).toBe("summary_large_image");
		expect(await content('meta[property="og:url"]')).toBe(
			`${new URL(baseURL ?? "").origin}${path}`,
		);
		// A shared link shows the page's own title and description.
		expect(await content('meta[property="og:title"]')).toBe(await page.title());
		expect(await content('meta[property="og:description"]')).toBe(
			await content('meta[name="description"]'),
		);
		expect(((await content('meta[property="og:image:alt"]')) ?? "").length).toBeGreaterThan(10);

		// The file that address names is served by this host, as a PNG of the size the tags give.
		const response = await request.get(`${baseURL}${image.pathname}`);
		expect(response.status()).toBe(200);
		expect(response.headers()["content-type"]).toBe("image/png");
		const size = await page.evaluate(async (source) => {
			const picture = new Image();
			picture.src = source;
			await picture.decode();
			return [picture.naturalWidth, picture.naturalHeight];
		}, image.pathname);
		expect(size).toEqual([
			Number(await content('meta[property="og:image:width"]')),
			Number(await content('meta[property="og:image:height"]')),
		]);
		expect(size).toEqual([1200, 630]);
	});
}

test("every page names its icons, and each is a file of the right kind on our own host", async ({
	page,
	request,
	baseURL,
}) => {
	await page.goto("/");
	const links = await page.evaluate(() =>
		[
			...document.querySelectorAll<HTMLLinkElement>(
				'link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]',
			),
		].map((link) => ({ rel: link.rel, href: link.href })),
	);

	const kinds: Record<string, RegExp> = {
		".svg": /^image\/svg\+xml/,
		".ico": /^image\/(x-icon|vnd\.microsoft\.icon)/,
		".png": /^image\/png/,
		".webmanifest": /^application\/manifest\+json/,
	};
	expect(links.map((link) => link.rel).sort()).toEqual([
		"apple-touch-icon",
		"icon",
		"icon",
		"manifest",
	]);
	for (const { href } of links) {
		const address = new URL(href);
		expect(address.origin, href).toBe(baseURL);
		const response = await request.get(href);
		expect(response.status(), href).toBe(200);
		const kind = Object.entries(kinds).find(([ending]) => address.pathname.endsWith(ending));
		expect(response.headers()["content-type"], href).toMatch(kind?.[1] ?? /^$/);
	}

	// The manifest's own icons are there too.
	const manifest = await (await request.get("/site.webmanifest")).json();
	expect(manifest.icons.length).toBeGreaterThan(0);
	for (const icon of manifest.icons) {
		const response = await request.get(icon.src);
		expect(response.status(), icon.src).toBe(200);
		expect(response.headers()["content-type"], icon.src).toBe(icon.type);
	}
});

/** The colour of the band at the top, as the six digits a `theme-color` is written in. */
function bandColour(page: Page): Promise<string> {
	return page.getByRole("banner").evaluate((header) => {
		const [red, green, blue] = (getComputedStyle(header).backgroundColor.match(/\d+/g) ?? []).map(
			Number,
		);
		return `#${[red, green, blue].map((part) => (part ?? 0).toString(16).padStart(2, "0")).join("")}`;
	});
}

for (const chosenScheme of [undefined, "light", "dark"] as const) {
	test.describe(`for a person who has chosen ${chosenScheme ?? "no scheme"}`, () => {
		// Whatever the device prefers: the page is held to one scheme, and names one colour.
		test.use({ chosenScheme, colorScheme: chosenScheme === "dark" ? "light" : "dark" });

		test("the browser's own frame takes the colour of the band", async ({ page }) => {
			await page.goto("/");

			const named = page.locator('meta[name="theme-color"]');
			await expect(named).toHaveCount(1);
			expect(await named.getAttribute("media")).toBeNull();
			expect((await named.getAttribute("content"))?.toLowerCase()).toBe(await bandColour(page));
		});
	});
}

test.describe("for a person who chose to match their device", () => {
	test.use({ chosenScheme: "system" });

	test("the browser's own frame takes the colour of the band, in each scheme", async ({ page }) => {
		await page.goto("/");

		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			const named = await page
				.locator(`meta[name="theme-color"][media*="${scheme}"]`)
				.getAttribute("content");
			expect(named?.toLowerCase(), scheme).toBe(await bandColour(page));
		}
	});
});
