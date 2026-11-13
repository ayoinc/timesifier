import { describe, expect, it } from "vitest";
import {
	deflate,
	EXTENSIONS,
	fromBase64,
	imageSize,
	imageTypeOf,
	jpegSpace,
	pngPixels,
	svgProblem,
	toBase64,
} from "~/brand/images";
import { jpeg, png, pngOf, svg, webp } from "./files";

// What the brand knows of an image file from its bytes alone (TS-100): its
// kind, its size, whether an SVG could do more than draw, and a PNG's pixels
// as a PDF draws them.

const TEXT = new TextEncoder();

/** `bytes` with the byte at `at` set to `value`. */
function patched(bytes: Uint8Array<ArrayBuffer>, at: number, value: number) {
	const copy = bytes.slice();
	copy[at] = value;
	return copy;
}

/** Where the JPEG helper writes its number of components: after SOI (2), APP0 (18) and nine bytes of the frame. */
const JPEG_COMPONENTS = 2 + 18 + 9;

describe("imageTypeOf", () => {
	it("judges each kind by its first bytes, whatever it is called", async () => {
		expect(imageTypeOf(await png(16, 16))).toBe("image/png");
		expect(imageTypeOf(jpeg(16, 16))).toBe("image/jpeg");
		expect(imageTypeOf(webp(16, 16))).toBe("image/webp");
		expect(imageTypeOf(svg())).toBe("image/svg+xml");
	});

	it.each([
		["a byte-order mark and white space", "\uFEFF  \n<svg/>"],
		["a comment before the root", "<!-- drawn by hand -->\n<svg></svg>"],
		["an XML declaration and a comment", '<?xml version="1.0" encoding="UTF-8"?><!-- a --><SVG/>'],
	])("takes an SVG after %s", (_, text) => {
		expect(imageTypeOf(TEXT.encode(text))).toBe("image/svg+xml");
	});

	it.each([
		["text", TEXT.encode("hello")],
		["HTML holding an SVG", TEXT.encode("<html><svg></svg></html>")],
		["a GIF", TEXT.encode("GIF89a")],
		["a RIFF that is not a WebP", TEXT.encode("RIFF\0\0\0\0WAVEfmt ")],
		["bytes that are not UTF-8", new Uint8Array([0xc3, 0x28, 0x3c, 0x73, 0x76, 0x67])],
		["nothing", new Uint8Array()],
		["half a PNG signature", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
	])("refuses %s", (_, bytes) => {
		expect(imageTypeOf(bytes)).toBeNull();
	});

	it("names a file of each kind with its extension", () => {
		expect(EXTENSIONS).toEqual({
			"image/png": "png",
			"image/jpeg": "jpg",
			"image/webp": "webp",
			"image/svg+xml": "svg",
		});
	});
});

describe("imageSize", () => {
	it("reads each kind's width and height from its own bytes", async () => {
		expect(imageSize(await png(300, 17), "image/png")).toEqual({ width: 300, height: 17 });
		expect(imageSize(jpeg(1024, 768), "image/jpeg")).toEqual({ width: 1024, height: 768 });
		expect(imageSize(webp(2048, 1), "image/webp")).toEqual({ width: 2048, height: 1 });
		expect(imageSize(svg(), "image/svg+xml")).toEqual({ width: 120, height: 40 });
	});

	it.each([
		['width="64px" height="32"', { width: 64, height: 32 }],
		['width="100%" height="100%" viewBox="0 0 90 30"', { width: 90, height: 30 }],
		['viewBox="0,0,48.5,12"', { width: 48.5, height: 12 }],
		['width="2em" height="1em"', null],
		['viewBox="0 0 0 10"', null],
		["", null],
	])("an SVG with %s is %o", (attributes, size) => {
		expect(imageSize(TEXT.encode(`<svg ${attributes}></svg>`), "image/svg+xml")).toEqual(size);
	});

	it("is null for a PNG of no pixels, or bytes too short to say", async () => {
		expect(imageSize(await png(0, 10), "image/png")).toBeNull();
		expect(imageSize((await png(16, 16)).subarray(0, 12), "image/png")).toBeNull();
		expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")).toBeNull();
	});
});

describe("svgProblem", () => {
	it("finds nothing in a drawing that only draws, nor in an address of its own fragment", () => {
		expect(svgProblem(svg())).toBeNull();
		expect(
			svgProblem(
				svg(
					'<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/><use xlink:href="#g"/><style>rect{fill:#000}</style>',
				),
			),
		).toBeNull();
	});

	it.each([
		["<script>alert(1)</script>", "it holds a script"],
		["<SCRIPT >alert(1)</SCRIPT>", "it holds a script"],
		["<foreignObject><div/></foreignObject>", "it embeds another document"],
		['<iframe src="x"/>', "it embeds another document"],
		['<set attributeName="href" to="x"/>', "it animates"],
		['<animate attributeName="x"/>', "it animates"],
		['<rect onclick="x()"/>', "it handles events"],
		['<rect ONLOAD = "x()"/>', "it handles events"],
		['<?xml-stylesheet href="x.css"?>', "it holds a processing instruction"],
		["<style>@import 'x.css';</style>", "it imports a style sheet"],
		['<a href="java\nscript:alert(1)"/>', "it holds a script address"],
		['<image href="data:image/png;base64,AAAA"/>', "it holds a script address"],
		['<image href="https://tracker.example/p.png"/>', "it refers to another file"],
		['<use xlink:href="other.svg#a"/>', "it refers to another file"],
		['<rect style="fill:url(https://tracker.example/p)"/>', "it refers to another file"],
		["<rect style=\"fill:url('//tracker.example/p')\"/>", "it refers to another file"],
	])("refuses %s: %s", (inside, problem) => {
		expect(svgProblem(svg(inside))).toBe(problem);
	});

	it("refuses a document type, and bytes that are not text", () => {
		expect(svgProblem(TEXT.encode('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'))).toBe(
			"it declares a document type",
		);
		expect(svgProblem(new Uint8Array([0x3c, 0x73, 0xff, 0xfe]))).toBe("it is not text");
	});
});

describe("base64", () => {
	it("carries every byte there and back, past the size written in one piece", () => {
		const bytes = new Uint8Array(0x8000 * 2 + 3).map((_, at) => (at * 7) & 0xff);
		const text = toBase64(bytes);
		expect(text).toMatch(/^[A-Za-z0-9+/]+=*$/);
		expect(fromBase64(text)).toEqual(bytes);
		expect(toBase64(new Uint8Array())).toBe("");
		expect(toBase64(TEXT.encode("Man"))).toBe("TWFu");
	});
});

describe("deflate", () => {
	it("writes a zlib stream that inflates to what went in", async () => {
		const bytes = TEXT.encode("Timesifier ".repeat(500));
		const compressed = await deflate(bytes);
		expect(compressed[0]).toBe(0x78);
		expect(compressed.length).toBeLessThan(bytes.length);
		const inflated = new Uint8Array(
			await new Response(
				new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate")),
			).arrayBuffer(),
		);
		expect(inflated).toEqual(bytes);
	});
});

/** The predictor of PNG's fifth filter (RFC 2083, 6.6). */
function paeth(left: number, up: number, upLeft: number) {
	const guess = left + up - upLeft;
	const [a, b, c] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - upLeft)];
	return a <= b && a <= c ? left : b <= c ? up : upLeft;
}

