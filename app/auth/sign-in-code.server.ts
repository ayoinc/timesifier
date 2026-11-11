/**
 * The emailed sign-in code: the rules of ours that Better Auth's email-code
 * plugin does not hold itself. Each runs after the rate limit and Turnstile
 * and before the plugin sees the request.
 *
 * - A request carries exactly the fields listed here. The plugin would also
 *   issue a code of three other kinds, and take an image for a new account and
 *   a name of any length and any JSON type.
 * - An address is sent at most five codes in any hour to the browsers that
 *   have signed in as it before, and five to everybody else. A code allows
 *   three guesses, so without a cap the guesses against one address are three
 *   times however many codes can be asked for; and with one count for
 *   everybody, somebody who knows the address could use all of it up.
 *   docs/decisions.md entry 27.
 * - A code is used in the browser that asked for it, and for that very code.
 *   The answer to a request for a code sets a cookie that names the request; a
 *   guess from any browser but the one whose request the live code answers
 *   never reaches the plugin, so nobody else can use up the three guesses of a
 *   code somebody is about to type. docs/decisions.md entries 22 and 27.
 * - The code that a browser which has signed in before is waiting for is not
 *   replaced by anybody else's request. The plugin answers every request with
 *   a new code and compares a guess with the newest alone, so while such a
 *   code waits, a stranger's request is answered as ever and issues nothing.
 *
 * See docs/security.md, "Authentication".
 */
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth/types";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as z from "zod";
import { uuidv7 } from "~/db";
import { valid } from "./input.server";
import { isKeyedHash, keyedHash } from "./keyed-hash.server";
import {
	isKnownBrowser,
	KNOWN_BROWSER_COOKIE,
	KNOWN_BROWSER_KEPT_SECONDS,
	withProofFor,
} from "./known-browser.server";
import { PersonName } from "./person-name";
import { type Cap, takeOne } from "./quota.server";
import { CODE_LIFETIME_SECONDS } from "./sign-in-code-email";

const ASK_PATH = "/email-otp/send-verification-otp";
const USE_PATH = "/sign-in/email-otp";

/**
 * What each request may carry: these keys and no other, and the one kind of
 * code. What an address and a code must be is the plugin's to say, in its own
 * words.
 */
const Asking = z.strictObject({ email: z.unknown(), type: z.literal("sign-in") });
const Using = z.strictObject({
	email: z.unknown(),
	otp: z.unknown(),
	name: PersonName.optional(),
});

/** For each of the two kinds of asker, apart. */
const CODES_PER_HOUR: Cap = { max: 5, seconds: 60 * 60 };

/** Who asks for a code: a browser that holds a proof for the address, or anybody else. */
type Asker = "known" | "stranger";

/**
 * The cookie that proves a browser asked. Better Auth puts the application's
 * prefix and attributes on it: `__Host-timesifier.sign_in_code`, `HttpOnly`,
 * `Secure`, `SameSite=Lax`, `Path=/`.
 *
 * Its value is `<expiry>.<number>.<hash>`: when the proof stops counting, in
 * seconds since the epoch, which is when the code does; a random number that
 * is this request's alone; and the keyed hash of the lower-cased address, that
 * expiry and that number. There is no address in it, and nobody without the
 * secret can make one, move its expiry or give it another request's number.
 *
 * The browser keeps it for an hour, longer than it counts, for one reason: a
 * person who types their code too late is then told that it has expired, in
 * the plugin's words for that, and not that it is wrong.
 */
const PROOF_COOKIE = "sign_in_code";
const PROOF_PURPOSE = "sign-in-code-proof";
const PROOF_KEPT_SECONDS = 60 * 60;

/**
 * Whose request the address's live code answers: one row in `verifications`,
 * beside the plugin's own, for each address with a code out. `identifier`
 * holds a keyed hash of the address, `value` is `<asker>:<number>` with the
 * number from that request's cookie, and `expires_at` is when the code stops
 * working. Better Auth deletes the row with its own expired ones.
 */
const liveCodeOf = (addressHash: string) => `sign-in-code-asker:${addressHash}`;

/**
 * Makes a request the one that the address's live code answers, and says
 * whether it did. A stranger's request does not while the code of a browser
 * that has signed in before is waiting.
 *
 * The two statements run as one transaction, so of requests arriving together
 * one is left as the asker and the row is never missing in between. They are
 * given to D1 itself: Drizzle 0.45 cannot batch a raw statement that has
 * parameters.
 */
async function becomeAsker(
	db: D1Database,
	identifier: string,
	asker: Asker,
	number: string,
	expiresAt: number,
): Promise<boolean> {
	const now = Date.now();
	const [, inserted] = await db.batch([
		db
			.prepare(
				`delete from verifications
				where identifier = ?1
				and (?2 or not (value like 'known:%' and expires_at > ?3))`,
			)
			.bind(identifier, asker === "known" ? 1 : 0, now),
		db
			.prepare(
				`insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
				select ?1, ?2, ?3, ?4, ?5, ?5
				where not exists (select 1 from verifications where identifier = ?2)`,
			)
			.bind(uuidv7(), identifier, `${asker}:${number}`, expiresAt, now),
	]);
	return inserted?.meta.changes === 1;
}

