// Generates app/styles/tokens.css: every design token as a CSS custom property.
// Run with `pnpm tokens`; `--print` writes to standard output instead of the file.
import { writeFileSync } from "node:fs";
import { material } from "./material-color.ts";

// ---------------------------------------------------------------------------------
// Sources. Change a value here, run `pnpm tokens`, commit the result.
// ---------------------------------------------------------------------------------

/** The one colour every colour role in both schemes is derived from. */
const SEED_COLOUR = "#4F5BD5";

/** The typeface, and the self-hosted package its font files come from. */
const TYPEFACE = {
	family: "Roboto Flex Variable",
	stylesheet: "@fontsource-variable/roboto-flex/index.css",
};
const FALLBACK_FONTS =
	'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Material 3 Expressive "default spatial" spring, with a mass of 1. */
const SPRING = { stiffness: 380, dampingRatio: 0.8 };

/** Material 3 type scale: [role, size px, line height px, weight, tracking px, typeface]. */
const TYPE_SCALE = [
	["display-large", 57, 64, 400, -0.25, "brand"],
	["display-medium", 45, 52, 400, 0, "brand"],
	["display-small", 36, 44, 400, 0, "brand"],
	["headline-large", 32, 40, 400, 0, "brand"],
	["headline-medium", 28, 36, 400, 0, "brand"],
	["headline-small", 24, 32, 400, 0, "brand"],
	["title-large", 22, 28, 400, 0, "brand"],
	["title-medium", 16, 24, 500, 0.15, "plain"],
	["title-small", 14, 20, 500, 0.1, "plain"],
	["body-large", 16, 24, 400, 0.5, "plain"],
	["body-medium", 14, 20, 400, 0.25, "plain"],
	["body-small", 12, 16, 400, 0.4, "plain"],
	["label-large", 14, 20, 500, 0.1, "plain"],
	["label-medium", 12, 16, 500, 0.5, "plain"],
	["label-small", 11, 16, 500, 0.5, "plain"],
] as const;

/** Material 3 corner scale in px, including the Expressive additions. */
const CORNERS = [
	["none", 0],
	["extra-small", 4],
	["small", 8],
	["medium", 12],
	["large", 16],
	["large-increased", 20],
	["extra-large", 28],
	["extra-large-increased", 32],
	["extra-extra-large", 48],
] as const;

/** Every space and size is a multiple of this unit. */
const SPACING_UNIT_PX = 4;

/**
 * Material 3 elevation: a key shadow at 30% and an ambient shadow at 15% of the
 * shadow colour. Each entry is [y, blur, spread] in px.
 */
const ELEVATION = [
	{ key: [0, 0, 0], ambient: [0, 0, 0] },
	{ key: [1, 2, 0], ambient: [1, 3, 1] },
	{ key: [1, 2, 0], ambient: [2, 6, 2] },
	{ key: [1, 3, 0], ambient: [4, 8, 3] },
	{ key: [2, 3, 0], ambient: [6, 10, 4] },
	{ key: [4, 4, 0], ambient: [8, 12, 6] },
] as const;

/** Material 3 durations in milliseconds. */
const DURATIONS = [
	["short1", 50],
	["short2", 100],
	["short3", 150],
	["short4", 200],
	["medium1", 250],
	["medium2", 300],
	["medium3", 350],
	["medium4", 400],
	["long1", 450],
	["long2", 500],
	["long3", 550],
	["long4", 600],
	["extra-long1", 700],
	["extra-long2", 800],
	["extra-long3", 900],
	["extra-long4", 1000],
] as const;

/** Material 3 easings. */
const EASINGS = [
	["emphasized", "cubic-bezier(0.2, 0, 0, 1)"],
	["emphasized-accelerate", "cubic-bezier(0.3, 0, 0.8, 0.15)"],
	["emphasized-decelerate", "cubic-bezier(0.05, 0.7, 0.1, 1)"],
	["standard", "cubic-bezier(0.2, 0, 0, 1)"],
	["standard-accelerate", "cubic-bezier(0.3, 0, 1, 1)"],
	["standard-decelerate", "cubic-bezier(0, 0, 0, 1)"],
	["legacy", "cubic-bezier(0.4, 0, 0.2, 1)"],
	["legacy-accelerate", "cubic-bezier(0.4, 0, 1, 1)"],
	["legacy-decelerate", "cubic-bezier(0, 0, 0.2, 1)"],
	["linear", "cubic-bezier(0, 0, 1, 1)"],
] as const;

// ---------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------

function colourRoles(): string[] {
	const { Hct, MaterialDynamicColors, SchemeTonalSpot, argbFromHex, hexFromArgb } = material;
	const seed = Hct.fromInt(argbFromHex(SEED_COLOUR));
	// Tonal spot at standard contrast, in the 2025 (Expressive) colour specification.
	const light = new SchemeTonalSpot(seed, false, 0, "2025", "phone");
	const dark = new SchemeTonalSpot(seed, true, 0, "2025", "phone");

	const roles = new Map<string, InstanceType<typeof material.DynamicColor>>();
	for (const role of [
		...new MaterialDynamicColors().allColors,
		MaterialDynamicColors.surfaceVariant,
		MaterialDynamicColors.surfaceTint,
		MaterialDynamicColors.shadow,
		MaterialDynamicColors.scrim,
	]) {
		roles.set(role.name.replaceAll("_", "-"), role);
	}

	return [...roles].map(
		([name, role]) =>
			`--md-sys-color-${name}: light-dark(${hexFromArgb(role.getArgb(light))}, ${hexFromArgb(role.getArgb(dark))});`,
	);
}

