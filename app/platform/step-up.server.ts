import { env, waitUntil } from "cloudflare:workers";

import type { SignedIn } from "~/auth/auth.server";
import { SIGN_IN_CODE_LENGTH } from "~/auth/code";
import { sendEmail } from "~/auth/email.server";
import { isKeyedHash, keyedHash } from "~/auth/keyed-hash.server";
import { platformData } from "~/db";
import { required } from "~/lib/deployment";

import { STEP_UP_CODE_SECONDS, stepUpCodeEmail } from "./emails";
import { STEP_UP_ATTEMPTS, STEP_UP_HOURS, STEP_UP_SENDS } from "./limits";

// The platform console's step-up (TS-099, docs/security.md, "The platform
// console"). Signing in is not enough to open the console: each session must
// prove the owner's inbox again, with a code of its own sent to the address
// the session belongs to. A code is kept as a keyed hash bound to the session,
// works once, for five minutes, against three wrong tries; a session may ask
// for five. A proved session stays open for twelve hours at most, and ends
// with the session.

const PURPOSE = "platform-step-up";

/** A code of `SIGN_IN_CODE_LENGTH` digits, each drawn evenly from 0 to 9. */
function newCode(): string {
	const digits: number[] = [];
	while (digits.length < SIGN_IN_CODE_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(SIGN_IN_CODE_LENGTH))) {
			if (byte < 250 && digits.length < SIGN_IN_CODE_LENGTH) digits.push(byte % 10);
		}
	}
	return digits.join("");
}

/** Whether the session has proved its owner's inbox, and recently enough. */
export async function isSteppedUp({ session }: SignedIn, now: Date): Promise<boolean> {
	const stepUp = await platformData.stepUpOf(env.DB, session.id);
	return (
		stepUp?.verifiedAt !== null &&
		stepUp?.verifiedAt !== undefined &&
		now.getTime() - stepUp.verifiedAt.getTime() < STEP_UP_HOURS * 3_600_000
	);
}

export type StepUpOutcome =
	| { ok: true }
	| { ok: false; problem: "too-many" | "wrong-code" | "expired-code" | "no-code" };

/** Sends a new code to the session's own address, replacing any waiting one. */
export async function sendStepUpCode(
	{ session, user }: SignedIn,
	now: Date,
): Promise<StepUpOutcome> {
	const stepUp = await platformData.stepUpOf(env.DB, session.id);
	if (stepUp && stepUp.sent >= STEP_UP_SENDS) return { ok: false, problem: "too-many" };
	const code = newCode();
	await platformData.keepStepUpCode(env.DB, {
		sessionId: session.id,
		userId: user.id,
		codeHash: await keyedHash(
			required(env, "BETTER_AUTH_SECRET"),
			PURPOSE,
			`${session.id}\n${code}`,
		),
		expiresAt: new Date(now.getTime() + STEP_UP_CODE_SECONDS * 1000),
	});
	waitUntil(sendEmail({ to: user.email, ...stepUpCodeEmail(code) }));
	return { ok: true };
}

/** Proves the session with `code`. Every outcome but a right code changes nothing but the count of tries. */
export async function proveStepUp(
	{ session, user }: SignedIn,
	code: string,
	now: Date,
): Promise<StepUpOutcome> {
	const stepUp = await platformData.stepUpOf(env.DB, session.id);
	if (!stepUp?.codeHash || !stepUp.codeExpiresAt) return { ok: false, problem: "no-code" };
	if (stepUp.attempts >= STEP_UP_ATTEMPTS) return { ok: false, problem: "too-many" };
	if (stepUp.codeExpiresAt.getTime() <= now.getTime())
		return { ok: false, problem: "expired-code" };
	const right = await isKeyedHash(
		required(env, "BETTER_AUTH_SECRET"),
		PURPOSE,
		`${session.id}\n${code}`,
		stepUp.codeHash,
	);
	if (!right) {
		await platformData.countStepUpAttempt(env.DB, session.id);
		return { ok: false, problem: "wrong-code" };
	}
	await platformData.markSteppedUp(env.DB, session.id, now);
	await platformData.recordPlatformEvent(env.DB, {
		actorId: user.id,
		action: "console.opened",
		subjectType: "console",
	});
	return { ok: true };
}
