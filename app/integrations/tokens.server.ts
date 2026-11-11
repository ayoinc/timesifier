import { isKeyedHash, keyedHash } from "~/auth/keyed-hash.server";

/**
 * API tokens and webhook secrets (TS-064, B20). Neither is ever stored as it
 * is: a token is shown once and only its keyed hash is kept, and a webhook's
 * secret is derived from `BETTER_AUTH_SECRET`, the webhook's id and its
 * version, so it can be shown again, and changed by raising the version,
 * without the database holding it.
 */

/** What every API token starts with, so a leaked one can be recognised and reported. */
export const API_TOKEN_PREFIX = "tsf_";

/** Random bytes in a token: 256 bits. */
const TOKEN_BYTES = 32;

/** Characters of the random part kept in `api_tokens.prefix`. */
const DISPLAY_LENGTH = 8;

/** `tsf_` and 43 base64url characters: 32 bytes with no padding. */
const TOKEN_SHAPE = /^tsf_[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Whether `token` is shaped like an API token, before anything is looked up. */
export function isApiTokenShape(token: string): boolean {
	return TOKEN_SHAPE.test(token);
}

/** The keyed hash `api_tokens.token_hash` holds for `token`. */
export function hashApiToken(secret: string, token: string): Promise<string> {
	return keyedHash(secret, "api-token", token);
}

/**
 * A new API token. `token` is shown once, to the person who made it, and never
 * again. `prefix` is the first eight characters after `tsf_`: lists show it as
 * `tsf_` and those eight, which tells tokens apart without revealing them.
 * `hash` is what is stored.
 */
export async function createApiToken(
	secret: string,
): Promise<{ token: string; prefix: string; hash: string }> {
	const token = API_TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
	const prefix = token.slice(API_TOKEN_PREFIX.length, API_TOKEN_PREFIX.length + DISPLAY_LENGTH);
	return { token, prefix, hash: await hashApiToken(secret, token) };
}

/** Whether `token` is the one whose hash is `hash`, compared in constant time. */
export async function verifyApiToken(
	secret: string,
	token: string,
	hash: string,
): Promise<boolean> {
	if (!isApiTokenShape(token)) return false;
	return isKeyedHash(secret, "api-token", token, hash);
}

/**
 * The signing secret of version `version` of webhook `webhookId`: 64
 * hexadecimal characters, the same each time it is asked for. Raising
 * `webhooks.secret_version` gives the webhook a new one.
 */
export async function webhookSecret(
	secret: string,
	webhookId: string,
	version: number,
): Promise<string> {
	if (!Number.isSafeInteger(version) || version < 1) {
		throw new RangeError(`Not a webhook secret version: ${version}`);
	}
	return keyedHash(secret, "webhook-secret", `${webhookId}:${version}`);
}

/** The keyed hash `webhooks.secret_hash` holds for a webhook's secret. */
export function hashWebhookSecret(secret: string, webhookSecretValue: string): Promise<string> {
	return keyedHash(secret, "webhook-secret-hash", webhookSecretValue);
}

/** How far, in seconds, a signature's time may be from now and still be accepted. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function signingKey(webhookSecretValue: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(webhookSecretValue),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

/**
 * The signature header's value for a delivery of `body` at `timestamp`
 * (seconds since 1970): `t=<timestamp>,v1=<hex>`, where the hex is the
 * HMAC-SHA-256 of `<timestamp>.<body>` under the webhook's secret. The time is
 * signed with the body so a delivery cannot be replayed later.
 */
export async function signWebhook(
	webhookSecretValue: string,
	timestamp: number,
	body: string,
): Promise<string> {
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new RangeError(`Not a time in seconds: ${timestamp}`);
	}
	const mac = await crypto.subtle.sign(
		"HMAC",
		await signingKey(webhookSecretValue),
		encoder.encode(`${timestamp}.${body}`),
	);
	const hex = Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
	return `t=${timestamp},v1=${hex}`;
}

/**
 * Whether `header` is a valid signature of `body` under the webhook's secret,
 * made within `toleranceSeconds` of `now` (seconds since 1970), either side.
 * A header may carry several `v1` signatures, as when a secret is being
 * changed; one valid one is enough. Each is compared in constant time.
 */
export async function verifyWebhookSignature(
	webhookSecretValue: string,
	header: string,
	body: string,
	now: number,
	toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS,
): Promise<boolean> {
	let timestamp: number | null = null;
	const signatures: string[] = [];
	for (const part of header.split(",")) {
		const [key, value] = part.trim().split("=", 2);
		if (key === "t" && value !== undefined && /^\d{1,15}$/.test(value)) {
			timestamp = Number(value);
		} else if (key === "v1" && value !== undefined && /^[0-9a-f]{64}$/.test(value)) {
			signatures.push(value);
		}
	}
	if (timestamp === null || signatures.length === 0) return false;
	if (Math.abs(now - timestamp) > toleranceSeconds) return false;
	const key = await signingKey(webhookSecretValue);
	const signed = encoder.encode(`${timestamp}.${body}`);
	for (const signature of signatures) {
		const bytes = Uint8Array.from(signature.match(/../g) ?? [], (pair) =>
			Number.parseInt(pair, 16),
		);
		if (await crypto.subtle.verify("HMAC", key, bytes, signed)) return true;
	}
	return false;
}
