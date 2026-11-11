import { describe, expect, it } from "vitest";
import { keyedHash } from "~/auth/keyed-hash.server";
import {
	API_TOKEN_PREFIX,
	createApiToken,
	hashApiToken,
	hashWebhookSecret,
	isApiTokenShape,
	signWebhook,
	verifyApiToken,
	verifyWebhookSignature,
	WEBHOOK_TOLERANCE_SECONDS,
	webhookSecret,
} from "~/integrations/tokens.server";

// API tokens and webhook secrets (TS-064, B20): a token is shown once and kept
// only as a keyed hash; a webhook's secret is derived, never stored, and signs
// each delivery with its time.

/** A small, seeded generator (mulberry32), so a failing case can be run again. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const SECRET = "a-test-secret-that-is-long-enough-for-hmac";
const OTHER_SECRET = "another-test-secret-that-is-long-enough";

/** The HMAC-SHA-256 of `message` under `key`, in hex, worked out here rather than by the module. */
async function hmacHex(key: string, message: string): Promise<string> {
	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
	return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("an API token", () => {
	it("is tsf_ and 43 base64url characters, with its prefix and its keyed hash", async () => {
		const { token, prefix, hash } = await createApiToken(SECRET);
		expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
		expect(token).toMatch(/^tsf_[A-Za-z0-9_-]{43}$/);
		expect(isApiTokenShape(token)).toBe(true);
		expect(prefix).toBe(token.slice(4, 12));
		expect(prefix).toHaveLength(8);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).toBe(await hashApiToken(SECRET, token));
		expect(hash).toBe(await keyedHash(SECRET, "api-token", token));
	});

	it("is hashed for its own purpose, so its hash is worthless elsewhere", async () => {
		const { token, hash } = await createApiToken(SECRET);
		expect(hash).not.toBe(await keyedHash(SECRET, "webhook-secret", token));
		expect(hash).not.toBe(await hashApiToken(OTHER_SECRET, token));
	});

	it("is verified against its hash, and nothing else is", async () => {
		const { token, hash } = await createApiToken(SECRET);
		const other = await createApiToken(SECRET);
		expect(await verifyApiToken(SECRET, token, hash)).toBe(true);
		expect(await verifyApiToken(SECRET, other.token, hash)).toBe(false);
		expect(await verifyApiToken(OTHER_SECRET, token, hash)).toBe(false);
		expect(await verifyApiToken(SECRET, token, other.hash)).toBe(false);
		expect(await verifyApiToken(SECRET, token, hash.toUpperCase())).toBe(false);
		expect(await verifyApiToken(SECRET, token, "")).toBe(false);
		expect(await verifyApiToken(SECRET, token, `${hash}0`)).toBe(false);
		expect(await verifyApiToken(SECRET, `${token}x`, hash)).toBe(false);
	});

	it("is refused by shape before it is looked up when it is not one", () => {
		const good = `tsf_${"A".repeat(43)}`;
		expect(isApiTokenShape(good)).toBe(true);
		for (const token of [
			"",
			"tsf_",
			`tsf_${"A".repeat(42)}`,
			`tsf_${"A".repeat(44)}`,
			`tsx_${"A".repeat(43)}`,
			`TSF_${"A".repeat(43)}`,
			`tsf_${"A".repeat(42)}=`,
			`tsf_${"A".repeat(42)}+`,
			` ${good}`,
		]) {
			expect(isApiTokenShape(token)).toBe(false);
		}
	});

	it("property: every new token is unique, well shaped, and verifies against its own hash only", async () => {
		const made = await Promise.all(Array.from({ length: 50 }, () => createApiToken(SECRET)));
		expect(new Set(made.map(({ token }) => token)).size).toBe(made.length);
		expect(new Set(made.map(({ hash }) => hash)).size).toBe(made.length);
		for (const [index, { token, prefix, hash }] of made.entries()) {
			expect(isApiTokenShape(token)).toBe(true);
			expect(token.slice(4, 12)).toBe(prefix);
			expect(await verifyApiToken(SECRET, token, hash)).toBe(true);
			const neighbour = made[(index + 1) % made.length];
			expect(await verifyApiToken(SECRET, token, neighbour?.hash ?? "")).toBe(false);
		}
	});
});

describe("a webhook's secret", () => {
	it("is derived from the secret, the webhook and its version, the same each time", async () => {
		const first = await webhookSecret(SECRET, "hook-1", 1);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(await webhookSecret(SECRET, "hook-1", 1)).toBe(first);
		expect(first).toBe(await keyedHash(SECRET, "webhook-secret", "hook-1:1"));
	});

	it("changes with the version, the webhook and the application's secret", async () => {
		const first = await webhookSecret(SECRET, "hook-1", 1);
		expect(await webhookSecret(SECRET, "hook-1", 2)).not.toBe(first);
		expect(await webhookSecret(SECRET, "hook-2", 1)).not.toBe(first);
		expect(await webhookSecret(OTHER_SECRET, "hook-1", 1)).not.toBe(first);
	});

	it("has a version that is a whole number from 1", async () => {
		await expect(webhookSecret(SECRET, "hook-1", 0)).rejects.toThrow(RangeError);
		await expect(webhookSecret(SECRET, "hook-1", 1.5)).rejects.toThrow(RangeError);
	});

	it("is stored only as its keyed hash, which is not the secret", async () => {
		const value = await webhookSecret(SECRET, "hook-1", 1);
		const hash = await hashWebhookSecret(SECRET, value);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).not.toBe(value);
		expect(await hashWebhookSecret(SECRET, value)).toBe(hash);
		expect(hash).toBe(await keyedHash(SECRET, "webhook-secret-hash", value));
	});
});

