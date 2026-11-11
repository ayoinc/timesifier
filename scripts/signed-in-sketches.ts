// Draws docs/design/signed-in-*.svg: the convention for the signed-in product
// (docs/design-direction.md, "For the product screens") as one still sketch for
// each pattern, before any of it is built. Run with
// `node scripts/signed-in-sketches.ts`, then commit what it writes.
//
// A sketch is a drawing of a window, not a page of the application. Its colours
// are read from the generated tokens, its type is the site's own font files
// carried inside each drawing, and the mark is the application's outlines, so a
// sketch cannot drift from the direction it shows. The words and the people in
// them are examples.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MARK_ARROW, MARK_BAR, MARK_HEIGHT, MARK_STEM } from "../app/components/mark-paths.ts";

const file = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const TOKENS = readFileSync(file("../app/styles/tokens.css"), "utf8");
const OUT = file("../docs/design/");

// ---------------------------------------------------------------------------------
// Tokens: colour roles in both schemes, and the type scale.
// ---------------------------------------------------------------------------------

type Scheme = "light" | "dark";

const COLOURS = new Map<string, Record<Scheme, string>>();
for (const [, name, light, dark] of TOKENS.matchAll(
	/--md-sys-color-([a-z-]+):\s*light-dark\((#[0-9a-f]+),\s*(#[0-9a-f]+)\);/g,
)) {
	if (name && light && dark) COLOURS.set(name, { light, dark });
}

type TypeRole =
	| "display-small"
	| "headline-large"
	| "headline-medium"
	| "headline-small"
	| "title-large"
	| "title-medium"
	| "body-large"
	| "body-medium"
	| "body-small"
	| "label-large";

interface Type {
	/** The condensed width, for display text and figures; the plain width for what is read. */
	brand: boolean;
	size: number;
	line: number;
	weight: number;
	tracking: number;
}

function typeToken(role: TypeRole, property: string): string {
	const found = new RegExp(`--md-sys-typescale-${role}-${property}:\\s*([^;]+);`).exec(TOKENS);
	if (!found?.[1]) throw new Error(`No ${property} for ${role} in app/styles/tokens.css`);
	return found[1];
}

const px = (rem: string) => Number.parseFloat(rem) * 16;

function typeOf(role: TypeRole): Type {
	return {
		brand: typeToken(role, "font").includes("brand"),
		size: px(typeToken(role, "size")),
		line: px(typeToken(role, "line-height")),
		weight: Number(typeToken(role, "weight")),
		tracking: px(typeToken(role, "tracking")),
	};
}

const ROLES: TypeRole[] = [
	"display-small",
	"headline-large",
	"headline-medium",
	"headline-small",
	"title-large",
	"title-medium",
	"body-large",
	"body-medium",
	"body-small",
	"label-large",
];
const TYPE = Object.fromEntries(ROLES.map((role) => [role, typeOf(role)])) as Record<
	TypeRole,
	Type
>;

const font = (name: string) =>
	readFileSync(file(`../app/fonts/${name}-latin-wght-normal.woff2`)).toString("base64");

const STYLE = [
	`@font-face{font-family:Brand;font-weight:1 1000;src:url(data:font/woff2;base64,${font("sofia-sans-condensed")})}`,
	`@font-face{font-family:Plain;font-weight:1 1000;src:url(data:font/woff2;base64,${font("sofia-sans")})}`,
	"text{dominant-baseline:central;font-variant-numeric:tabular-nums}",
	...ROLES.map((role) => {
		const { brand, size, weight, tracking } = TYPE[role];
		return `.${role}{font:${weight} ${size}px ${brand ? "Brand" : "Plain"},system-ui,sans-serif;letter-spacing:${tracking}px}`;
	}),
].join("");

// ---------------------------------------------------------------------------------
// The pen: text, rules and the few controls a sketch needs.
// ---------------------------------------------------------------------------------

/** What a piece of a drawing is: its markup and how much height it took. */
interface Piece {
	svg: string;
	height: number;
}

interface Pen {
	scheme: Scheme;
	colour: (role: string) => string;
}

function pen(scheme: Scheme): Pen {
	return {
		scheme,
		colour(role) {
			const found = COLOURS.get(role);
			if (!found) throw new Error(`No colour role ${role} in app/styles/tokens.css`);
			return found[scheme];
		},
	};
}

const escapeSvgText = (words: string) =>
	words.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface TextOptions {
	/** A colour role. Defaults to the text colour of paper. */
	fill?: string;
	anchor?: "start" | "middle" | "end";
	underline?: boolean;
}

/** One line of text whose line box starts at `top`. A part may have a colour of its own. */
function line(
	p: Pen,
	x: number,
	top: number,
	role: TypeRole,
	words: string | [string, string][],
	{ fill = "on-surface", anchor = "start", underline = false }: TextOptions = {},
): string {
	const y = top + TYPE[role].line / 2;
	const body =
		typeof words === "string"
			? escapeSvgText(words)
			: words
					.map(
						([part, colour]) => `<tspan fill="${p.colour(colour)}">${escapeSvgText(part)}</tspan>`,
					)
					.join("");
	return (
		`<text x="${x}" y="${y}" class="${role}" fill="${p.colour(fill)}" text-anchor="${anchor}"` +
		`${underline ? ' text-decoration="underline"' : ""}>${body}</text>`
	);
}

/** How wide a run of text is, near enough to break lines and to size a button. */
function measure(words: string, role: TypeRole): number {
	const { brand, size } = TYPE[role];
	return words.length * size * (brand ? 0.4 : 0.5);
}

/** A paragraph, broken to a width. */
function paragraph(
	p: Pen,
	x: number,
	top: number,
	width: number,
	role: TypeRole,
	words: string,
	fill = "on-surface",
): Piece {
	const lines: string[] = [];
	let current = "";
	for (const word of words.split(" ")) {
		const next = current ? `${current} ${word}` : word;
		if (current && measure(next, role) > width) {
			lines.push(current);
			current = word;
		} else current = next;
	}
	if (current) lines.push(current);
	const height = TYPE[role].line;
	return {
		svg: lines
			.map((each, index) => line(p, x, top + index * height, role, each, { fill }))
			.join(""),
		height: lines.length * height,
	};
}

/** A ruled line across: 1px between rows, 2px under a band or above a section. */
function rule(p: Pen, x: number, y: number, width: number, weight: 1 | 2, role = "on-surface") {
	return `<rect x="${x}" y="${y}" width="${width}" height="${weight}" fill="${p.colour(role)}"/>`;
}

type ButtonKind = "filled" | "outlined" | "text" | "danger-text" | "danger-filled";

const BUTTON_HEIGHT = 40;

/** A text button has no box: on the page its words line up with the text around them. */
const isBoxed = (kind: ButtonKind) => kind !== "text" && kind !== "danger-text";

/** The room a button takes: its words, and inside a box the component's 16px either side. */
function buttonWidth(label: string, kind: ButtonKind): number {
	return Math.round(measure(label, "label-large") * 1.04 + (isBoxed(kind) ? 32 : 0));
}

/**
 * A button of the component's size: 40px tall with 10px corners. `edge` is where
 * it starts, or where it ends when `anchor` says so.
 */
function button(
	p: Pen,
	edge: number,
	top: number,
	label: string,
	kind: ButtonKind,
	anchor: "start" | "end" = "start",
): string {
	const centre = top + (BUTTON_HEIGHT - TYPE["label-large"].line) / 2;
	if (!isBoxed(kind)) {
		return line(p, edge, centre, "label-large", label, {
			fill: kind === "text" ? "primary" : "error",
			anchor,
		});
	}
	const width = buttonWidth(label, kind);
	const x = anchor === "start" ? edge : edge - width;
	const words = (fill: string) =>
		line(p, x + width / 2, centre, "label-large", label, { fill, anchor: "middle" });
	if (kind === "outlined") {
		return (
			`<rect x="${x + 0.5}" y="${top + 0.5}" width="${width - 1}" height="${BUTTON_HEIGHT - 1}" rx="9.5" fill="none" stroke="${p.colour("on-surface")}"/>` +
			words("on-surface")
		);
	}
	const [ground, ink]: [string, string] =
		kind === "filled" ? ["primary", "on-primary"] : ["error", "on-error"];
	return (
		`<rect x="${x}" y="${top}" width="${width}" height="${BUTTON_HEIGHT}" rx="10" fill="${p.colour(ground)}"/>` +
		words(ink)
	);
}

/** The lockup: the mark as tall as the name's type, a third of that from it. */
function lockup(p: Pen, x: number, centre: number): string {
	const height = 24;
	const scale = height / MARK_HEIGHT;
	const ink = p.colour("on-surface");
	return (
		`<g transform="translate(${x} ${centre - height / 2}) scale(${scale})">` +
		`<path fill="${ink}" d="${MARK_BAR}"/><path fill="${ink}" d="${MARK_STEM}"/>` +
		`<path fill="${p.colour("primary-container")}" d="${MARK_ARROW}"/></g>` +
		line(p, x + 41, centre - TYPE["headline-small"].line / 2, "headline-small", "Timesifier")
	);
}

// ---------------------------------------------------------------------------------
// The frame of a signed-in page: the band, and the navigation in its two forms.
// ---------------------------------------------------------------------------------

const DESTINATIONS = ["Today", "Reports", "Projects", "Settings"] as const;
type Destination = (typeof DESTINATIONS)[number];

/** The band is as tall as the public one: 20px round a 38px line, and its 2px rule. */
const BAND = 80;
const BAR = 64;
const RAIL = 96;

interface Frame {
	width: number;
	height: number;
	/** The start and end edges of the page frame: 1200px at most, centred, with its side padding. */
	start: number;
	end: number;
	/** Where the page's own content starts: beside the navigation from 600px. */
	content: number;
	/** Where the content starts under the band. */
	top: number;
	compact: boolean;
}

function frame(width: number, height: number, navigation: boolean): Frame {
	const compact = width < 600;
	const start = Math.max(0, (width - 1200) / 2) + (compact ? 20 : 32);
	return {
		width,
		height,
		start,
		end: width - start,
		content: navigation && !compact ? start + RAIL + 32 : start,
		top: BAND + (compact ? 32 : 40),
		compact,
	};
}

/** The paper band: the lockup at the start, the organisation's name at the end, a 2px ink rule under. */
function band(p: Pen, f: Frame, organisation?: string): string {
	return (
		lockup(p, f.start, (BAND - 2) / 2) +
		(organisation
			? line(p, f.end, (BAND - 2 - TYPE["title-medium"].line) / 2, "title-medium", organisation, {
					anchor: "end",
				})
			: "") +
		rule(p, 0, BAND - 2, f.width, 2)
	);
}

/** The navigation: words in the margin from 600px, a bar along the bottom under it. */
function navigation(p: Pen, f: Frame, current: Destination): string {
	const label = TYPE["label-large"].line;
	if (f.compact) {
		const top = f.height - BAR;
		const cell = f.width / DESTINATIONS.length;
		return (
			`<rect x="0" y="${top}" width="${f.width}" height="${BAR}" fill="${p.colour("surface")}"/>` +
			rule(p, 0, top, f.width, 2) +
			DESTINATIONS.map((name, index) => {
				const centre = cell * index + cell / 2;
				const isCurrent = name === current;
				return (
					line(p, centre, top + (BAR - label) / 2, "label-large", name, {
						anchor: "middle",
						fill: isCurrent ? "on-surface" : "on-surface-variant",
					}) + (isCurrent ? rule(p, centre - 12, top + (BAR + label) / 2 + 4, 24, 2) : "")
				);
			}).join("")
		);
	}
	const item = 48;
	return DESTINATIONS.map((name, index) => {
		const top = f.top + index * item;
		const isCurrent = name === current;
		return (
			line(p, f.start + 16, top + (item - label) / 2, "label-large", name, {
				fill: isCurrent ? "on-surface" : "on-surface-variant",
			}) +
			(isCurrent
				? `<rect x="${f.start}" y="${top + 12}" width="2" height="24" fill="${p.colour("on-surface")}"/>`
				: "")
		);
	}).join("");
}

/** The one `h1` of a page: `display-small` from 600px, `headline-large` under it. */
function heading(p: Pen, f: Frame, top: number, words: string): Piece {
	const role: TypeRole = f.compact ? "headline-large" : "display-small";
	return { svg: line(p, f.content, top, role, words), height: TYPE[role].line };
}

// ---------------------------------------------------------------------------------
// Facts: a named thing, its value, and at most one action. Under a section's rule.
// ---------------------------------------------------------------------------------

interface Fact {
	term: string;
	/** The value, in ink. */
	value?: string;
	/** A sentence that explains, in the quieter colour. */
	says?: string;
	/** The row's one control: a text button, or the term itself as a link. */
	action?: { label: string; kind: ButtonKind };
	link?: boolean;
	/** A choice made in the row: the chosen one first. */
	choices?: string[];
}

function radio(p: Pen, x: number, centre: number, label: string, chosen: boolean): string {
	const tone = p.colour(chosen ? "primary" : "on-surface-variant");
	return (
		`<circle cx="${x + 10}" cy="${centre}" r="9" fill="none" stroke="${tone}" stroke-width="2"/>` +
		(chosen ? `<circle cx="${x + 10}" cy="${centre}" r="5" fill="${tone}"/>` : "") +
		line(p, x + 32, centre - TYPE["body-large"].line / 2, "body-large", label)
	);
}

/** The rows, with a 1px rule between them. The action folds under the words where the row is narrow. */
function facts(p: Pen, x: number, top: number, width: number, rows: Fact[]): Piece {
	const folded = width < 384;
	let y = top;
	let svg = "";
	rows.forEach((row, index) => {
		if (index > 0) svg += rule(p, x, y, width, 1, "outline-variant");
		const start = y;
		y += 16;
		const actionWidth = row.action && !folded ? buttonWidth(row.action.label, row.action.kind) : 0;
		const room = width - (actionWidth ? actionWidth + 16 : 0);
		svg += line(p, x, y, row.link ? "body-large" : "title-medium", row.term, {
			underline: row.link,
		});
		y += TYPE["title-medium"].line;
		if (row.value) {
			svg += line(p, x, y, "body-large", row.value);
			y += TYPE["body-large"].line;
		}
		if (row.says) {
			const says = paragraph(p, x, y, room, "body-large", row.says, "on-surface-variant");
			svg += says.svg;
			y += says.height;
		}
		if (row.choices) {
			y += 4;
			let across = x;
			for (const [position, choice] of row.choices.entries()) {
				svg += radio(p, across, y + 20, choice, position === 0);
				if (folded) y += 40;
				else across += 32 + measure(choice, "body-large") + 32;
			}
			if (!folded) y += 40;
		}
		if (row.action && folded) {
			svg += button(p, x, y + 4, row.action.label, row.action.kind);
			y += 4 + BUTTON_HEIGHT - (isBoxed(row.action.kind) ? 0 : 8);
		}
		y += 16;
		if (row.action && !folded) {
			svg += button(
				p,
				x + width,
				start + (y - start - BUTTON_HEIGHT) / 2,
				row.action.label,
				row.action.kind,
				"end",
			);
		}
	});
	return { svg, height: y - top };
}

interface Section {
	title: string;
	says: string;
	rows: Fact[];
}

/**
 * A section of a page, ruled off: a 2px ink rule, then its heading. From 840px
 * the heading stands in the first 4 of the content's 12 columns and the rows in
 * the other 8, as on the privacy notice; under that they are stacked.
 */
function section(p: Pen, f: Frame, top: number, { title, says, rows }: Section): Piece {
	const width = f.end - f.content;
	let svg = rule(p, f.content, top, width, 2);
	if (f.width < 840) {
		let y = top + 2 + 24;
		svg += line(p, f.content, y, "headline-medium", title);
		y += TYPE["headline-medium"].line + 8;
		const lead = paragraph(p, f.content, y, width, "body-medium", says, "on-surface-variant");
		svg += lead.svg;
		y += lead.height + 8;
		const list = facts(p, f.content, y, width, rows);
		return { svg: svg + list.svg, height: y + list.height - top };
	}
	const column = (width - 11 * 32) / 12;
	const margin = column * 4 + 3 * 32;
	const body = f.content + margin + 32;
	const y = top + 2 + 24;
	svg += line(p, f.content, y, "headline-medium", title);
	const lead = paragraph(
		p,
		f.content,
		y + TYPE["headline-medium"].line + 8,
		margin,
		"body-medium",
		says,
		"on-surface-variant",
	);
	const list = facts(p, body, top + 2 + 8, f.end - body, rows);
	return {
		svg: svg + lead.svg + list.svg,
		height: Math.max(2 + 8 + list.height, 2 + 24 + TYPE["headline-medium"].line + 8 + lead.height),
	};
}

// ---------------------------------------------------------------------------------
// The ledger: a sheet of rows with a figure at the end of each, as on the home page.
// ---------------------------------------------------------------------------------

interface LedgerRow {
	title: string | [string, string][];
	detail?: string;
	figure?: string;
	/** `menu` is the one button that opens a row's two or more actions. */
	action?: "menu" | { label: string; kind: ButtonKind };
}

interface Ledger {
	heading: string;
	note?: string;
	rows?: LedgerRow[];
	/** What an empty sheet says: what will be here and what makes the first one. */
	empty?: string;
}

function ledger(
	p: Pen,
	x: number,
	top: number,
	width: number,
	{ heading: title, note, rows = [], empty }: Ledger,
): Piece {
	const side = width < 384 ? 16 : 20;
	const inner = width - side * 2;
	// Where any row has an action, every row keeps its place, so the figures stay in
	// one column, and the word at the end of the heading line stands over them.
	const actions = rows.map(({ action }) =>
		!action ? 0 : action === "menu" ? 40 : buttonWidth(action.label, action.kind),
	);
	const place = Math.max(0, ...actions);
	const figures = x + width - side - (place ? place + 16 : 0);

	let y = top + 2 + 16;
	let svg = line(p, x + side, y, "label-large", title);
	if (note) {
		svg += line(p, figures, y, "label-large", note, {
			anchor: "end",
			fill: "on-surface-variant",
		});
	}
	y += TYPE["label-large"].line + 12;

	if (empty) {
		const says = paragraph(p, x + side, y, Math.min(inner, 640), "body-large", empty);
		svg += says.svg;
		y += says.height + 20;
	}

	rows.forEach((row, index) => {
		if (index > 0) svg += rule(p, x + side, y, inner, 1, "outline-variant");
		y += 12;
		svg += line(p, x + side, y, "body-large", row.title);
		let end = x + width - side;
		if (place) {
			const centre = y + TYPE["body-large"].line / 2;
			if (row.action === "menu") {
				svg += [-6, 0, 6]
					.map(
						(offset) =>
							`<circle cx="${end - 20}" cy="${centre + offset}" r="2" fill="${p.colour("on-surface-variant")}"/>`,
					)
					.join("");
			} else if (row.action) {
				svg += button(p, end, centre - BUTTON_HEIGHT / 2, row.action.label, row.action.kind, "end");
			}
			end -= place + 16;
		}
		if (row.figure) {
			svg += line(
				p,
				end,
				y + (TYPE["body-large"].line - TYPE["title-large"].line) / 2,
				"title-large",
				row.figure,
				{ anchor: "end" },
			);
		}
		y += TYPE["body-large"].line;
		if (row.detail) {
			svg += line(p, x + side, y, "body-medium", row.detail, { fill: "on-surface-variant" });
			y += TYPE["body-medium"].line;
		}
		y += 12;
	});

	const height = y + 2 - top;
	return {
		svg:
			`<rect x="${x + 1}" y="${top + 1}" width="${width - 2}" height="${height - 2}" rx="7" fill="${p.colour("surface")}" stroke="${p.colour("on-surface")}" stroke-width="2"/>` +
			svg,
		height,
	};
}

// ---------------------------------------------------------------------------------
// A field, and a sheet over the page.
// ---------------------------------------------------------------------------------

/** The filled field with the focus: its label above the value, a 2px line under, the help under that. */
function field(
	p: Pen,
	x: number,
	top: number,
	width: number,
	label: string,
	value: string,
	help?: string,
): Piece {
	return {
		svg:
			`<rect x="${x}" y="${top}" width="${width}" height="56" rx="2" fill="${p.colour("surface-container-highest")}"/>` +
			line(p, x + 16, top + 8, "body-small", label, { fill: "primary" }) +
			(value ? line(p, x + 16, top + 24, "body-large", value) : "") +
			`<rect x="${x + 16 + measure(value, "body-large") + 2}" y="${top + 27}" width="1.5" height="18" fill="${p.colour("primary")}"/>` +
			rule(p, x, top + 54, width, 2, "primary") +
			(help ? line(p, x + 16, top + 60, "body-small", help, { fill: "on-surface-variant" }) : ""),
		height: help ? 76 : 56,
	};
}

interface Sheet {
	title: string;
	says: string;
	field?: { label: string; value: string };
	cancel: string;
	confirm: { label: string; kind: ButtonKind };
}

/**
 * A sheet over the page: paper with a 2px ink rule along its top edge and, where
 * it does not span the window, down its sides; 8px corners at the top; no
 * shadow; the page behind it under the scrim.
 */
function sheet(p: Pen, f: Frame, { title, says, field: asks, cancel, confirm }: Sheet): string {
	const width = Math.min(f.width, 640);
	const x = (f.width - width) / 2;
	const inner = width - 48;
	const lead = paragraph(p, 0, 0, inner, "body-large", says, "on-surface-variant");
	const height =
		24 +
		TYPE["headline-small"].line +
		16 +
		lead.height +
		(asks ? 16 + 56 : 0) +
		24 +
		BUTTON_HEIGHT +
		24;
	const top = f.height - height;
	let y = top + 24;
	let svg =
		`<rect width="${f.width}" height="${f.height}" fill="${p.colour("scrim")}" opacity="0.32"/>` +
		`<path d="M${x} ${f.height}V${top + 8}a8 8 0 0 1 8-8H${x + width - 8}a8 8 0 0 1 8 8V${f.height}Z" fill="${p.colour("surface")}"/>` +
		(width < f.width
			? `<path d="M${x + 1} ${f.height}V${top + 9}a8 8 0 0 1 8-8H${x + width - 9}a8 8 0 0 1 8 8V${f.height}" fill="none" stroke="${p.colour("on-surface")}" stroke-width="2"/>`
			: rule(p, 0, top, width, 2));
	svg += line(p, x + 24, y, "headline-small", title);
	y += TYPE["headline-small"].line + 16;
	svg += paragraph(p, x + 24, y, inner, "body-large", says, "on-surface-variant").svg;
	y += lead.height;
	if (asks) {
		y += 16;
		svg += field(p, x + 24, y, inner, asks.label, asks.value).svg;
		y += 56;
	}
	y += 24;
	const end = x + width - 24;
	svg += button(p, end, y, confirm.label, confirm.kind, "end");
	svg += button(p, end - buttonWidth(confirm.label, confirm.kind) - 24, y, cancel, "text", "end");
	return svg;
}

// ---------------------------------------------------------------------------------
// The pages. Each draws one window.
// ---------------------------------------------------------------------------------

const ORGANISATION = "Harbour Studio";

type Page = (p: Pen, width: number, height: number) => string;

const SETTINGS: Section[] = [
	{
		title: "Organisation",
		says: `Shared by everyone in ${ORGANISATION}. You are an owner.`,
		rows: [
			{
				term: "Organisation name",
				value: ORGANISATION,
				action: { label: "Rename", kind: "outlined" },
			},
			{ term: "Members and invitations", link: true },
			{ term: "Create another organisation", link: true },
		],
	},
	{
		title: "Your account",
		says: "Yours alone. The same in every organisation you belong to.",
		rows: [
			{
				term: "Your name",
				value: "Ada Okafor",
				action: { label: "Change name", kind: "outlined" },
			},
			{ term: "Colour scheme", choices: ["Light", "Dark", "Match my device"] },
			{
				term: "Sign out",
				says: "You are signed in as ada@example.com. Signing out ends your session in this browser.",
				action: { label: "Sign out", kind: "outlined" },
			},
			{
				term: "Sign out everywhere",
				says: "Ends every session of your account, on every browser and device.",
				action: { label: "Sign out everywhere", kind: "outlined" },
			},
		],
	},
	{
		title: "Delete organisation",
		says: "Last on the page, under its own rule.",
		rows: [
			{
				term: `Delete ${ORGANISATION}`,
				says: "Removes the organisation, its members and its invitations for everyone. It cannot be undone.",
				action: { label: "Delete organisation", kind: "danger-text" },
			},
		],
	},
];

const settings: Page = (p, width, height) => {
	const f = frame(width, height, true);
	let y = f.top;
	const title = heading(p, f, y, "Settings");
	let svg = title.svg;
	y += title.height + 40;
	for (const each of SETTINGS) {
		const drawn = section(p, f, y, each);
		svg += drawn.svg;
		y += drawn.height + 40;
	}
	return svg + band(p, f, ORGANISATION) + navigation(p, f, "Settings");
};

const members: Page = (p, width, height) => {
	const f = frame(width, height, true);
	const list = Math.min(f.end - f.content, 768);
	let y = f.top;
	let svg = line(p, f.content, y, "label-large", "Settings", { underline: true });
	y += TYPE["label-large"].line + 8;
	const title = heading(p, f, y, "Members");
	svg += title.svg;
	y += title.height + 8;
	const lead = paragraph(
		p,
		f.content,
		y,
		Math.min(list, 640),
		"body-large",
		`The people in ${ORGANISATION} and what each of them may do.`,
		"on-surface-variant",
	);
	svg += lead.svg;
	y += lead.height + 24;
	svg += button(p, f.content, y, "Invite a person", "filled");
	y += BUTTON_HEIGHT + 24;
	const people = ledger(p, f.content, y, list, {
		heading: "Members",
		note: "3",
		rows: [
			{
				title: [
					["Ada Okafor", "on-surface"],
					[" (you)", "on-surface-variant"],
				],
				detail: "ada@example.com",
				figure: "Owner",
			},
			{ title: "Tomás Reyes", detail: "tomas@example.com", figure: "Admin", action: "menu" },
			{ title: "Mei Lindqvist", detail: "mei@example.com", figure: "Member", action: "menu" },
		],
	});
	svg += people.svg;
	y += people.height + 40;
	const waiting = ledger(p, f.content, y, list, {
		heading: "Invitations not yet accepted",
		note: "Expires",
		rows: [
			{
				title: "sam@example.com",
				detail: "Invited as a member",
				figure: "18 Nov",
				action: { label: "Cancel", kind: "outlined" },
			},
		],
	});
	svg += waiting.svg;
	y += waiting.height + 40;
	svg += rule(p, f.content, y, list, 2);
	y += 2 + 24;
	svg += line(p, f.content, y, "headline-medium", "Leave organisation");
	return svg + band(p, f, ORGANISATION) + navigation(p, f, "Settings");
};

const today: Page = (p, width, height) => {
	const f = frame(width, height, true);
	const list = Math.min(f.end - f.content, 768);
	let y = f.top;
	const title = heading(p, f, y, "Today");
	let svg = title.svg;
	y += title.height + 8;
	svg += line(p, f.content, y, "title-large", "Wednesday 11 November");
	y += TYPE["title-large"].line + 40;
	svg += ledger(p, f.content, y, list, {
		heading: "Entries",
		empty: "Your running timer and the entries you track today will appear here.",
	}).svg;
	return svg + band(p, f, ORGANISATION) + navigation(p, f, "Today");
};

const create: Page = (p, width, height) => {
	const f = frame(width, height, false);
	const column = Math.min(f.end - f.start, 480);
	let y = f.top;
	const title = heading(p, f, y, "Create your organisation");
	let svg = title.svg;
	y += title.height + 16;
	const lead = paragraph(
		p,
		f.start,
		y,
		Math.min(f.end - f.start, 640),
		"body-large",
		"An organisation holds the projects and tracked time of the people who work together. You will be its owner, and you can invite the others once it exists.",
		"on-surface-variant",
	);
	svg += lead.svg;
	y += lead.height + 40;
	const name = field(
		p,
		f.start,
		y,
		column,
		"Organisation name *",
		"Harbour Stu",
		"Your company, team or household. You can change it later.",
	);
	svg += name.svg;
	y += name.height + 24;
	svg += button(p, f.start, y, "Create the organisation", "filled");

	// Who is signed in and the way out: the foot of a page that is in no organisation.
	const foot = f.height - (f.compact ? 32 : 48) - BUTTON_HEIGHT - 28;
	svg += rule(p, f.start, foot - 16, f.end - f.start, 1, "outline-variant");
	svg += line(p, f.start, foot, "body-medium", [
		["Signed in as ", "on-surface-variant"],
		["ada@example.com", "on-surface"],
	]);
	svg += button(p, f.start, foot + 24, "Use a different email", "text");
	return svg + band(p, f);
};

const notFound: Page = (p, width, height) => {
	const f = frame(width, height, false);
	let y = f.top;
	const title = heading(p, f, y, "Page not found");
	let svg = title.svg;
	y += title.height + 16;
	const says = paragraph(
		p,
		f.start,
		y,
		Math.min(f.end - f.start, 640),
		"body-large",
		"There is no page at this address, or it is not yours to open.",
	);
	svg += says.svg;
	y += says.height + 24;
	svg += line(p, f.start, y, "body-large", "Your organisations", { underline: true });
	return svg + band(p, f);
};

/** A page with a sheet open over it. */
const under =
	(page: Page, over: Sheet): Page =>
	(p, width, height) =>
		page(p, width, height) + sheet(p, frame(width, height, true), over);

const RENAME: Sheet = {
	title: "Rename the organisation",
	says: "Everyone in the organisation sees the new name. Its address stays the same.",
	field: { label: "Organisation name *", value: ORGANISATION },
	cancel: "Cancel",
	confirm: { label: "Save", kind: "filled" },
};

const REMOVE: Sheet = {
	title: "Remove Mei Lindqvist?",
	says: `They stop being a member of ${ORGANISATION} and can no longer open it. Their account stays, and you can invite them again.`,
	cancel: "Cancel",
	confirm: { label: "Remove", kind: "danger-filled" },
};

// ---------------------------------------------------------------------------------
// The drawings: windows on a board, each with a line saying what it is.
// ---------------------------------------------------------------------------------

interface Window {
	page: Page;
	width: number;
	height: number;
	says: string;
}

const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };
const MARGIN = 24;
const CAPTION = 36;

function drawing(title: string, scheme: Scheme, windows: Window[]): string {
	const p = pen(scheme);
	const width = MARGIN + windows.reduce((sum, each) => sum + each.width + MARGIN, 0);
	const height = MARGIN + Math.max(...windows.map((each) => each.height)) + CAPTION + MARGIN / 2;
	let x = MARGIN;
	const body = windows.map((each, index) => {
		const clip = `window-${index}`;
		const drawn =
			`<clipPath id="${clip}"><rect width="${each.width}" height="${each.height}"/></clipPath>` +
			`<g transform="translate(${x} ${MARGIN})">` +
			`<g clip-path="url(#${clip})"><rect width="${each.width}" height="${each.height}" fill="${p.colour("surface")}"/>` +
			`${each.page(p, each.width, each.height)}</g>` +
			line(p, 0, each.height + 12, "label-large", each.says, { fill: "on-surface-variant" }) +
			"</g>";
		x += each.width + MARGIN;
		return drawn;
	});
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title">` +
		`<title id="title">${escapeSvgText(title)}</title><style>${STYLE}</style>` +
		`<rect width="${width}" height="${height}" fill="${p.colour("surface-container-high")}"/>` +
		`${body.join("")}</svg>\n`
	);
}

