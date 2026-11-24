import { expect } from "vitest";
import { crc32 } from "~/lib/zip";

// A ZIP read back the way an unzipper reads it, for the tests of the exports
// that write one: every invoice as a PDF (TS-076) and everything (TS-126).
// ZIP64's records are read where the end record's fields are full.

export interface Unzipped {
	name: string;
	utf8: boolean;
	method: number;
	bytes: Uint8Array;
}

const FULL_U16 = 0xffff;
const FULL_U32 = 0xffff_ffff;

async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The end record, found as an unzipper finds it: searching back from the end
 * for its signature, at the place where the comment it gives the length of
 * ends the file. With the archive's comment.
 */
export function endRecord(file: Uint8Array<ArrayBuffer>): { end: number; comment: string } {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	for (let end = file.length - 22; end >= 0; end--) {
		if (view.getUint32(end, true) !== 0x0605_4b50) continue;
		const length = view.getUint16(end + 20, true);
		if (end + 22 + length !== file.length) continue;
		return { end, comment: new TextDecoder().decode(file.subarray(end + 22)) };
	}
	throw new Error("no end record");
}

/**
 * Where the directory is and how many records it holds: from the end record,
 * or from ZIP64's end record, through its locator, where the end record's
 * fields are full.
 */
export function directoryOf(file: Uint8Array<ArrayBuffer>): {
	count: number;
	size: number;
	start: number;
	zip64: boolean;
} {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const { end } = endRecord(file);
	const count = view.getUint16(end + 10, true);
	const size = view.getUint32(end + 12, true);
	const start = view.getUint32(end + 16, true);
	if (count !== FULL_U16 && size !== FULL_U32 && start !== FULL_U32) {
		return { count, size, start, zip64: false };
	}
	const locator = end - 20;
	expect(view.getUint32(locator, true)).toBe(0x0706_4b50);
	const record = Number(view.getBigUint64(locator + 8, true));
	expect(view.getUint32(record, true)).toBe(0x0606_4b50);
	return {
		count: Number(view.getBigUint64(record + 32, true)),
		size: Number(view.getBigUint64(record + 40, true)),
		start: Number(view.getBigUint64(record + 48, true)),
		zip64: true,
	};
}

/**
 * The place of a central directory record's file: its own field, or ZIP64's
 * extra field (0x0001) where that field is full.
 */
export function localOffset(view: DataView, at: number): number {
	const offset = view.getUint32(at + 42, true);
	if (offset !== FULL_U32) return offset;
	const nameLength = view.getUint16(at + 28, true);
	const extraLength = view.getUint16(at + 30, true);
	let extra = at + 46 + nameLength;
	const last = extra + extraLength;
	while (extra < last) {
		const id = view.getUint16(extra, true);
		const size = view.getUint16(extra + 2, true);
		if (id === 0x0001) return Number(view.getBigUint64(extra + 4, true));
		extra += 4 + size;
	}
	throw new Error("no ZIP64 offset");
}

/**
 * Reads a ZIP the way an unzipper does: the end record, then each entry of the
 * central directory, then its local header and data. Checks that the two
 * headers agree, that the sizes are right and that each CRC is the CRC of the
 * bytes it holds.
 */
export async function unzip(file: Uint8Array<ArrayBuffer>): Promise<Unzipped[]> {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const { count, size, start } = directoryOf(file);
	let at = start;
	const decoder = new TextDecoder();
	const entries: Unzipped[] = [];
	for (let n = 0; n < count; n++) {
		expect(view.getUint32(at, true)).toBe(0x0201_4b50);
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const crc = view.getUint32(at + 16, true);
		const compressed = view.getUint32(at + 20, true);
		const length = view.getUint32(at + 24, true);
		const nameLength = view.getUint16(at + 28, true);
		const extra = view.getUint16(at + 30, true);
		const comment = view.getUint16(at + 32, true);
		const local = localOffset(view, at);
		const name = decoder.decode(file.subarray(at + 46, at + 46 + nameLength));
		at += 46 + nameLength + extra + comment;

		expect(view.getUint32(local, true)).toBe(0x0403_4b50);
		expect(view.getUint16(local + 6, true)).toBe(flags);
		expect(view.getUint16(local + 8, true)).toBe(method);
		expect(view.getUint32(local + 14, true)).toBe(crc);
		expect(view.getUint32(local + 18, true)).toBe(compressed);
		expect(view.getUint32(local + 22, true)).toBe(length);
		const localName = view.getUint16(local + 26, true);
		const begins = local + 30 + localName + view.getUint16(local + 28, true);
		const data = file.slice(begins, begins + compressed);
		const bytes = method === 8 ? await inflateRaw(data) : data;
		expect(method === 0 || method === 8).toBe(true);
		expect(bytes.length).toBe(length);
		expect(crc32(bytes)).toBe(crc);
		entries.push({ name, utf8: (flags & 0x0800) !== 0, method, bytes });
	}
	expect(at).toBe(start + size);
	return entries;
}
