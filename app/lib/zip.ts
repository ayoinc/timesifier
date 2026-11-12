// A ZIP file written as it is read (APPNOTE 6.3.10, without ZIP64): each file's
// local header and bytes, then the central directory and the end record. Each
// file is deflated (`CompressionStream("deflate-raw")`) and kept that way when
// it is smaller, else stored. Names are marked UTF-8 (general purpose bit 11).
// Sizes are known before a file's header is written, so there are no data
// descriptors. Used by the export of every invoice as a PDF (TS-076).

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
/** What fits a field of four bytes, and of two: past these a file needs ZIP64, which this does not write. */
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

/** A little-endian record of `fields`, each [width in bytes, value]. */
function record(fields: readonly [2 | 4, number][], name?: Uint8Array): Uint8Array<ArrayBuffer> {
	const size = fields.reduce((sum, [width]) => sum + width, 0);
	const bytes = new Uint8Array(size + (name?.length ?? 0));
	const view = new DataView(bytes.buffer);
	let at = 0;
	for (const [width, value] of fields) {
		if (width === 2) view.setUint16(at, value, true);
		else view.setUint32(at, value, true);
		at += width;
	}
	if (name) bytes.set(name, at);
	return bytes;
}

interface Written {
	name: Uint8Array;
	method: number;
	time: number;
	day: number;
	crc: number;
	compressed: number;
	size: number;
	offset: number;
}

async function* chunks(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Uint8Array<ArrayBuffer>> {
	const encoder = new TextEncoder();
	const written: Written[] = [];
	let offset = 0;
	for await (const entry of entries) {
		const name = encoder.encode(entry.name);
		const deflated = await deflateRaw(entry.bytes);
		const method = deflated.length < entry.bytes.length ? DEFLATED : STORED;
		const data = method === DEFLATED ? deflated : entry.bytes;
		if (offset + data.length > MAX_U32 || written.length === MAX_U16 || name.length > MAX_U16) {
			throw new Error("This ZIP would need ZIP64, which is not written.");
		}
		const { time, day } = dosTime(entry.modified);
		const file: Written = {
			name,
			method,
			time,
			day,
			crc: crc32(entry.bytes),
			compressed: data.length,
			size: entry.bytes.length,
			offset,
		};
		const header = record(
			[
				[4, 0x0403_4b50],
				[2, VERSION],
				[2, UTF8_NAMES],
				[2, method],
				[2, time],
				[2, day],
				[4, file.crc],
				[4, file.compressed],
				[4, file.size],
				[2, name.length],
				[2, 0],
			],
			name,
		);
		written.push(file);
		offset += header.length + data.length;
		yield header;
		yield data;
	}
	const start = offset;
	for (const file of written) {
		const header = record(
			[
				[4, 0x0201_4b50],
				[2, VERSION],
				[2, VERSION],
				[2, UTF8_NAMES],
				[2, file.method],
				[2, file.time],
				[2, file.day],
				[4, file.crc],
				[4, file.compressed],
				[4, file.size],
				[2, file.name.length],
				[2, 0],
				[2, 0],
				[2, 0],
				[2, 0],
				[4, 0],
				[4, file.offset],
			],
			file.name,
		);
		offset += header.length;
		yield header;
	}
	if (offset > MAX_U32) throw new Error("This ZIP would need ZIP64, which is not written.");
	yield record([
		[4, 0x0605_4b50],
		[2, 0],
		[2, 0],
		[2, written.length],
		[2, written.length],
		[4, offset - start],
		[4, start],
		[2, 0],
	]);
}

/** `entries` as the bytes of a ZIP file, written as they are read; nothing is kept but the directory. */
export function zip(entries: AsyncIterable<ZipEntry>): ReadableStream<Uint8Array<ArrayBuffer>> {
	const source = chunks(entries);
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
