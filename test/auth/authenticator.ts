/**
 * A software authenticator: what a browser and a security key do between them
 * in the two WebAuthn ceremonies, and no more of it than the server needs in
 * order to verify. One ES256 key, attestation format "none".
 *
 * It exists so that a test can say whether the person was verified (a PIN, a
 * fingerprint), which a real authenticator decides for itself.
 */

const encoder = new TextEncoder();

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const HAS_CREDENTIAL = 0x40;

/** Bytes in memory of their own, which is what Web Crypto takes. */
type Octets = Uint8Array<ArrayBuffer>;
type Bytes = Uint8Array | number[];

function concat(...parts: Bytes[]): Octets {
	return Uint8Array.from(parts.flatMap((part) => [...part]));
}

function toBase64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function fromBase64Url(text = ""): Octets {
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(data: Octets): Promise<Octets> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** A short text string in CBOR. */
function text(value: string): number[] {
	return [0x60 + value.length, ...encoder.encode(value)];
}

/** One of the two integers of an ECDSA signature in DER: no leading zeros, and never negative. */
function derInteger(bytes: Uint8Array): number[] {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) start++;
	const trimmed = [...bytes.subarray(start)];
	const unsigned = (trimmed[0] ?? 0) >= 0x80 ? [0, ...trimmed] : trimmed;
	return [0x02, unsigned.length, ...unsigned];
}

type Options = { challenge: string };
type Ceremony = { userVerified: boolean };

/** One credential, and the two things it can be asked to do. Each answer is what the server is sent. */
export interface Authenticator {
	credentialId: string;
	/** What `navigator.credentials.create()` hands back for the server's options. */
	register(options: Options, ceremony: Ceremony): unknown;
	/** What `navigator.credentials.get()` hands back for the server's options. */
	authenticate(options: Options, ceremony: Ceremony): Promise<unknown>;
}

/**
 * An authenticator holding one credential for the site at `origin`. A second
 * authenticator given the first one's `credentialId` claims the same id with a
 * key of its own.
 */
export async function createAuthenticator(
	origin: string,
	credentialId?: string,
): Promise<Authenticator> {
	const { privateKey, publicKey } = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const { x, y } = await crypto.subtle.exportKey("jwk", publicKey);
	const rawId = credentialId
		? fromBase64Url(credentialId)
		: crypto.getRandomValues(new Uint8Array(16));
	const id = toBase64Url(rawId);
	const relyingParty = await sha256(encoder.encode(new URL(origin).hostname));

	const flags = ({ userVerified }: Ceremony) => USER_PRESENT | (userVerified ? USER_VERIFIED : 0);
	const clientData = (type: string, { challenge }: Options) =>
		encoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

	return {
		credentialId: id,

		/** What `navigator.credentials.create()` hands back for the server's options. */
		register(options: Options, ceremony: Ceremony) {
			// The public key as a COSE_Key: EC2, ES256, P-256, x, y.
			const key = concat(
				[0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20],
				fromBase64Url(x),
				[0x22, 0x58, 0x20],
				fromBase64Url(y),
			);
			const authenticatorData = concat(
				relyingParty,
				[flags(ceremony) | HAS_CREDENTIAL],
				[0, 0, 0, 0],
				new Uint8Array(16),
				[0, rawId.length],
				rawId,
				key,
			);
			const attestation = concat(
				[0xa3],
				text("fmt"),
				text("none"),
				text("attStmt"),
				[0xa0],
				text("authData"),
				[0x58, authenticatorData.length],
				authenticatorData,
			);
			return {
				id,
				rawId: id,
				type: "public-key",
				clientExtensionResults: {},
				response: {
					clientDataJSON: toBase64Url(clientData("webauthn.create", options)),
					attestationObject: toBase64Url(attestation),
					transports: ["internal"],
				},
			};
		},

		/** What `navigator.credentials.get()` hands back for the server's options. */
		async authenticate(options: Options, ceremony: Ceremony) {
			const authenticatorData = concat(relyingParty, [flags(ceremony)], [0, 0, 0, 0]);
			const clientDataJSON = clientData("webauthn.get", options);
			const signature = new Uint8Array(
				await crypto.subtle.sign(
					{ name: "ECDSA", hash: "SHA-256" },
					privateKey,
					concat(authenticatorData, await sha256(clientDataJSON)),
				),
			);
			const der = [...derInteger(signature.subarray(0, 32)), ...derInteger(signature.subarray(32))];
			return {
				id,
				rawId: id,
				type: "public-key",
				clientExtensionResults: {},
				response: {
					clientDataJSON: toBase64Url(clientDataJSON),
					authenticatorData: toBase64Url(authenticatorData),
					signature: toBase64Url(Uint8Array.from([0x30, der.length, ...der])),
				},
			};
		},
	};
}
