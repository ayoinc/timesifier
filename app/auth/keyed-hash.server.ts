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

function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

/** The keyed hash of `value` for `purpose`, as 64 hexadecimal characters. */
export async function keyedHash(secret: string, purpose: string, value: string): Promise<string> {
	const mac = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(secret),
		encoder.encode(`${purpose}\n${value}`),
	);
	return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether `hash` is the keyed hash of `value` for `purpose`. The comparison is
 * the platform's, which takes the same time wherever the two differ.
 */
export async function isKeyedHash(
	secret: string,
	purpose: string,
	value: string,
	hash: string,
): Promise<boolean> {
	if (!/^[0-9a-f]{64}$/.test(hash)) return false;
	const bytes = Uint8Array.from(hash.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
	return crypto.subtle.verify(
		"HMAC",
		await hmacKey(secret),
		bytes,
		encoder.encode(`${purpose}\n${value}`),
	);
}
