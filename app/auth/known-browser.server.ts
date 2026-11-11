/**
 * The proof that a browser has signed in as an address before.
 *
 * Somebody who knows a person's address can ask for codes for it. What tells
 * the person's own browser from that somebody is this cookie, set when a code
 * signs the person in: `sign-in-code.server.ts` counts the requests of a
 * browser that holds a proof for the address apart from everybody else's, and
 * keeps the code such a browser is waiting for out of everybody else's reach.
 * docs/decisions.md entry 27.
 *
 * Better Auth puts the application's prefix and attributes on the cookie:
 * `__Host-timesifier.known_browser`, `HttpOnly`, `Secure`, `SameSite=Lax`,
 * `Path=/`. Its value is one proof for each of the last five addresses signed
 * in from this browser, newest first, joined by full stops, so a browser that
 * several people share works for each of them. A proof is the keyed hash of
 * the lower-cased address: there is no address in the cookie, and nobody
 * without the secret can make a proof.
 *
 * Signing out, here or everywhere, leaves it alone, for three reasons. A
 * person who has signed out is exactly who asks for a code next, and without
 * the proof they would be a stranger again. The proof signs nobody in: it
 * decides which count a request for a code falls in, and the code still goes
 * to the address's inbox. And ending every session cannot reach a cookie in
 * another browser; only that browser's own requests can.
 *
 * A proof is the same in every browser and for as long as the secret is: one
 * that has leaked is withdrawn only by changing `BETTER_AUTH_SECRET`.
 */
import { isKeyedHash, keyedHash } from "./keyed-hash.server";

export const KNOWN_BROWSER_COOKIE = "known_browser";
/** A year: the browser forgets a proof that no sign-in has renewed for that long. */
export const KNOWN_BROWSER_KEPT_SECONDS = 365 * 24 * 60 * 60;

const PURPOSE = "known-browser";
const ADDRESSES_KEPT = 5;

/** The proofs a cookie's value holds. Never more than are kept, whatever was sent. */
function proofsIn(cookie: string | null): string[] {
	return (cookie ?? "").split(".", ADDRESSES_KEPT);
}

/** Whether the cookie's value holds a proof for `address`, which is lower-cased already. */
export async function isKnownBrowser(
	secret: string,
	cookie: string | null,
	address: string,
): Promise<boolean> {
	for (const proof of proofsIn(cookie)) {
		if (await isKeyedHash(secret, PURPOSE, address, proof)) return true;
	}
	return false;
}

/** The cookie's value with the proof for `address` put first. */
export async function withProofFor(
	secret: string,
	cookie: string | null,
	address: string,
): Promise<string> {
	const proof = await keyedHash(secret, PURPOSE, address);
	const others = proofsIn(cookie).filter((kept) => /^[0-9a-f]{64}$/.test(kept) && kept !== proof);
	return [proof, ...others].slice(0, ADDRESSES_KEPT).join(".");
}
