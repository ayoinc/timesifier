// Generates app/styles/tokens.css: every design token as a CSS custom property,
// and app/styles/theme-colour.ts, the one colour a page's markup has to name.
// Run with `pnpm tokens`; `--print` and `--print-theme-colour` write one of them
// to standard output instead.
import { writeFileSync } from "node:fs";
import { material } from "./material-color.ts";

// ---------------------------------------------------------------------------------
// Sources. Change a value here, run `pnpm tokens`, commit the result.
// ---------------------------------------------------------------------------------

/**
 * The colour every colour role in both schemes is derived from: the amber of the
 * arrowhead in the product's mark, sampled from the owner's drawing of it
 * (docs/design-direction.md, "The mark"). It is the yellow of the sheet.
 */
const SEED_COLOUR = "#FEAD05";

/**
 * The charcoal of the T in the mark, sampled from the same drawing. It is the one
 * colour that is not derived from the seed: the ink of the light scheme, and of
 * anything set on the amber in either scheme. `ink` stands for it in the table
 * below; it is not a role of its own.
 */
const INK_COLOUR = "#252a2f";

/**
 * Roles this product places itself. Each takes one Material role, or the ink, in
 * the light scheme and another in the dark scheme.
 * [role, in the light scheme, in the dark scheme]
 *
 * `primary` is what an action is drawn in. Material's own primary for an amber
 * seed is a brown in the light scheme and a cream in the dark one; here it is
 * the ink of the sheet by day and the amber of the lit board by night.
 * The sheet is the amber page by day and the board by night.
 * Text on paper by day, and on the amber at any hour, is the mark's ink.
 * Material's `on-secondary-container` measures 4.55:1 at rest and under 4.5:1
 * beneath a state layer; the role it is placed on keeps a tonal button above
 * 5.6:1 in every state.
 */
const PLACED_ROLES = [
	["primary", "ink", "primary-container"],
	["on-primary", "primary-container", "ink"],
	["on-primary-fixed", "ink", "ink"],
	["on-primary-container", "ink", "ink"],
	["on-surface", "ink", "on-surface"],
	["on-background", "ink", "on-background"],
	["on-secondary-container", "on-secondary-fixed-variant", "secondary-fixed"],
	["sheet", "primary-container", "surface-container-lowest"],
	["on-sheet", "ink", "primary-container"],
	["on-sheet-variant", "on-primary-fixed-variant", "on-surface-variant"],
] as const;

/**
 * The design has one accent. Material gives a yellow seed a cyan tertiary; every
 * tertiary role takes the value of the secondary role of the same name instead.
 */
const ONE_ACCENT = { from: "tertiary", to: "secondary" };

/**
 * The typefaces: one family in two widths, as a timetable is set. The condensed
 * width is for display text and columns of times, the normal width for reading.
 * The font files are in app/fonts/ and app/styles/fonts.css declares them.
 */
const TYPEFACES = {
	brand: "Sofia Sans Condensed Variable",
	plain: "Sofia Sans Variable",
};
const FONT_STYLESHEET = "./fonts.css";
const FALLBACK_FONTS = 'system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

/** Material 3 Expressive "default spatial" spring, with a mass of 1. */
const SPRING = { stiffness: 380, dampingRatio: 0.8 };

/**
 * The type scale: Material 3's roles, [role, size px, line height px, weight, tracking px, typeface].
 * Display and headline are the condensed width, heavy and set tight; title, body and
 * label keep Material's sizes and line heights, with the tracking this typeface needs.
 */
const TYPE_SCALE = [
	["display-large", 88, 84, 800, -0.5, "brand"],
	["display-medium", 64, 64, 800, -0.25, "brand"],
	["display-small", 44, 46, 800, 0, "brand"],
	["headline-large", 36, 40, 700, 0, "brand"],
	["headline-medium", 28, 32, 700, 0, "brand"],
	["headline-small", 24, 30, 700, 0, "brand"],
	["title-large", 22, 28, 700, 0, "brand"],
	["title-medium", 16, 24, 600, 0.1, "plain"],
	["title-small", 14, 20, 600, 0.1, "plain"],
	["body-large", 16, 24, 400, 0.1, "plain"],
	["body-medium", 14, 20, 400, 0.15, "plain"],
	["body-small", 12, 16, 400, 0.2, "plain"],
	["label-large", 14, 20, 600, 0.1, "plain"],
	["label-medium", 12, 16, 600, 0.3, "plain"],
	["label-small", 11, 16, 600, 0.3, "plain"],
] as const;

/**
 * The corner scale in px. Material 3's step names with tighter values: a printed
 * sheet and the plates of a sign have small corners, and only what must read as
 * round (a switch, an active indicator) uses `full`.
 */