const at = (page: Page, size: { width: number; height: number }, says: string): Window => ({
	page,
	...size,
	says,
});

const DRAWINGS: { name: string; title: string; scheme: Scheme; windows: Window[] }[] = [
	{
		name: "signed-in-shell-390",
		title: "The signed-in shell under 600px: Settings in a window 390px wide",
		scheme: "light",
		windows: [at(settings, NARROW, "The shell at 390px: Settings")],
	},
	{
		name: "signed-in-shell-1280",
		title: "The signed-in shell from 600px: Settings in a window 1280px wide",
		scheme: "light",
		windows: [at(settings, WIDE, "The shell at 1280px: Settings")],
	},
	{
		name: "signed-in-shell-1280-dark",
		title: "The signed-in shell in the dark scheme: Settings in a window 1280px wide",
		scheme: "dark",
		windows: [at(settings, WIDE, "The shell at 1280px, dark scheme: Settings")],
	},
	{
		name: "signed-in-form",
		title: "A form page: creating an organisation, at 1280px and at 390px",
		scheme: "light",
		windows: [
			at(create, WIDE, "A form page at 1280px: creating an organisation"),
			at(create, NARROW, "At 390px"),
		],
	},
	{
		name: "signed-in-list",
		title: "A list page: members and invitations, at 1280px and at 390px",
		scheme: "light",
		windows: [at(members, WIDE, "A list page at 1280px: Members"), at(members, NARROW, "At 390px")],
	},
	{
		name: "signed-in-empty",
		title: "An empty state: Today before the timer is built, at 1280px and at 390px",
		scheme: "light",
		windows: [at(today, WIDE, "An empty state at 1280px: Today"), at(today, NARROW, "At 390px")],
	},
	{
		name: "signed-in-error",
		title: "An error state: page not found, at 1280px and at 390px",
		scheme: "light",
		windows: [
			at(notFound, WIDE, "An error state at 1280px: not found"),
			at(notFound, NARROW, "At 390px"),
		],
	},
	{
		name: "signed-in-sheet",
		title: "A sheet over the page: a short form at 1280px and a confirmation at 390px",
		scheme: "light",
		windows: [
			at(under(settings, RENAME), WIDE, "A sheet at 1280px: a short form"),
			at(under(members, REMOVE), NARROW, "At 390px: a confirmation that removes"),
		],
	},
];

mkdirSync(OUT, { recursive: true });
for (const { name, title, scheme, windows } of DRAWINGS) {
	writeFileSync(`${OUT}${name}.svg`, drawing(title, scheme, windows));
	console.log(`Wrote docs/design/${name}.svg`);
}
