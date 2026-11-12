// Generates the files that carry the product's mark: under public/, the mark
// itself, the favicon in its three formats, the icons a phone or a manifest asks
// for, and the manifest; under app/brand/, the PNGs every email and export carries
// when the platform's brand has none of its own (TS-100). Run with `pnpm icons`
// and commit what it writes. It draws from the outlines in
// app/components/mark-paths.ts and needs `resvg` (brew install resvg) to turn a
// drawing into pixels.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	MARK_ARROW,
	MARK_BAR,
	MARK_HEIGHT,
	MARK_STEM,
	MARK_WIDTH,
} from "../app/components/mark-paths.ts";

/**
 * The mark's two colours, sampled from the owner's file: the median pixel of the T
 * and of the arrowhead. They are here and not beside the outlines because a raw
 * colour under app/ fails `pnpm check:tokens`; in a page the mark takes its colours
 * from the tokens, and only the files this script writes need them as values.
 */
export const MARK_CHARCOAL = "#252A2F";
export const MARK_AMBER = "#FEAD05";

/** The T on the charcoal tile. */
const TILE_FOREGROUND = "#FFFFFF";

/** The tile the mark sits on in every icon: the side and corner radius of its viewBox. */
const TILE_SIDE = 64;
const TILE_CORNER = 14;

/** How much of the tile's width the mark takes. */
const MARK_SHARE = 0.62;

const NAME = "Timesifier";
const PUBLIC = new URL("../public/", import.meta.url);
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The mark alone. In a page it takes the text colour and the accent role; opened
 * on its own it is black with the sampled amber.
 */
const MARK_SVG = `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 ${MARK_WIDTH} ${MARK_HEIGHT}">
	<title>${NAME}</title>
	<path fill="currentColor" d="${MARK_BAR}"/>
	<path fill="currentColor" d="${MARK_STEM}"/>
	<path fill="var(--md-sys-color-primary-container, ${MARK_AMBER})" d="${MARK_ARROW}"/>
</svg>
`;

/**
 * The mark alone in fixed colours, for a file that cannot take the page's: the T
 * in `foreground` and the arrowhead in amber, on nothing.
 */
function markSvg(foreground: string): string {
	return `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 ${MARK_WIDTH} ${MARK_HEIGHT}">
	<path fill="${foreground}" d="${MARK_BAR}"/>
	<path fill="${foreground}" d="${MARK_STEM}"/>
	<path fill="${MARK_AMBER}" d="${MARK_ARROW}"/>
</svg>
`;
}

/** How tall the mark is drawn where a message or a document shows it, in CSS pixels. */
const MARK_SHOWN_HEIGHT = 24;
/** How wide the logo tile is drawn at the top of a message, in CSS pixels. */
const LOGO_SHOWN_SIDE = 28;

/**
 * The mark centred on the charcoal tile. `corner` is the tile's corner radius:
 * zero for the icon iOS rounds itself, which must fill its square.
 */
function tileSvg(corner: number): string {
	const scale = Number(((TILE_SIDE * MARK_SHARE) / MARK_WIDTH).toFixed(5));
	const x = Number(((TILE_SIDE - MARK_WIDTH * scale) / 2).toFixed(2));
	const y = Number(((TILE_SIDE - MARK_HEIGHT * scale) / 2).toFixed(2));
	const rounding = corner > 0 ? ` rx="${corner}"` : "";

	return `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 ${TILE_SIDE} ${TILE_SIDE}">
	<title>${NAME}</title>
	<rect width="${TILE_SIDE}" height="${TILE_SIDE}"${rounding} fill="${MARK_CHARCOAL}"/>
	<g transform="translate(${x} ${y}) scale(${scale})" fill="${TILE_FOREGROUND}">
		<path d="${MARK_BAR}"/>
		<path d="${MARK_STEM}"/>
		<path fill="${MARK_AMBER}" d="${MARK_ARROW}"/>
	</g>
</svg>
`;
}

/** A drawing as a PNG `width` by `height` pixels, made by resvg. */
function rasterise(svg: string, width: number, height = width): Buffer {
	const result = spawnSync(
		"resvg",
		["--width", String(width), "--height", String(height), "--resources-dir", ".", "-", "-c"],
		{ input: svg, maxBuffer: 16 * 1024 * 1024 },
	);
	if (result.error) {
		const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
		throw new Error(
			missing
				? "resvg is not installed. Install it (brew install resvg) and run `pnpm icons` again."
				: `resvg could not be run: ${result.error.message}`,
		);
	}
	if (result.status !== 0) {
		throw new Error(`resvg failed at ${width}px: ${result.stderr.toString().trim()}`);
	}
	return result.stdout;
}

