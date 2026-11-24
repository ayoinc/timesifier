// A ZIP file written as it is read (APPNOTE 6.3.10): each file's
// local header and bytes, then the central directory and the end record. Each
// file is deflated (`CompressionStream("deflate-raw")`) and kept that way when
// it is smaller, else stored. Names are marked UTF-8 (general purpose bit 11).
// Sizes are known before a file's header is written, so there are no data
// descriptors. The end record carries the archive's comment, in UTF-8, which an
// archive tool shows on opening it. Used by the export of every invoice as a
// PDF (TS-076, TS-100), and, a file at a time through `zipFile` and `zipEnd`,
// by the export of everything (TS-126), which may pass 4 GiB or 65,535 files
// and then writes ZIP64's records.

/** A file to put in the ZIP. */
export interface ZipEntry {
	name: string;
	bytes: Uint8Array<ArrayBuffer>;
	modified: Date;
}

const STORED = 0;
const DEFLATED = 8;
const UTF8_NAMES = 0x0800;
const VERSION = 20;
/** The version a reader needs for ZIP64's records. */
const VERSION_ZIP64 = 45;
/** What fits a field of four bytes, and of two: past these the ZIP needs ZIP64's records. */
const MAX_U32 = 0xffff_ffff;
const MAX_U16 = 0xffff;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/** The CRC-32 (IEEE 802.3) of `bytes`, as ZIP and PNG use it. */
export function crc32(bytes: Uint8Array): number {
	let crc = 0xffff_ffff;
	for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
	return (crc ^ 0xffff_ffff) >>> 0;
}