const CORNERS = [
	["none", 0],
	["extra-small", 2],
	["small", 4],
	["medium", 6],
	["large", 8],
	["large-increased", 10],
	["extra-large", 12],
	["extra-large-increased", 16],
	["extra-extra-large", 24],
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

/**
 * Material 3 state tokens. A state layer is the content colour laid over its
 * container at these opacities; a disabled component is the on-surface colour at these.
 */
const STATE_OPACITIES = [
	["hover-state-layer", 0.08],
	["focus-state-layer", 0.1],
	["pressed-state-layer", 0.1],
	["dragged-state-layer", 0.16],
	["disabled-content", 0.38],
	["disabled-container", 0.1],
	["disabled-outline", 0.12],
	["disabled-field-container", 0.04],
	["scrim", 0.32],
] as const;

/** Material 3 keyboard focus indicator in px: its thickness and its two offsets. */
const FOCUS_INDICATOR = [
	["thickness", 3],
	["outer-offset", 2],
	["inner-offset", -3],
] as const;

// ---------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------

function colourRoles(): string[] {
	const { Hct, MaterialDynamicColors, SchemeFidelity, argbFromHex, hexFromArgb } = material;
	const seed = Hct.fromInt(argbFromHex(SEED_COLOUR));
	// Fidelity keeps the seed itself as the primary container, in both schemes;
	// standard contrast, in the 2025 (Expressive) colour specification.
	const light = new SchemeFidelity(seed, false, 0, "2025", "phone");
	const dark = new SchemeFidelity(seed, true, 0, "2025", "phone");

	const material3 = new Map<string, { light: string; dark: string }>();
	for (const role of [
		...new MaterialDynamicColors().allColors,
		MaterialDynamicColors.surfaceVariant,
		MaterialDynamicColors.surfaceTint,
		MaterialDynamicColors.shadow,
		MaterialDynamicColors.scrim,
	]) {
		material3.set(role.name.replaceAll("_", "-"), {
			light: hexFromArgb(role.getArgb(light)),
			dark: hexFromArgb(role.getArgb(dark)),
		});
	}
	const roles = new Map(material3);
	const sources = new Map(material3).set("ink", { light: INK_COLOUR, dark: INK_COLOUR });
	for (const [name, inLight, inDark] of PLACED_ROLES) {
		const day = sources.get(inLight);
		const night = sources.get(inDark);
		if (!day || !night) throw new Error(`No Material role for the placed role ${name}`);
		roles.set(name, { light: day.light, dark: night.dark });
	}
	for (const name of material3.keys()) {
		if (!name.includes(ONE_ACCENT.from)) continue;
		const twin = roles.get(name.replace(ONE_ACCENT.from, ONE_ACCENT.to));
		if (!twin) throw new Error(`No ${ONE_ACCENT.to} role to stand in for ${name}`);
		roles.set(name, twin);
	}

	return [...roles].map(
		([name, { light, dark }]) => `--md-sys-color-${name}: light-dark(${light}, ${dark});`,
	);
}

// ---------------------------------------------------------------------------------
// Type, shape, spacing, elevation
// ---------------------------------------------------------------------------------

function rem(px: number): string {
	return px === 0 ? "0" : `${Number((px / 16).toFixed(6))}rem`;
}

function typeScale(): string[] {
	const lines = Object.entries(TYPEFACES).map(
		([name, family]) => `--md-ref-typeface-${name}: "${family}", ${FALLBACK_FONTS};`,
	);
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
// State
// ---------------------------------------------------------------------------------

function state(): string[] {
	return [
		...STATE_OPACITIES.map(([name, opacity]) => `--md-sys-state-${name}-opacity: ${opacity};`),
		...FOCUS_INDICATOR.map(([name, px]) => `--md-sys-state-focus-indicator-${name}: ${rem(px)};`),
	];
}

// ---------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------

function block(title: string, lines: string[]): string {
	return [`\t/* ${title} */`, ...lines.map((line) => `\t${line}`)].join("\n");
}

function render(): string {
	const groups: [string, string[]][] = [
		["Type scale", typeScale()],
		["Shape", shape()],
		["Spacing", [`--md-sys-spacing-unit: ${rem(SPACING_UNIT_PX)};`]],
		["Elevation", elevation()],
		["Motion", motion()],
		["State", state()],
	];
	const body = groups.map(([title, lines]) => block(title, lines)).join("\n\n");

	return `/* Generated by \`pnpm tokens\` from scripts/tokens.ts. Do not edit this file: change the script and run the command again. */
@import "${FONT_STYLESHEET}";

:root {
	color-scheme: light dark;
}

/* Forces one scheme, on the whole page or on one part of it, whatever the device prefers. */
[data-color-scheme="light"] {
	color-scheme: light;
}

[data-color-scheme="dark"] {
	color-scheme: dark;
}

/*
 * The colour roles are declared on the page and again on every element that forces
 * a scheme. A build for older browsers rewrites light-dark() into variables that
 * are settled on the element that declares them, so a role declared only on the
 * page would keep the page's scheme inside a part that forces the other one.
 */
:root,
[data-color-scheme] {
${block(`Colour roles, light and dark, from the seed ${SEED_COLOUR}`, colourRoles())}
}

:root {
${body}
}
`;
}

/**
 * The colour of the band at the top of every page, in each scheme, for the one
 * place a style sheet cannot reach: the `theme-color` a browser paints its own
 * frame in. Written beside the tokens so that the two cannot drift apart.
 */
function renderThemeColour(): string {
	const sheet = /--md-sys-color-sheet: light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\);/.exec(
		colourRoles().join("\n"),
	);
	if (!sheet) throw new Error("No sheet role to take the theme colour from");
	return `// Generated by scripts/tokens.ts. Do not edit: change the sources there and run \`pnpm tokens\`.

/** The \`sheet\` colour role in each scheme, for \`<meta name="theme-color">\`. */
export const THEME_COLOUR = { light: "${sheet[1]}", dark: "${sheet[2]}" } as const;
`;
}

if (process.argv.includes("--print")) {
	process.stdout.write(render());
} else if (process.argv.includes("--print-theme-colour")) {
	process.stdout.write(renderThemeColour());
} else {
	writeFileSync(new URL("../app/styles/tokens.css", import.meta.url), render());
	writeFileSync(new URL("../app/styles/theme-colour.ts", import.meta.url), renderThemeColour());
	console.log("Wrote app/styles/tokens.css and app/styles/theme-colour.ts");
}
