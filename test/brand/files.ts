import { exports } from "cloudflare:workers";
import { deflate } from "~/brand/images";
import { crc32 } from "~/lib/zip";
import { ORIGIN } from "../auth/harness";
import { dataAddress, type Person } from "../pages/harness";

// Image files for the brand's tests (TS-100), made here so no test reads a file
// from disk, and a form posted with files the way the Brand section posts it.

const TEXT = new TextEncoder();

function chunk(name: string, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + body.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, body.length);
	out.set(TEXT.encode(name), 4);
	out.set(body, 8);
	view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
	return out;
}

function joined(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/**
 * A PNG `width` by `height` of one colour, eight bits a sample, as RGBA, with
 * `extra` bytes of a private chunk after its header to make it as large as a
 * test needs.
 */
export async function png(
	width: number,
	height: number,
	{ rgba = [29, 78, 216, 255], extra = 0 }: { rgba?: number[]; extra?: number } = {},
): Promise<Uint8Array<ArrayBuffer>> {
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header.set([8, 6, 0, 0, 0], 8);
	const row = new Uint8Array(1 + width * 4);
	for (let x = 0; x < width; x++) row.set(rgba, 1 + x * 4);
	const raw = joined(Array.from({ length: height }, () => row));
	return joined([
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		...(extra > 0 ? [chunk("teSt", new Uint8Array(extra))] : []),
		chunk("IDAT", await deflate(raw)),
		chunk("IEND", new Uint8Array()),
	]);
}

/** The first bytes of a baseline JPEG `width` by `height` with three components: enough to be judged one. */
export function jpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
	const frame = new Uint8Array([
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		height >> 8,
		height & 0xff,
		width >> 8,
		width & 0xff,
		0x03,
		0x01,
		0x22,
		0x00,
		0x02,
		0x11,
		0x01,
		0x03,
		0x11,
		0x01,
	]);
	const app0 = new Uint8Array([
		0xff,
		0xe0,
		0x00,
		0x10,
		...TEXT.encode("JFIF\0"),
		1,
		1,
		0,
		0,
		1,
		0,
		1,
		0,
		0,
	]);
	return joined([new Uint8Array([0xff, 0xd8]), app0, frame, new Uint8Array([0xff, 0xd9])]);
}

/** The first bytes of a lossless WebP `width` by `height`. */
export function webp(width: number, height: number): Uint8Array<ArrayBuffer> {
	const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
	const body = new Uint8Array([
		...TEXT.encode("VP8L"),
		5,
		0,
		0,
		0,
		0x2f,
		bits & 0xff,
		(bits >> 8) & 0xff,
		(bits >> 16) & 0xff,
		(bits >> 24) & 0xff,
		0,
		0,
		0,
	]);
	const size = 4 + body.length;
	return joined([
		TEXT.encode("RIFF"),
		new Uint8Array([size & 0xff, (size >> 8) & 0xff, 0, 0]),
		TEXT.encode("WEBP"),
		body,
	]);
}

/** An SVG drawing a square, with `inside` added in it. */
export function svg(inside = ""): Uint8Array<ArrayBuffer> {
	return TEXT.encode(
		`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><rect width="120" height="40" fill="#1d4ed8"/>${inside}</svg>`,
	);
}

/** A form with files, posted to `path` by script from our own page, as `who`. */
export function submitFiles(
	path: string,
	fields: Record<string, string | { bytes: Uint8Array<ArrayBuffer>; name: string; type: string }>,
	who?: Person,
): Promise<Response> {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) {
		if (typeof value === "string") body.append(name, value);
		else body.append(name, new File([value.bytes], value.name, { type: value.type }));
	}
	const headers = new Headers({ Origin: ORIGIN });
	if (who) {
		headers.set("Cookie", who.cookie);
		headers.set("CF-Connecting-IP", who.client);
	}
	return exports.default.fetch(
		new Request(`${ORIGIN}${dataAddress(path)}`, {
			method: "POST",
			headers,
			body,
			redirect: "manual",
		}),
	);
}