/** Grey `rows`, one byte a pixel, each written with the filter of its own index (0 to 4). */
function filtered(rows: number[][]): Uint8Array {
	const out: number[] = [];
	rows.forEach((row, y) => {
		const filter = y % 5;
		out.push(filter);
		row.forEach((value, x) => {
			const left = x > 0 ? (row[x - 1] as number) : 0;
			const up = y > 0 ? (rows[y - 1]?.[x] as number) : 0;
			const upLeft = y > 0 && x > 0 ? (rows[y - 1]?.[x - 1] as number) : 0;
			const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter] as number;
			out.push((value - predicted + 256) & 0xff);
		});
	});
	return new Uint8Array(out);
}

describe("pngPixels", () => {
	it("gives an opaque RGBA PNG's colour, and no alpha", async () => {
		const pixels = await pngPixels(await png(2, 2, { rgba: [29, 78, 216, 255] }));
		expect(pixels).toEqual({
			width: 2,
			height: 2,
			space: "DeviceRGB",
			colour: new Uint8Array([29, 78, 216, 29, 78, 216, 29, 78, 216, 29, 78, 216]),
			alpha: null,
		});
	});

	it("keeps a translucent PNG's alpha apart from its colour", async () => {
		const pixels = await pngPixels(await png(1, 2, { rgba: [10, 20, 30, 128] }));
		expect(pixels?.colour).toEqual(new Uint8Array([10, 20, 30, 10, 20, 30]));
		expect(pixels?.alpha).toEqual(new Uint8Array([128, 128]));
	});

	it("undoes all five filters", async () => {
		const rows = [
			[0, 50, 255],
			[10, 60, 250],
			[200, 1, 128],
			[3, 99, 77],
			[255, 255, 0],
			[17, 34, 51],
		];
		const pixels = await pngPixels(
			await pngOf({ width: 3, height: rows.length, kind: 0, raw: filtered(rows) }),
		);
		expect(pixels?.space).toBe("DeviceGray");
		expect(pixels?.alpha).toBeNull();
		expect([...(pixels?.colour ?? [])]).toEqual(rows.flat());
	});

	it("reads grey with alpha, and a palette with its transparency", async () => {
		const greyAlpha = await pngPixels(
			await pngOf({ width: 2, height: 1, kind: 4, raw: new Uint8Array([0, 40, 255, 90, 0]) }),
		);
		expect(greyAlpha?.colour).toEqual(new Uint8Array([40, 90]));
		expect(greyAlpha?.alpha).toEqual(new Uint8Array([255, 0]));

		const palette = await pngPixels(
			await pngOf({
				width: 3,
				height: 1,
				kind: 3,
				raw: new Uint8Array([0, 0, 1, 2]),
				chunks: [
					["PLTE", new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255])],
					["tRNS", new Uint8Array([0])],
				],
			}),
		);
		expect(palette?.space).toBe("DeviceRGB");
		expect(palette?.colour).toEqual(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]));
		// Entries past the transparency chunk are opaque.
		expect(palette?.alpha).toEqual(new Uint8Array([0, 255, 255]));
	});

	it.each([
		["sixteen bits a sample", { depth: 16 }],
		["interlaced", { interlace: 1 }],
		["a palette without its palette", { kind: 3 }],
		["an unknown colour type", { kind: 5 }],
	])("is null for a PNG %s", async (_, change) => {
		const bytes = await pngOf({
			width: 1,
			height: 1,
			kind: 6,
			raw: new Uint8Array([0, 1, 2, 3, 4]),
			...change,
		});
		expect(await pngPixels(bytes)).toBeNull();
	});

	it("is null for what is not a PNG, pixels that do not inflate, or too few of them", async () => {
		expect(await pngPixels(jpeg(16, 16))).toBeNull();
		const short = await pngOf({ width: 4, height: 4, kind: 6, raw: new Uint8Array([0, 1, 2]) });
		expect(await pngPixels(short)).toBeNull();
		const whole = await png(4, 4);
		// Spoil the compressed pixels: the IDAT chunk follows the 8-byte signature and the 25-byte header.
		expect(await pngPixels(patched(whole, 8 + 25 + 8, 0xff))).toBeNull();
	});
});

describe("jpegSpace", () => {
	it("is RGB for three components, grey for one, and null for CMYK", () => {
		const colour = jpeg(16, 16);
		expect(jpegSpace(colour)).toBe("DeviceRGB");
		expect(jpegSpace(patched(colour, JPEG_COMPONENTS, 1))).toBe("DeviceGray");
		expect(jpegSpace(patched(colour, JPEG_COMPONENTS, 4))).toBeNull();
	});
});