/** `date` as MS-DOS time and date, in UTC: the precision is two seconds, from 1980. */
function dosTime(date: Date): { time: number; day: number } {
	const year = Math.max(date.getUTCFullYear(), 1980);
	return {
		time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
		day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
	};
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A little-endian record of `fields`, each [width in bytes, value], then `name` and `extra`. */
function record(
	fields: readonly [2 | 4 | 8, number][],
	name?: Uint8Array,
	extra?: Uint8Array,
): Uint8Array<ArrayBuffer> {
	const size = fields.reduce((sum, [width]) => sum + width, 0);
	const bytes = new Uint8Array(size + (name?.length ?? 0) + (extra?.length ?? 0));
	const view = new DataView(bytes.buffer);
	let at = 0;
	for (const [width, value] of fields) {
		if (width === 2) view.setUint16(at, value, true);
		else if (width === 4) view.setUint32(at, value, true);
		else view.setBigUint64(at, BigInt(value), true);
		at += width;
	}
	if (name) bytes.set(name, at);
	if (extra) bytes.set(extra, at + (name?.length ?? 0));
	return bytes;
}

/** One file as it is written: its local header and data, and its record in the central directory. */
export interface ZippedFile {
	header: Uint8Array<ArrayBuffer>;
	data: Uint8Array<ArrayBuffer>;
	central: Uint8Array<ArrayBuffer>;
}

/**
 * `entry` as the ZIP writes it at `offset`, the byte its local header starts
 * at. A file itself is never past 4 GiB (it is held in memory), so its sizes
 * always fit the local header; only its place may not. A place past 4 GiB is
 * written in the central directory as ZIP64's extra field (APPNOTE 4.5.3),
 * which is how the export of everything (TS-126) goes past 4 GiB.
 */
export async function zipFile(entry: ZipEntry, offset: number): Promise<ZippedFile> {
	const name = new TextEncoder().encode(entry.name);
	if (name.length > MAX_U16) throw new Error("A file's name in a ZIP is at most 65,535 bytes.");
	const deflated = await deflateRaw(entry.bytes);
	const method = deflated.length < entry.bytes.length ? DEFLATED : STORED;
	const data = method === DEFLATED ? deflated : entry.bytes;
	const { time, day } = dosTime(entry.modified);
	const crc = crc32(entry.bytes);
	const header = record(
		[
			[4, 0x0403_4b50],
			[2, VERSION],
			[2, UTF8_NAMES],
			[2, method],
			[2, time],
			[2, day],
			[4, crc],
			[4, data.length],
			[4, entry.bytes.length],
			[2, name.length],
			[2, 0],
		],
		name,
	);
	const far = offset > MAX_U32;
	const central = record(
		[
			[4, 0x0201_4b50],
			[2, far ? VERSION_ZIP64 : VERSION],
			[2, far ? VERSION_ZIP64 : VERSION],
			[2, UTF8_NAMES],
			[2, method],
			[2, time],
			[2, day],
			[4, crc],
			[4, data.length],
			[4, entry.bytes.length],
			[2, name.length],
			[2, far ? 12 : 0],
			[2, 0],
			[2, 0],
			[2, 0],
			[4, 0],
			[4, far ? MAX_U32 : offset],
		],
		name,
		far
			? record([
					[2, 0x0001],
					[2, 8],
					[8, offset],
				])
			: undefined,
	);
	return { header, data, central };
}

/**
 * The end of a ZIP whose central directory of `count` records and `size`
 * bytes starts at byte `start`: the end record with `comment`, and before it,
 * when a count or a place does not fit the end record, ZIP64's end record and
 * its locator (APPNOTE 4.3.14, 4.3.15), with the end record's fields full.
 */
export function zipEnd(
	count: number,
	start: number,
	size: number,
	comment: Uint8Array,
): Uint8Array<ArrayBuffer> {
	if (comment.length > MAX_U16) throw new Error("A ZIP's comment is at most 65,535 bytes.");
	const end = record(
		[
			[4, 0x0605_4b50],
			[2, 0],
			[2, 0],
			[2, Math.min(count, MAX_U16)],
			[2, Math.min(count, MAX_U16)],
			[4, Math.min(size, MAX_U32)],
			[4, Math.min(start, MAX_U32)],
			[2, comment.length],
		],
		comment,
	);
	if (count < MAX_U16 && start + size <= MAX_U32) return end;
	const zip64 = record([
		[4, 0x0606_4b50],
		[8, 44],
		[2, VERSION_ZIP64],
		[2, VERSION_ZIP64],
		[4, 0],
		[4, 0],
		[8, count],
		[8, count],
		[8, size],
		[8, start],
	]);
	const locator = record([
		[4, 0x0706_4b50],
		[4, 0],
		[8, start + size],
		[4, 1],
	]);
	const bytes = new Uint8Array(zip64.length + locator.length + end.length);
	bytes.set(zip64);
	bytes.set(locator, zip64.length);
	bytes.set(end, zip64.length + locator.length);
	return bytes;
}

async function* chunks(
	entries: AsyncIterable<ZipEntry>,
	comment: Uint8Array,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
	const directory: Uint8Array<ArrayBuffer>[] = [];
	let offset = 0;
	for await (const entry of entries) {
		const { header, data, central } = await zipFile(entry, offset);
		directory.push(central);
		offset += header.length + data.length;
		yield header;
		yield data;
	}
	const start = offset;
	for (const central of directory) {
		offset += central.length;
		yield central;
	}
	yield zipEnd(directory.length, start, offset - start, comment);
}

/**
 * `entries` as the bytes of a ZIP file, written as they are read, with
 * `comment` as the archive's; nothing is kept but the directory.
 */
export function zip(
	entries: AsyncIterable<ZipEntry>,
	comment = "",
): ReadableStream<Uint8Array<ArrayBuffer>> {
	const encoded = new TextEncoder().encode(comment);
	if (encoded.length > MAX_U16) throw new Error("A ZIP's comment is at most 65,535 bytes.");
	const source = chunks(entries, encoded);
	return new ReadableStream<Uint8Array<ArrayBuffer>>({
		async pull(controller) {
			const next = await source.next();
			if (next.done) controller.close();
			else controller.enqueue(next.value);
		},
		async cancel() {
			await source.return(undefined);
		},
	});
}
