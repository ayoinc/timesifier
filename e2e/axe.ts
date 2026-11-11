import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { expect } from "./fixtures";

// axe-core's rules for WCAG 2.0, 2.1 and 2.2 at levels A and AA. No rule is
// disabled and nothing on the page is excluded.
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** An input with nothing typed in it has no text to measure. */
export const EMPTY_INPUT = "emptyValue";
/** Text of the page that an open overlay lies across. */
export const UNDER_AN_OVERLAY = "bgOverlap";

/**
 * Scans the page and returns what is wrong with it, one line per element:
 * every violation, and every piece of text whose contrast axe could not measure
 * for a reason other than the ones named in `unmeasurable`. A scan that reports
 * no violations because it could not see the colours proves nothing.
 */
export async function problems(page: Page, unmeasurable: string[] = []): Promise<string[]> {
	// A colour measured part-way through a fade is not the colour shown.
	await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
	const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();

	const violations = results.violations.flatMap((violation) =>
		violation.nodes.map(
			(node) => `${violation.id}: ${node.target.join(" ")} — ${node.failureSummary}`,
		),
	);
	const unmeasured = results.incomplete
		.filter((result) => result.id === "color-contrast")
		.flatMap((result) => result.nodes)
		.filter((node) => !unmeasurable.includes(node.any[0]?.data?.messageKey))
		.map((node) => `contrast not measured: ${node.target.join(" ")} — ${node.any[0]?.message}`);

	const measured = results.passes.find((result) => result.id === "color-contrast")?.nodes.length;
	expect(measured, "pieces of text whose contrast was measured").toBeGreaterThan(0);

	return [...violations, ...unmeasured];
}

/** Text whose lines lie over different elements further down the stack, such as a dialog's. */
export const OVER_SEVERAL_ELEMENTS = "elmPartiallyObscuring";

/**
 * The WCAG contrast ratio of an element's text against the nearest background
 * behind it that is not transparent. For text axe could not measure.
 */
export function contrast(text: Locator): Promise<number> {
	return text.evaluate((element) => {
		// A canvas turns any colour CSS can write into red, green, blue and alpha.
		const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		if (!canvas) throw new Error("no canvas");
		const channels = (colour: string) => {
			canvas.clearRect(0, 0, 1, 1);
			canvas.fillStyle = colour;
			canvas.fillRect(0, 0, 1, 1);
			return [...canvas.getImageData(0, 0, 1, 1).data];
		};
		const luminance = (colour: string) => {
			const [red = 0, green = 0, blue = 0] = channels(colour).map((channel) => {
				const share = channel / 255;
				return share <= 0.04045 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
		};

		let behind: Element | null = element;
		while (behind && channels(getComputedStyle(behind).backgroundColor)[3] !== 255) {
			behind = behind.parentElement;
		}
		if (!behind) throw new Error("no opaque background behind the text");

		const [lighter = 0, darker = 0] = [
			luminance(getComputedStyle(element).color),
			luminance(getComputedStyle(behind).backgroundColor),
		].sort((a, b) => b - a);
		return (lighter + 0.05) / (darker + 0.05);
	});
}