/**
 * An ICO file holding the given PNG images. The container is written by hand, as it
 * is small: a 6-byte header, one 16-byte directory entry per image, then the images.
 */
function ico(images: { size: number; png: Buffer }[]): Buffer {
	const HEADER_BYTES = 6;
	const ENTRY_BYTES = 16;

	const header = Buffer.alloc(HEADER_BYTES);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // 1 says icon, 2 would say cursor
	header.writeUInt16LE(images.length, 4);

	let offset = HEADER_BYTES + ENTRY_BYTES * images.length;
	const entries = images.map(({ size, png }) => {
		const entry = Buffer.alloc(ENTRY_BYTES);
		// A width or height of 256 is written as 0; every other size is itself.
		entry.writeUInt8(size % 256, 0);
		entry.writeUInt8(size % 256, 1);
		entry.writeUInt8(0, 2); // no colour palette
		entry.writeUInt8(0, 3); // reserved
		entry.writeUInt16LE(1, 4); // colour planes
		entry.writeUInt16LE(32, 6); // bits per pixel
		entry.writeUInt32LE(png.length, 8);
		entry.writeUInt32LE(offset, 12);
		offset += png.length;
		return entry;
	});

	return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

const MANIFEST = `${JSON.stringify(
	{
		name: NAME,
		short_name: NAME,
		icons: [192, 512].map((size) => ({
			src: `/icon-${size}.png`,
			sizes: `${size}x${size}`,
			type: "image/png",
		})),
		theme_color: MARK_AMBER,
		background_color: MARK_CHARCOAL,
		display: "browser",
		start_url: "/",
	},
	null,
	"\t",
)}\n`;

/**
 * The built-in images of the platform's brand, at twice the size they are shown
 * so they are sharp on every screen, as base64 PNGs in a module the Worker
 * bundles: the logo, the charcoal tile a message carries at its top, and the
 * mark for light and for dark grounds.
 */
function builtInImages(): string {
	const markHeight = MARK_SHOWN_HEIGHT * 2;
	const markWidth = Math.round((MARK_WIDTH / MARK_HEIGHT) * markHeight);
	const logoSide = LOGO_SHOWN_SIDE * 2;
	const images = {
		logo: { png: rasterise(tileSvg(TILE_CORNER), logoSide), width: logoSide, height: logoSide },
		markLight: {
			png: rasterise(markSvg(MARK_CHARCOAL), markWidth, markHeight),
			width: markWidth,
			height: markHeight,
		},
		markDark: {
			png: rasterise(markSvg(TILE_FOREGROUND), markWidth, markHeight),
			width: markWidth,
			height: markHeight,
		},
	};
	const entries = Object.entries(images).map(
		([name, { png, width, height }]) =>
			`\t${name}: {\n\t\twidth: ${width},\n\t\theight: ${height},\n\t\tbase64:\n\t\t\t"${png.toString("base64")}",\n\t},`,
	);
	return `// Generated by scripts/icons.ts. Do not edit: change the drawing there and run \`pnpm icons\`.

/** The platform brand's built-in PNGs, each at twice the size it is shown (TS-100). */
export const BUILT_IN_IMAGES = {
${entries.join("\n")}
} as const;
`;
}

function generate(): void {
	const rounded = tileSvg(TILE_CORNER);
	const files: [string, string | Buffer][] = [
		["mark.svg", MARK_SVG],
		["favicon.svg", rounded],
		["apple-touch-icon.png", rasterise(tileSvg(0), 180)],
		["icon-192.png", rasterise(rounded, 192)],
		["icon-512.png", rasterise(rounded, 512)],
		["favicon.ico", ico([16, 32, 48].map((size) => ({ size, png: rasterise(rounded, size) })))],
		["site.webmanifest", MANIFEST],
	];
	for (const [name, content] of files) {
		writeFileSync(new URL(name, PUBLIC), content);
		console.log(`Wrote public/${name}`);
	}
	writeFileSync(new URL("../app/brand/built-in-images.ts", import.meta.url), builtInImages());
	console.log("Wrote app/brand/built-in-images.ts");
}

// Only when run as the command: a module that imports the colours above must not
// rewrite the icons, nor need resvg.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		generate();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
