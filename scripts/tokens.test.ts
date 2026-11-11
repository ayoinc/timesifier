import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("..", import.meta.url));
const committed = readFileSync(new URL("../app/styles/tokens.css", import.meta.url), "utf8");

const committedThemeColour = readFileSync(
	new URL("../app/styles/theme-colour.ts", import.meta.url),
	"utf8",
);

function generate(flag = "--print"): string {
	return execFileSync(process.execPath, ["scripts/tokens.ts", flag], {
		cwd: repository,
		encoding: "utf8",
	});
}

describe("pnpm tokens", () => {
	it("gives byte-identical output on every run, equal to the committed file", () => {
		const first = generate();

		expect(generate()).toBe(first);
		expect(committed).toBe(first);
	});

	it("writes the colour a browser paints its own frame in from the same roles", () => {
		const themeColour = generate("--print-theme-colour");

		expect(committedThemeColour).toBe(themeColour);
		const sheet = /--md-sys-color-sheet: light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\);/.exec(
			committed,
		);
		expect(sheet).not.toBeNull();
		expect(themeColour).toContain(`light: "${sheet?.[1]}", dark: "${sheet?.[2]}"`);
	});
});

// WCAG 2 contrast, from the definitions of relative luminance and contrast ratio.
function luminance(hex: string): number {
	const [red, green, blue] = [1, 3, 5].map((start) => {
		const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(text: string, background: string): number {
	const [lighter, darker] = [luminance(text), luminance(background)].sort((a, b) => b - a) as [
		number,
		number,
	];
	return (lighter + 0.05) / (darker + 0.05);
}

/** Every text role with each background role it is designed to sit on. */
function textPairs(): [text: string, background: string][] {
	const pairs: [string, string][] = [];
	for (const accent of ["primary", "secondary", "tertiary", "error"]) {
		pairs.push([`on-${accent}`, accent], [`on-${accent}-container`, `${accent}-container`]);
	}
	for (const accent of ["primary", "secondary", "tertiary"]) {
		for (const text of [`on-${accent}-fixed`, `on-${accent}-fixed-variant`]) {
			pairs.push([text, `${accent}-fixed`], [text, `${accent}-fixed-dim`]);
		}
	}
	// `primary` is also the colour of a text button, a link and a field in focus.
	for (const text of ["on-surface", "on-surface-variant", "primary"]) {
		for (const background of [
			"surface",
			"surface-dim",
			"surface-bright",
			"surface-container-lowest",
			"surface-container-low",
			"surface-container",
			"surface-container-high",
			"surface-container-highest",
		]) {
			pairs.push([text, background]);
		}
	}
	pairs.push(
		["on-background", "background"],
		["inverse-on-surface", "inverse-surface"],
		["inverse-primary", "inverse-surface"],
		// The sheet, and a button on it, which swaps the two.
		["on-sheet", "sheet"],
		["on-sheet-variant", "sheet"],
		["sheet", "on-sheet"],
	);
	return pairs;
}

describe("colour roles", () => {
	const roles = new Map<string, { light: string; dark: string }>();
	const declaration = /--md-sys-color-([a-z-]+): light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\);/g;
	for (const [, name, light, dark] of committed.matchAll(declaration)) {
		if (name && light && dark) roles.set(name, { light, dark });
	}

	for (const scheme of ["light", "dark"] as const) {
		it.each(textPairs())(`${scheme}: %s on %s is at least 4.5:1`, (text, background) => {
			const textColour = roles.get(text)?.[scheme];
			const backgroundColour = roles.get(background)?.[scheme];
			expect(textColour, `--md-sys-color-${text}`).toBeDefined();
			expect(backgroundColour, `--md-sys-color-${background}`).toBeDefined();

			expect(contrast(textColour as string, backgroundColour as string)).toBeGreaterThanOrEqual(
				4.5,
			);
		});
	}
});
