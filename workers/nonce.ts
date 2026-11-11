import { createContext } from "react-router";

/**
 * Carries the request's CSP nonce from the Worker to `app/entry.server.tsx`.
 * It has no default: a render that did not come through the Worker fails loudly
 * instead of emitting scripts the policy would block.
 */
export const nonceContext = createContext<string>();

/** 128 random bits from Web Crypto, base64 encoded as the CSP grammar asks. */
export function createNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes));
}