type Bindings = { DB: D1Database; secret: string };

/** Spread into Better Auth's `plugins`. */
export function signInCodeRules({ DB, secret }: Bindings): BetterAuthPlugin {
	// A keyed hash wherever a row is named after an address: the table never
	// holds one in the clear.
	const hashOf = (address: string) => keyedHash(secret, "sign-in-code-address", address);

	const asking = createAuthMiddleware(async (ctx) => {
		const { email } = await valid(Asking, ctx.body);
		// The plugin lower-cases the address and then refuses what is not one.
		// The same two steps here, so a code is counted only where one would be issued.
		if (typeof email !== "string") return;
		const address = email.toLowerCase();
		if (!z.email().safeParse(address).success) return;

		// Set whether or not a code follows, so the cookie says nothing the answer does not.
		const expiry = Math.ceil(Date.now() / 1000) + CODE_LIFETIME_SECONDS;
		const number = crypto.randomUUID();
		const proof = await keyedHash(secret, PROOF_PURPOSE, `${address}\n${expiry}\n${number}`);
		const { name, attributes } = ctx.context.createAuthCookie(PROOF_COOKIE, {
			maxAge: PROOF_KEPT_SECONDS,
		});
		ctx.setCookie(name, `${expiry}.${number}.${proof}`, attributes);

		const known = ctx.getCookie(ctx.context.createAuthCookie(KNOWN_BROWSER_COOKIE).name);
		const asker: Asker = (await isKnownBrowser(secret, known, address)) ? "known" : "stranger";
		const addressHash = await hashOf(address);
		// A use is taken before the request may become the asker: one that is
		// over its cap must not put aside the code somebody else is waiting for.
		const served =
			(await takeOne(DB, `sign-in-code:${asker}:${addressHash}`, CODES_PER_HOUR)) &&
			(await becomeAsker(DB, liveCodeOf(addressHash), asker, number, expiry * 1000));
		if (!served) {
			// The plugin's answer to a request it served, so neither the cap nor a
			// waiting code tells anybody that an address has been asking, or which
			// kind of asker they were taken for. Nothing is issued or sent.
			return ctx.json({ success: true });
		}
	});

	const using = createAuthMiddleware(async (ctx) => {
		const { email } = await valid(Using, ctx.body);
		// Not an address at all: the plugin refuses it, and no code is compared.
		if (typeof email !== "string") return;
		const address = email.toLowerCase();

		const { name } = ctx.context.createAuthCookie(PROOF_COOKIE);
		const [expiry = "", number = "", proof = ""] = (ctx.getCookie(name) ?? "").split(".");
		const asked =
			/^\d+$/.test(expiry) &&
			(await isKeyedHash(secret, PROOF_PURPOSE, `${address}\n${expiry}\n${number}`, proof));
		// Each refusal is the plugin's own answer, key for key, given before the
		// plugin counts a guess. A browser that never asked gets the answer to a
		// wrong code. One that asked more than five minutes ago gets the answer to
		// an expired code, whatever newer code somebody else has asked for since.
		if (!asked) throw new APIError("BAD_REQUEST", { message: "Invalid OTP", code: "INVALID_OTP" });
		if (Number(expiry) * 1000 <= Date.now()) {
			throw new APIError("BAD_REQUEST", { message: "OTP expired", code: "OTP_EXPIRED" });
		}
		// And one that asked, but whose request is not the one the live code
		// answers, gets the answer to a wrong code too: a newer request took its
		// place, its own was over the cap, or it was a stranger's while a known
		// browser's code waited.
		const live = await drizzle(DB).get<{ value: string }>(
			sql`select value from verifications where identifier = ${liveCodeOf(await hashOf(address))}`,
		);
		if (!live?.value.endsWith(`:${number}`)) {
			throw new APIError("BAD_REQUEST", { message: "Invalid OTP", code: "INVALID_OTP" });
		}
	});

	const signedIn = createAuthMiddleware(async (ctx) => {
		// A session was made: the code was right. Any other answer changes nothing.
		const address = ctx.context.newSession?.user.email.toLowerCase();
		if (!address) return;

		// From now on this browser is one the address has been signed in from.
		const { name, attributes } = ctx.context.createAuthCookie(KNOWN_BROWSER_COOKIE, {
			maxAge: KNOWN_BROWSER_KEPT_SECONDS,
		});
		ctx.setCookie(name, await withProofFor(secret, ctx.getCookie(name), address), attributes);

		// The code is used, so nobody is waiting for it: a stranger's request,
		// which may be this person's on another device, is served again at once.
		const identifier = liveCodeOf(await hashOf(address));
		await drizzle(DB).run(sql`delete from verifications where identifier = ${identifier}`);
	});

	return {
		id: "sign-in-code-rules",
		hooks: {
			before: [
				{ matcher: (ctx) => ctx.path === ASK_PATH, handler: asking },
				{ matcher: (ctx) => ctx.path === USE_PATH, handler: using },
			],
			after: [{ matcher: (ctx) => ctx.path === USE_PATH, handler: signedIn }],
		},
	};
}