describe("a webhook's signature", () => {
	const body = JSON.stringify({ event: "time_entry.created", id: "e1" });
	const timestamp = 1_794_355_200;

	it("is the time and the HMAC-SHA-256 of the time and the body under the webhook's secret", async () => {
		const value = await webhookSecret(SECRET, "hook-1", 1);
		const header = await signWebhook(value, timestamp, body);
		expect(header).toBe(`t=${timestamp},v1=${await hmacHex(value, `${timestamp}.${body}`)}`);
	});

	it("refuses a time that is not whole seconds", async () => {
		await expect(signWebhook("secret", 1.5, body)).rejects.toThrow(RangeError);
		await expect(signWebhook("secret", -1, body)).rejects.toThrow(RangeError);
	});

	it("verifies within the tolerance either side, and not outside it", async () => {
		const header = await signWebhook("secret", timestamp, body);
		expect(await verifyWebhookSignature("secret", header, body, timestamp)).toBe(true);
		for (const offset of [WEBHOOK_TOLERANCE_SECONDS, -WEBHOOK_TOLERANCE_SECONDS]) {
			expect(await verifyWebhookSignature("secret", header, body, timestamp + offset)).toBe(true);
		}
		for (const offset of [WEBHOOK_TOLERANCE_SECONDS + 1, -WEBHOOK_TOLERANCE_SECONDS - 1]) {
			expect(await verifyWebhookSignature("secret", header, body, timestamp + offset)).toBe(false);
		}
		expect(await verifyWebhookSignature("secret", header, body, timestamp + 60, 30)).toBe(false);
		expect(await verifyWebhookSignature("secret", header, body, timestamp + 30, 30)).toBe(true);
	});

	it("does not verify another body, another secret, or another time", async () => {
		const header = await signWebhook("secret", timestamp, body);
		expect(await verifyWebhookSignature("secret", header, `${body} `, timestamp)).toBe(false);
		expect(await verifyWebhookSignature("other", header, body, timestamp)).toBe(false);
		const moved = header.replace(`t=${timestamp}`, `t=${timestamp + 1}`);
		expect(await verifyWebhookSignature("secret", moved, body, timestamp)).toBe(false);
	});

	it("verifies when one of several v1 signatures is good, as while a secret changes", async () => {
		const old = await signWebhook("old", timestamp, body);
		const current = await signWebhook("new", timestamp, body);
		const both = `${current},${old.split(",")[1]}`;
		expect(await verifyWebhookSignature("old", both, body, timestamp)).toBe(true);
		expect(await verifyWebhookSignature("new", both, body, timestamp)).toBe(true);
		expect(await verifyWebhookSignature("neither", both, body, timestamp)).toBe(false);
	});

	it("does not verify a header that is malformed", async () => {
		const header = await signWebhook("secret", timestamp, body);
		const signature = header.split("v1=")[1] ?? "";
		for (const malformed of [
			"",
			`t=${timestamp}`,
			`v1=${signature}`,
			`t=abc,v1=${signature}`,
			`t=${timestamp},v1=${signature.slice(1)}`,
			`t=${timestamp},v1=${signature.toUpperCase()}`,
			`t=${timestamp},v0=${signature}`,
		]) {
			expect(await verifyWebhookSignature("secret", malformed, body, timestamp)).toBe(false);
		}
		expect(
			await verifyWebhookSignature("secret", `t=${timestamp}, v1=${signature}`, body, timestamp),
		).toBe(true);
	});

	it("property: a signature verifies for its own body and time, and one changed character spoils it", async () => {
		const next = random(12);
		const alphabet = 'abcXYZ019 {}":,.=\n€';
		for (let run = 0; run < 100; run++) {
			const text = Array.from(
				{ length: Math.floor(next() * 200) },
				() => alphabet[Math.floor(next() * alphabet.length)],
			).join("");
			const time = Math.floor(next() * 2_000_000_000);
			const key = `secret-${run}`;
			const header = await signWebhook(key, time, text);
			expect(await verifyWebhookSignature(key, header, text, time)).toBe(true);

			const signature = header.split("v1=")[1] ?? "";
			const at = Math.floor(next() * signature.length);
			const flipped =
				signature.slice(0, at) + (signature[at] === "0" ? "1" : "0") + signature.slice(at + 1);
			expect(await verifyWebhookSignature(key, `t=${time},v1=${flipped}`, text, time)).toBe(false);
			expect(await verifyWebhookSignature(key, header, `${text}!`, time)).toBe(false);
		}
	});
});
