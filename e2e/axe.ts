import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { expect } from "./fixtures";

// axe-core's rules for WCAG 2.0, 2.1 and 2.2 at levels A and AA. No rule is
// disabled, and nothing on the page is excluded but a drawing a test names:
// axe cannot tell what lies behind text inside an SVG, so the test that leaves a
// drawing out measures that drawing's text itself (`drawnContrast` below).
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** An input with nothing typed in it has no text to measure. */
export const EMPTY_INPUT = "emptyValue";
/** Text of the page that an open overlay lies across. */
export const UNDER_AN_OVERLAY = "bgOverlap";
/**
 * A running timer's digit while it changes: for that moment it holds less than
 * one character, and axe will not measure it. The timer's other digits, the
 * same colour on the same surface, are measured.
 */
export const DIGIT_CHANGING = "shortTextContent";

/**
 * Scans the page and returns what is wrong with it, one line per element:
 * every violation, and every piece of text whose contrast axe could not measure
 * for a reason other than the ones named in `unmeasurable`. A scan that reports
 * no violations because it could not see the colours proves nothing.
 * `drawings` are selectors of SVG drawings left out of the scan.
 */
export async function problems(
	page: Page,
	unmeasurable: string[] = [],
	drawings: string[] = [],
): Promise<string[]> {
	// A colour measured part-way through a fade is not the colour shown. An
	// animation on the scroll's timeline (the band settling) is no fade: it holds
	// still while the page does, and never finishes. A view transition counts
	// from when it starts, and a stylesheet a route brings from when it is asked
	// for: until it has loaded, the page is measured without it (the links of
	// the navigation as bare text, 18px tall).
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					document.getAnimations().filter((each) => each.timeline === document.timeline).length +
					((document as Document & { activeViewTransition?: unknown }).activeViewTransition
						? 1
						: 0) +
					[...document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")].filter(
						(each) => !each.sheet,
					).length,
			),
		)
		.toBe(0);
	// From 600px the navigation's column scrolls on its own when it is taller
	// than the window, as an owner's is at 1280×800 with a timer running; Tab
	// scrolls it to the link it reaches. Text it has scrolled part-way out of
	// view cannot be measured, so it is scanned from its top, where it opens. A
	// page outside an organisation has no such navigation.
	await page.getByRole("navigation", { name: "Main" }).evaluateAll((found) => {
		for (const navigation of found) navigation.scrollTop = 0;
	});
	let scan = new AxeBuilder({ page }).withTags(WCAG_22_AA);
	for (const drawing of drawings) scan = scan.exclude(drawing);
	const results = await scan.analyze();

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

/**
 * The WCAG contrast ratio of every piece of text in an SVG drawing against what
 * it is drawn on: the shape just before it in its group, a plate or a disc, or
 * else the page behind the drawing. One entry for each piece of text shown.
 */
export function drawnContrast(drawing: Locator): Promise<{ text: string; ratio: number }[]> {
	return drawing.evaluate((svg) => {
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
		const pageBehind = () => {
			let behind: Element | null = svg;
			while (behind && channels(getComputedStyle(behind).backgroundColor)[3] !== 255) {
				behind = behind.parentElement;
			}
			return getComputedStyle(behind ?? document.body).backgroundColor;
		};

		return [...svg.querySelectorAll("text")].map((text) => {
			// The shape drawn just before the text, where there is one: a number's disc, a window's plate.
			const before = text.previousElementSibling;
			const ground = before?.matches("rect, circle") ? before : null;
			const behind = ground ? getComputedStyle(ground).fill : pageBehind();
			const [lighter = 0, darker = 0] = [
				luminance(getComputedStyle(text).fill),
				luminance(behind),
			].sort((one, other) => other - one);
			return {
				text: (text.textContent ?? "").trim(),
				ratio: (lighter + 0.05) / (darker + 0.05),
			};
		});
	});
}