// ---------------------------------------------------------------------------------
// Type, shape, spacing, elevation
// ---------------------------------------------------------------------------------

function rem(px: number): string {
	return px === 0 ? "0" : `${Number((px / 16).toFixed(6))}rem`;
}

function typeScale(): string[] {
	const stack = `"${TYPEFACE.family}", ${FALLBACK_FONTS}`;
	const lines = [`--md-ref-typeface-brand: ${stack};`, `--md-ref-typeface-plain: ${stack};`];
	for (const [role, size, lineHeight, weight, tracking, typeface] of TYPE_SCALE) {
		const name = `--md-sys-typescale-${role}`;
		lines.push(
			`${name}-font: var(--md-ref-typeface-${typeface});`,
			`${name}-size: ${rem(size)};`,
			`${name}-line-height: ${rem(lineHeight)};`,
			`${name}-weight: ${weight};`,
			`${name}-tracking: ${rem(tracking)};`,
		);
	}
	return lines;
}

function shape(): string[] {
	return [
		...CORNERS.map(([name, px]) => `--md-sys-shape-corner-${name}: ${rem(px)};`),
		"--md-sys-shape-corner-full: calc(infinity * 1px);",
	];
}

function elevation(): string[] {
	const px = (value: number) => (value === 0 ? "0" : `${value}px`);
	const layer = ([y, blur, spread]: readonly number[], percent: number) =>
		`0 ${px(y)} ${px(blur)} ${px(spread)} color-mix(in srgb, var(--md-sys-color-shadow) ${percent}%, transparent)`;
	return ELEVATION.map(
		({ key, ambient }, level) =>
			`--md-sys-elevation-level${level}: ${layer(key, 30)}, ${layer(ambient, 15)};`,
	);
}

// ---------------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------------

/** Position of a spring released at 0 towards 1, `seconds` after release. */
function springPosition(seconds: number): number {
	const natural = Math.sqrt(SPRING.stiffness);
	const ratio = SPRING.dampingRatio;
	if (ratio < 1) {
		const damped = natural * Math.sqrt(1 - ratio * ratio);
		const decay = Math.exp(-ratio * natural * seconds);
		return (
			1 -
			decay *
				(Math.cos(damped * seconds) + ((ratio * natural) / damped) * Math.sin(damped * seconds))
		);
	}
	if (ratio === 1) {
		return 1 - Math.exp(-natural * seconds) * (1 + natural * seconds);
	}
	const root = Math.sqrt(ratio * ratio - 1);
	const slow = -natural * (ratio - root);
	const fast = -natural * (ratio + root);
	return 1 - (fast * Math.exp(slow * seconds) - slow * Math.exp(fast * seconds)) / (fast - slow);
}

function spring(): string[] {
	// The spring has settled once it stays within 0.1% of its target.
	let settledMs = 0;
	for (let ms = 1; ms <= 10_000; ms++) {
		if (Math.abs(1 - springPosition(ms / 1000)) >= 0.001) settledMs = ms;
	}
	const stepMs = 10;
	const durationMs = Math.ceil((settledMs + 1) / stepMs) * stepMs;
	const stops: number[] = [];
	for (let ms = 0; ms < durationMs; ms += stepMs) {
		stops.push(Number(springPosition(ms / 1000).toFixed(3)));
	}
	stops.push(1);

	// Motion takes the damping coefficient; with a mass of 1 that is 2 × ratio × √stiffness.
	const damping = Number((2 * SPRING.dampingRatio * Math.sqrt(SPRING.stiffness)).toFixed(2));
	return [
		`--md-sys-motion-spring-stiffness: ${SPRING.stiffness};`,
		`--md-sys-motion-spring-damping: ${damping};`,
		`--md-sys-motion-spring-duration: ${durationMs}ms;`,
		`--md-sys-motion-spring-easing: linear(${stops.join(", ")});`,
	];
}

function motion(): string[] {
	return [
		...DURATIONS.map(([name, ms]) => `--md-sys-motion-duration-${name}: ${ms}ms;`),
		...EASINGS.map(([name, curve]) => `--md-sys-motion-easing-${name}: ${curve};`),
		...spring(),
	];
}

// ---------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------

function render(): string {
	const groups: [string, string[]][] = [
		[`Colour roles, light and dark, from the seed ${SEED_COLOUR}`, colourRoles()],
		["Type scale", typeScale()],
		["Shape", shape()],
		["Spacing", [`--md-sys-spacing-unit: ${rem(SPACING_UNIT_PX)};`]],
		["Elevation", elevation()],
		["Motion", motion()],
	];
	const body = groups
		.map(([title, lines]) => [`\t/* ${title} */`, ...lines.map((line) => `\t${line}`)].join("\n"))
		.join("\n\n");

	return `/* Generated by \`pnpm tokens\` from scripts/tokens.ts. Do not edit this file: change the script and run the command again. */
@import "${TYPEFACE.stylesheet}";

:root {
	color-scheme: light dark;

${body}
}

/* Forces one scheme whatever the device prefers. */
html[data-color-scheme="light"] {
	color-scheme: light;
}

html[data-color-scheme="dark"] {
	color-scheme: dark;
}
`;
}

if (process.argv.includes("--print")) {
	process.stdout.write(render());
} else {
	const file = new URL("../app/styles/tokens.css", import.meta.url);
	writeFileSync(file, render());
	console.log("Wrote app/styles/tokens.css");
}
