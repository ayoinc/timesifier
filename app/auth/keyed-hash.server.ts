/**
 * HMAC-SHA-256 under `BETTER_AUTH_SECRET`, for a value the application has to
 * recognise again and must never be able to read back: a sign-in code in the
 * database, an address in a counter's key, the proof in a cookie.
 *
 * A plain hash would not do. A code is eight digits and an address can be
 * guessed, so anyone holding the hash could try every candidate; with the key
 * they would need the secret as well, which is not in the database.
 *
 * Each use names its purpose, which is hashed with the value, so a hash made
 * for one use is worthless in another.
 */
const encoder = new TextEncoder();

/** The keyed hash of `value` for `purpose`, as 64 hexadecimal characters. */
export async function keyedHash(secret: string, purpose: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}\n${value}`));
	return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether two hashes are the same, in a time that does not depend on where they differ. */
export function sameHash(one: string, other: string): boolean {
	const [a, b] = [encoder.encode(one), encoder.encode(other)];
	return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}
