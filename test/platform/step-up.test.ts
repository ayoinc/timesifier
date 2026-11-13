import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSession, type SignedIn } from "~/auth/auth.server";
import { SIGN_IN_CODE_LENGTH } from "~/auth/code";
import { platformData } from "~/db";
import { STEP_UP_CODE_SECONDS } from "~/platform/emails";
import { STEP_UP_ATTEMPTS, STEP_UP_HOURS, STEP_UP_SENDS } from "~/platform/limits";
import { isPlatformOwner, platformOwners } from "~/platform/owners.server";
import { isSteppedUp, proveStepUp, sendStepUpCode } from "~/platform/step-up.server";
import { captureEmail, type Mailbox, ORIGIN, setBinding, wrongCode } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { value } from "../organisations/harness";
import { type Person, person } from "../pages/harness";
import { ownTheConsole, PLATFORM_OWNER } from "./harness";

// The console's step-up (TS-099, docs/security.md, "The platform console"),
// below its page: a code bound to one session, good for five minutes, against
// three wrong tries, five codes a session; a proved session stays open for
// twelve hours and ends with the session. And who the owners are: the
// `PLATFORM_OWNERS` secret, read leniently, closed when it is missing.

const T0 = new Date("2026-11-12T12:00:00Z");
const HOUR = 3_600_000;
const CODE_SUBJECT = "Your Timesifier platform console code";
/** A code where it stands alone in a message. */
const CODE = new RegExp(`\\b\\d{${SIGN_IN_CODE_LENGTH}}\\b`);

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ownTheConsole();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** The session `who` carries, as a route guard reads it. */
async function sessionOf(who: Person): Promise<SignedIn> {
	const signedIn = await getSession(
		new Request(`${ORIGIN}/`, { headers: { Cookie: who.cookie, "CF-Connecting-IP": who.client } }),
	);
	if (!signedIn) throw new Error("that person has no session");
	return signedIn;
}

/** Asks for a code for `session` and reads it from the message it sends. */
async function codeFor(session: SignedIn, at = T0): Promise<string> {
	const before = mailbox.sent().filter((m) => m.subject === CODE_SUBJECT).length;
	expect(await sendStepUpCode(session, at)).toEqual({ ok: true });
	return vi.waitFor(() => {
		const codes = mailbox.sent().filter((m) => m.subject === CODE_SUBJECT);
		const code = codes.length > before ? codes.at(-1)?.text.match(CODE)?.[0] : undefined;
		if (!code) throw new Error("no step-up code yet");
		expect(codes.at(-1)?.to).toBe(PLATFORM_OWNER);
		return code;
	});
}

const at = (milliseconds: number) => new Date(T0.getTime() + milliseconds);

