// What the pages ask of Better Auth, from the browser. Every call goes to the
// mounted handler at /api/auth, the only place the rate limit and the Turnstile
// check act (docs/security.md, "Authentication"). Better Auth's own client makes
// the calls: it is the same version as the server, and its passkey plugin runs
// the WebAuthn ceremony in the shape the server verifies.
//
// Each function answers with what happened, never with the server's wording: the
// pages choose the words a person reads.

import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";

/** What went wrong, in the terms the pages have words for. */
export type Problem =
	/** The limit of ten a minute. */
	| "too-many"
	/** Turnstile's token was missing or refused. */
	| "robot-check"
	| "wrong-code"
	| "expired-code"
	/** Three wrong codes: the code no longer works. */
	| "spent-code"
	/** The person closed the browser's passkey prompt, or it found no passkey. */
	| "cancelled"
	/** This authenticator already holds a passkey for the account. */
	| "already-added"
	| "failed";

export type Outcome = { ok: true } | { ok: false; problem: Problem };

const DONE: Outcome = { ok: true };

/** Calls `make` the first time the result is asked for, and keeps what it made. */
function onFirstUse<Made>(make: () => Made): () => Made {
	let made: { it: Made } | undefined;
	return () => {
		made ??= { it: make() };
		return made.it;
	};
}

/** Made in the browser, when a person first acts: nothing here runs while the server renders. */
const auth = onFirstUse(() => createAuthClient({ plugins: [emailOTPClient(), passkeyClient()] }));

type Failure = { status: number; code?: string | undefined };

const CODE_PROBLEMS: Record<string, Problem> = {
	INVALID_OTP: "wrong-code",
	OTP_EXPIRED: "expired-code",
	TOO_MANY_ATTEMPTS: "spent-code",
};

function outcome(error: Failure | null, problems: Record<string, Problem> = {}): Outcome {
	if (!error) return DONE;
	if (error.status === 429) return { ok: false, problem: "too-many" };
	return { ok: false, problem: problems[error.code ?? ""] ?? "failed" };
}

/** The request never reached the server, or its answer could not be read. */
async function attempt(call: () => Promise<Outcome>): Promise<Outcome> {
	try {
		return await call();
	} catch {
		return { ok: false, problem: "failed" };
	}
}

/**
 * Asks for a sign-in code to be emailed. The answer is the same whether or not
 * the address has an account. `token` is Turnstile's, and is used up by this.
 */
export function sendCode(email: string, token: string): Promise<Outcome> {
	return attempt(async () => {
		const { error } = await auth().emailOtp.sendVerificationOtp({
			email,
			type: "sign-in",
			fetchOptions: { headers: { "x-captcha-response": token } },
		});
		// The Turnstile check answers 400 without a token and 403 for one it refuses.
		if (error?.status === 400 || error?.status === 403)
			return { ok: false, problem: "robot-check" };
		return outcome(error);
	});
}

/** Signs in with an emailed code. The first time, this creates the account, with `name`. */
export function signInWithCode(email: string, code: string, name?: string): Promise<Outcome> {
	return attempt(async () => {
		const { error } = await auth().signIn.emailOtp({ email, otp: code, ...(name ? { name } : {}) });
		return outcome(error, CODE_PROBLEMS);
	});
}

/** The codes the browser's side of a passkey ceremony fails with; the server's are not among them. */
function fromTheBrowser(code: string | undefined): boolean {
	return code === "AUTH_CANCELLED" || (code?.startsWith("ERROR_") ?? false);
}

/** An error's code. Better Auth's types leave it out of the errors that have none. */
function codeOf(error: object): string | undefined {
	return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Whether this browser can create and use passkeys at all. */
export function passkeysSupported(): boolean {
	return typeof window.PublicKeyCredential === "function";
}

/**
 * Signs in with a passkey. With `autofill`, the browser offers the person's
 * passkeys in the autofill of the email field and this resolves when one is
 * chosen; without, the browser shows its passkey prompt now, which also ends a
 * pending autofill request.
 *
 * Answers `null` when the request was ended by a later one or the browser has
 * no autofill for passkeys: nothing happened that a person should be told.
 */
export async function signInWithPasskey({ autofill = false } = {}): Promise<Outcome | null> {
	try {
		// Asked first, so a browser without it costs the server no request.
		if (autofill && !(await window.PublicKeyCredential?.isConditionalMediationAvailable?.())) {
			return null;
		}
		const { error } = await auth().signIn.passkey({ autoFill: autofill });
		if (!error) return DONE;
		const code = codeOf(error);
		if (fromTheBrowser(code)) {
			const silent = autofill || code === "ERROR_CEREMONY_ABORTED";
			return silent ? null : { ok: false, problem: "cancelled" };
		}
		return outcome(error);
	} catch {
		return autofill ? null : { ok: false, problem: "failed" };
	}
}

/** Creates a passkey for the signed-in person on this device or one nearby. */
export function addPasskey(): Promise<Outcome> {
	return attempt(async () => {
		const { error } = await auth().passkey.addPasskey();
		if (!error) return DONE;
		const code = codeOf(error);
		if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
			return { ok: false, problem: "already-added" };
		}
		return fromTheBrowser(code) ? { ok: false, problem: "cancelled" } : outcome(error);
	});
}

/** Forgets a passkey on the server. It stays on the person's device until they delete it there. */
export function removePasskey(id: string): Promise<Outcome> {
	return attempt(async () => outcome((await auth().passkey.deletePasskey({ id })).error));
}

/** Ends this session. */
export function signOut(): Promise<Outcome> {
	return attempt(async () => outcome((await auth().signOut()).error));
}

/** Ends every session the person has, this one included. */
export function signOutEverywhere(): Promise<Outcome> {
	return attempt(async () => outcome((await auth().revokeSessions()).error));
}

/**
 * Leaves for another page with a whole page load. Going between the pages
 * that need a session and the pages that give one always loads the page: the
 * two have different policies (docs/security.md), and a new document starts
 * with nothing the last person left in memory.
 */
export function leaveFor(path: string): void {
	window.location.assign(path);
}
