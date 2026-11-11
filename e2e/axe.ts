import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

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
