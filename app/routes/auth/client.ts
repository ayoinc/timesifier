// What the pages ask of Better Auth, from the browser. Every call goes to the
// mounted handler at /api/auth, the only place the rate limit and the Turnstile
// check act (docs/security.md, "Authentication"). Better Auth's own client makes
// the calls: it is the same version as the server.
//
// Each function answers with what happened, never with the server's wording: the
// pages choose the words a person reads.

import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";

import { NEWSLETTER_HEADER } from "~/platform/paths";

/** What went wrong, in the terms the pages have words for. */
export type Problem =
	/** The rate limit turned the request away. */
	| "too-many"
	/** Turnstile's token was missing or refused. */
	| "robot-check"
	/** The server does not take the address for an email address. */
	| "invalid-email"
	| "wrong-code"
	| "expired-code"
	/** Three wrong codes: the code no longer works. */
	| "spent-code"
	| "failed"
	/** The account was closed by Timesifier (TS-099). */
	| "closed";

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
const auth = onFirstUse(() => createAuthClient({ plugins: [emailOTPClient()] }));

type Failure = { status: number; code?: string | undefined };

const CODE_PROBLEMS: Record<string, Problem> = {
	INVALID_OTP: "wrong-code",
	OTP_EXPIRED: "expired-code",
	TOO_MANY_ATTEMPTS: "spent-code",
	ACCOUNT_CLOSED: "closed",
};

/** Why a request for a code was refused. The first two are the Turnstile check's. */
const SEND_PROBLEMS: Record<string, Problem> = {
	MISSING_RESPONSE: "robot-check",
	VERIFICATION_FAILED: "robot-check",
	INVALID_EMAIL: "invalid-email",
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
		return outcome(error, SEND_PROBLEMS);
	});
}

/**
 * Signs in with an emailed code. The first time an address does, this creates
 * its account, with the newsletter on where `newsletter` asks for it (TS-099).
 */
export function signInWithCode(email: string, code: string, newsletter = false): Promise<Outcome> {
	return attempt(async () => {
		const { error } = await auth().signIn.emailOtp({
			email,
			otp: code,
			...(newsletter ? { fetchOptions: { headers: { [NEWSLETTER_HEADER]: "yes" } } } : {}),
		});
		return outcome(error, CODE_PROBLEMS);
	});
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
