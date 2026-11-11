const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/**
 * A UUID version 7 (RFC 9562, section 5.7) as lowercase text.
 *
 * The first 48 bits are the Unix time in milliseconds, big-endian, so ids
 * created in a later millisecond sort after earlier ones as plain strings.
 * The remaining 74 bits are random; ids from the same millisecond are unique
 * but in no particular order.
 */
export function uuidv7(now: number = Date.now()): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));

	// 48-bit timestamp. Bitwise operators stop at 32 bits, so the top 16 bits are divided off.
	const high = Math.floor(now / 2 ** 32);
	const low = now % 2 ** 32;
	bytes[0] = (high >>> 8) & 0xff;
	bytes[1] = high & 0xff;
	bytes[2] = (low >>> 24) & 0xff;
	bytes[3] = (low >>> 16) & 0xff;
	bytes[4] = (low >>> 8) & 0xff;
	bytes[5] = low & 0xff;

	bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
	bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // variant 10

	let id = "";
	for (let i = 0; i < 16; i++) {
		if (i === 4 || i === 6 || i === 8 || i === 10) id += "-";
		id += HEX[bytes[i] ?? 0];
	}
	return id;
}
