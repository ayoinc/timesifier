/**
 * What the brand needs to know of an image file without drawing it (TS-100):
 * its kind, judged by its first bytes and never by a name or a declared type;
 * its size in pixels; whether an SVG could do anything but draw; and, for a
 * PDF, a PNG's pixels. Nothing here trusts the file it is given.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";

/** The extension a file of each kind is named with. */
export const EXTENSIONS: Record<ImageType, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
	return prefix.every((byte, index) => bytes[at + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** The text of an SVG file, or null where the bytes are not UTF-8. */
function svgText(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Where an SVG's root element opens: after a byte-order mark, white space, an XML declaration and comments. */
const SVG_START = /^\uFEFF?\s*(?:<\?xml\b[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i;

/** The kind of image `bytes` hold, from their first bytes; null for anything else. */
export function imageTypeOf(bytes: Uint8Array): ImageType | null {
	if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
	const text = svgText(bytes.subarray(0, 4096));
	if (text !== null && SVG_START.test(text)) return "image/svg+xml";
	return null;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A PNG's size, from its first chunk, which must be its header. */
function pngSize(bytes: Uint8Array) {
	if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
	const data = view(bytes);
	return { width: data.getUint32(16), height: data.getUint32(20) };
}

/** A JPEG's size, from its first start-of-frame marker. */
function jpegSize(bytes: Uint8Array) {
	const data = view(bytes);
	let at = 2;
	while (at + 9 < bytes.length) {
		if (bytes[at] !== 0xff) return null;
		const marker = bytes[at + 1] as number;
		// Fill bytes, and the markers that carry no length.
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			at += 2;
			continue;
		}
		const length = data.getUint16(at + 2);
		// Every start of frame but DHT (C4), JPG (C8) and DAC (CC).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return {
				height: data.getUint16(at + 5),
				width: data.getUint16(at + 7),
				components: bytes[at + 9] as number,
			};
		}
		at += 2 + length;
	}
	return null;
}

/** A WebP's size, from its first chunk: lossy, lossless or extended. */
function webpSize(bytes: Uint8Array) {
	if (bytes.length < 30) return null;
	const data = view(bytes);
	const chunk = ascii(bytes, 12, 4);
	if (chunk === "VP8 ") {
		return { width: data.getUint16(26, true) & 0x3fff, height: data.getUint16(28, true) & 0x3fff };
	}
	if (chunk === "VP8L") {
		const bits = data.getUint32(21, true);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	if (chunk === "VP8X") {
		const width =
			1 + ((bytes[24] as number) | ((bytes[25] as number) << 8) | ((bytes[26] as number) << 16));
		const height =
			1 + ((bytes[27] as number) | ((bytes[28] as number) << 8) | ((bytes[29] as number) << 16));
		return { width, height };
	}
	return null;
}

/** An SVG's size: its width and height in pixels, or else its view box. */
function svgSize(bytes: Uint8Array) {
	const text = svgText(bytes);
	const root = text?.match(/<svg\b[^>]*>/i)?.[0];
	if (!root) return null;
	const attribute = (name: string) =>
		root.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1]?.trim();
	const pixels = (value: string | undefined) => {
		const match = value?.match(/^(\d+(?:\.\d+)?)(?:px)?$/);
		return match ? Number(match[1]) : null;
	};
	const width = pixels(attribute("width"));
	const height = pixels(attribute("height"));
	if (width && height) return { width, height };
	const box = attribute("viewBox")
		?.split(/[\s,]+/)
		.map(Number);
	if (
		box?.length === 4 &&
		box.every(Number.isFinite) &&
		(box[2] as number) > 0 &&
		(box[3] as number) > 0
	) {
		return { width: box[2] as number, height: box[3] as number };
	}
	return null;
}

/** How many pixels wide and tall an image is, or null where its own bytes do not say. */
export function imageSize(
	bytes: Uint8Array,
	type: ImageType,
): { width: number; height: number } | null {
	const size =
		type === "image/png"
			? pngSize(bytes)
			: type === "image/jpeg"
				? jpegSize(bytes)
				: type === "image/webp"
					? webpSize(bytes)
					: svgSize(bytes);
	return size && size.width > 0 && size.height > 0
		? { width: size.width, height: size.height }
		: null;
}

/**
 * What in an SVG could do more than draw, or null when there is nothing. An
 * SVG with any of these is refused, not cleaned: a script, an element that
 * embeds another document, an animation (which can rewrite a link), an event
 * handler, a document type or entity, a style sheet's import, and any address
 * but a fragment of the file itself, so nothing is fetched either.
 */
export function svgProblem(bytes: Uint8Array): string | null {
	const text = svgText(bytes);
	if (text === null) return "it is not text";
	const lower = text.toLowerCase();
	if (/<script\b/.test(lower)) return "it holds a script";
	if (/<(?:foreignobject|iframe|embed|object|audio|video|canvas|handler|listener)\b/.test(lower)) {
		return "it embeds another document";
	}
	if (/<(?:set|animate|animatemotion|animatetransform|animatecolor)\b/.test(lower)) {
		return "it animates";
	}
	if (/\son[a-z]+\s*=/.test(lower)) return "it handles events";
	if (/<!(?:doctype|entity)\b/.test(lower)) return "it declares a document type";
	if (/<\?(?!xml\s)/.test(lower)) return "it holds a processing instruction";
	if (/@import\b/.test(lower)) return "it imports a style sheet";
	if (/javascript:|vbscript:|data:/.test(lower.replace(/\s+/g, "")))
		return "it holds a script address";
	for (const [, address = ""] of lower.matchAll(/\s(?:xlink:)?href\s*=\s*["']([^"']*)["']/g)) {
		if (!address.trim().startsWith("#")) return "it refers to another file";
	}
	for (const [, address = ""] of lower.matchAll(/url\(\s*["']?([^"')]*)/g)) {
		if (!address.trim().startsWith("#")) return "it refers to another file";
	}
	return null;
}

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
	return bytes;
}

async function through(
	bytes: Uint8Array,
	stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
	const out = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
	return new Uint8Array(await new Response(out).arrayBuffer());
}

/** `bytes` compressed as a zlib stream, which a PDF's FlateDecode reads. */
export function deflate(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	return through(bytes, new CompressionStream("deflate"));
}

/** A PNG's pixels, as a PDF draws them: its colour samples and, apart, its alpha. */
export interface Pixels {
	width: number;
	height: number;
	/** `DeviceRGB` or `DeviceGray` samples, eight bits each, row after row. */
	colour: Uint8Array;
	space: "DeviceRGB" | "DeviceGray";
	/** One byte of opacity a pixel, or null where the image is opaque throughout. */
	alpha: Uint8Array | null;
}

function paeth(left: number, up: number, upLeft: number): number {
	const estimate = left + up - upLeft;
	const toLeft = Math.abs(estimate - left);
	const toUp = Math.abs(estimate - up);
	const toUpLeft = Math.abs(estimate - upLeft);
	if (toLeft <= toUp && toLeft <= toUpLeft) return left;
	return toUp <= toUpLeft ? up : upLeft;
}

/**
 * The pixels of a PNG of eight bits a sample, not interlaced, in grey, colour
 * or a palette, with or without alpha: what a browser's canvas writes and most
 * logos are. Null for any other PNG, which a PDF then shows without its image.
 */
export async function pngPixels(bytes: Uint8Array): Promise<Pixels | null> {
	if (!startsWith(bytes, PNG_SIGNATURE)) return null;
	const data = view(bytes);
	let at = 8;
	let header: {
		width: number;
		height: number;
		depth: number;
		kind: number;
		interlace: number;
	} | null = null;
	let palette: Uint8Array | null = null;
	let transparency: Uint8Array | null = null;
	const compressed: Uint8Array[] = [];
	while (at + 8 <= bytes.length) {
		const length = data.getUint32(at);
		const name = ascii(bytes, at + 4, 4);
		const body = bytes.subarray(at + 8, at + 8 + length);
		if (name === "IHDR") {
			header = {
				width: data.getUint32(at + 8),
				height: data.getUint32(at + 12),
				depth: bytes[at + 16] as number,
				kind: bytes[at + 17] as number,
				interlace: bytes[at + 20] as number,
			};
		} else if (name === "PLTE") palette = body;
		else if (name === "tRNS") transparency = body;
		else if (name === "IDAT") compressed.push(body);
		else if (name === "IEND") break;
		at += 12 + length;
	}
	if (header?.depth !== 8 || header.interlace !== 0) return null;
	const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[header.kind];
	if (!channels || (header.kind === 3 && !palette)) return null;
	const { width, height } = header;

	const joined = new Uint8Array(compressed.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of compressed) {
		joined.set(part, offset);
		offset += part.length;
	}
	let raw: Uint8Array;
	try {
		raw = await through(joined, new DecompressionStream("deflate"));
	} catch {
		return null;
	}
	const stride = width * channels;
	if (raw.length < height * (stride + 1)) return null;

	// Undo each row's filter, in place in a buffer of the rows alone.
	const rows = new Uint8Array(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)] as number;
		const source = y * (stride + 1) + 1;
		const row = y * stride;
		for (let x = 0; x < stride; x++) {
			const value = raw[source + x] as number;
			const left = x >= channels ? (rows[row + x - channels] as number) : 0;
			const up = y > 0 ? (rows[row - stride + x] as number) : 0;
			const upLeft = y > 0 && x >= channels ? (rows[row - stride + x - channels] as number) : 0;
			const predicted =
				filter === 1
					? left
					: filter === 2
						? up
						: filter === 3
							? (left + up) >> 1
							: filter === 4
								? paeth(left, up, upLeft)
								: 0;
			rows[row + x] = (value + predicted) & 0xff;
		}
	}

	const pixels = width * height;
	const grey = header.kind === 0 || header.kind === 4;
	const colour = new Uint8Array(pixels * (grey ? 1 : 3));
	const alpha = new Uint8Array(pixels);
	let translucent = false;
	for (let index = 0; index < pixels; index++) {
		const at = index * channels;
		let opacity = 255;
		if (header.kind === 3) {
			const entry = rows[at] as number;
			const from = (palette as Uint8Array).subarray(entry * 3, entry * 3 + 3);
			colour.set(from, index * 3);
			opacity = transparency && entry < transparency.length ? (transparency[entry] as number) : 255;
		} else if (grey) {
			colour[index] = rows[at] as number;
			if (header.kind === 4) opacity = rows[at + 1] as number;
		} else {
			colour.set(rows.subarray(at, at + 3), index * 3);
			if (header.kind === 6) opacity = rows[at + 3] as number;
		}
		alpha[index] = opacity;
		if (opacity !== 255) translucent = true;
	}
	return {
		width,
		height,
		colour,
		space: grey ? "DeviceGray" : "DeviceRGB",
		alpha: translucent ? alpha : null,
	};
}

/** A JPEG's colour space for a PDF, by its number of components; null for CMYK and the rest. */
export function jpegSpace(bytes: Uint8Array): "DeviceRGB" | "DeviceGray" | null {
	const components = jpegSize(bytes)?.components;
	return components === 3 ? "DeviceRGB" : components === 1 ? "DeviceGray" : null;
}