describe("a step-up code", () => {
	it("works until five minutes have passed, and not from then on", async () => {
		const session = await sessionOf(await person(mailbox, PLATFORM_OWNER));
		const code = await codeFor(session);
		const expiry = STEP_UP_CODE_SECONDS * 1000;
		expect(expiry).toBe(5 * 60_000);

		expect(await proveStepUp(session, code, at(expiry))).toEqual({
			ok: false,
			problem: "expired-code",
		});
		expect(await isSteppedUp(session, at(expiry))).toBe(false);
		expect(await proveStepUp(session, code, at(expiry - 1))).toEqual({ ok: true });
		expect(await isSteppedUp(session, at(expiry - 1))).toBe(true);
		expect(
			await value(
				"select count(*) from platform_events where action = 'console.opened' and actor_id = ?",
				session.user.id,
			),
		).toBe(1);
	});

	it("survives three wrong tries, and after them not even the right code opens the console", async () => {
		const session = await sessionOf(await person(mailbox, PLATFORM_OWNER));
		const code = await codeFor(session);

		for (let n = 0; n < STEP_UP_ATTEMPTS; n++) {
			expect(await proveStepUp(session, wrongCode(code), T0)).toEqual({
				ok: false,
				problem: "wrong-code",
			});
		}
		expect(await proveStepUp(session, code, T0)).toEqual({ ok: false, problem: "too-many" });
		expect(await isSteppedUp(session, T0)).toBe(false);

		// A new code starts the tries again.
		const next = await codeFor(session);
		expect(await proveStepUp(session, next, T0)).toEqual({ ok: true });
	});

	it("is sent at most five times to one session", async () => {
		const session = await sessionOf(await person(mailbox, PLATFORM_OWNER));
		for (let n = 0; n < STEP_UP_SENDS; n++) await codeFor(session);

		// Refused before anything is sent: the count of messages stays at five.
		expect(await sendStepUpCode(session, T0)).toEqual({ ok: false, problem: "too-many" });
		expect(mailbox.sent().filter((m) => m.subject === CODE_SUBJECT)).toHaveLength(STEP_UP_SENDS);
	});

	it("is bound to the session that asked for it, not to the owner", async () => {
		const first = await sessionOf(await person(mailbox, PLATFORM_OWNER));
		const second = await sessionOf(await person(mailbox, PLATFORM_OWNER));
		expect(second.session.id).not.toBe(first.session.id);
		const code = await codeFor(first);

		expect(await proveStepUp(second, code, T0)).toEqual({ ok: false, problem: "no-code" });
		await codeFor(second);
		expect(await proveStepUp(second, code, T0)).toEqual({ ok: false, problem: "wrong-code" });
		expect(await isSteppedUp(second, T0)).toBe(false);

		expect(await proveStepUp(first, code, T0)).toEqual({ ok: true });
		expect(await isSteppedUp(first, T0)).toBe(true);
		expect(await isSteppedUp(second, T0)).toBe(false);
	});

	it("works once", async () => {
		const session = await sessionOf(await person(mailbox, PLATFORM_OWNER));
		const code = await codeFor(session);
		expect(await proveStepUp(session, code, T0)).toEqual({ ok: true });

		expect(await proveStepUp(session, code, at(1000))).toEqual({ ok: false, problem: "no-code" });
	});

	it("answers no-code when none was asked for", async () => {
		const session = await sessionOf(await person(mailbox, PLATFORM_OWNER));
		expect(await proveStepUp(session, "123456", T0)).toEqual({ ok: false, problem: "no-code" });
	});
});

describe("a proved session", () => {
	it("keeps the console open for twelve hours", async () => {
		const session = await sessionOf(await person(mailbox, PLATFORM_OWNER));
		expect(await proveStepUp(session, await codeFor(session), T0)).toEqual({ ok: true });

		expect(STEP_UP_HOURS).toBe(12);
		expect(await isSteppedUp(session, at(12 * HOUR - 1))).toBe(true);
		expect(await isSteppedUp(session, at(12 * HOUR))).toBe(false);
	});

	it("loses its step-up with the session", async () => {
		const session = await sessionOf(await person(mailbox, PLATFORM_OWNER));
		expect(await proveStepUp(session, await codeFor(session), T0)).toEqual({ ok: true });
		expect(await platformData.stepUpOf(env.DB, session.session.id)).not.toBeNull();

		await env.DB.prepare("delete from sessions where id = ?").bind(session.session.id).run();

		expect(await platformData.stepUpOf(env.DB, session.session.id)).toBeNull();
		expect(await isSteppedUp(session, T0)).toBe(false);
	});
});

describe("the platform's owners", () => {
	it("are the secret's addresses, trimmed and lower-cased on both sides", () => {
		setBinding("PLATFORM_OWNERS", " Root@Timesifier.Example ,  second@example.com,");

		expect([...platformOwners()]).toEqual(["root@timesifier.example", "second@example.com"]);
		expect(isPlatformOwner("ROOT@timesifier.example ")).toBe(true);
		expect(isPlatformOwner(" Second@Example.com")).toBe(true);
		expect(isPlatformOwner("root@timesifier.example.evil")).toBe(false);
		expect(isPlatformOwner("")).toBe(false);
	});

	it("are nobody when the secret is empty or missing: the console is closed", () => {
		for (const secret of ["", " , ", undefined]) {
			setBinding("PLATFORM_OWNERS", secret);
			expect(platformOwners().size).toBe(0);
			expect(isPlatformOwner(PLATFORM_OWNER)).toBe(false);
			expect(isPlatformOwner("")).toBe(false);
		}
	});

	it("ignore entries that are not one address", () => {
		setBinding(
			"PLATFORM_OWNERS",
			"not-an-address, two words@example.com, <angle@example.com>, a@b@c, good@example.com; x@y.z, good2@example.com",
		);

		expect([...platformOwners()]).toEqual(["good2@example.com"]);
		expect(isPlatformOwner("good@example.com")).toBe(false);
		expect(isPlatformOwner("angle@example.com")).toBe(false);
	});
});
