import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../db/database";
import {
	captureEmail,
	codeCookie,
	KNOWN_COOKIE,
	knownCookie,
	type Mailbox,
	post,
	requestCode,
	sessionCookie,
	signIn,
	whoIs,
	wrongCode,
} from "./harness";

// The lock-out that docs/decisions.md entry 27 is about: somebody who knows a
// person's address asks for codes for it. A browser the address has been
// signed in from before is counted apart from everybody else, and the code it
// is waiting for is its own.

const EMAIL = "ada@example.com";

let mailbox: Mailbox;
let clients = 0;
let marks = 0;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Asks for a code from a client of its own, so the limit of three a minute for
 * each client is never what answers. `cookie` is what the browser holds.
 */
const ask = (email: string, cookie?: string) =>
	requestCode(email, { client: `192.0.2.${(clients++ % 250) + 1}`, cookie });

/** A stranger asks `times` times: nothing but the address is known to them. */
async function strangersAsk(times: number, email = EMAIL) {
	for (let n = 0; n < times; n++) await ask(email);
}

/**
 * How many codes have been sent to `email`, once every request so far has had
 * the time to send one: a message to somebody else is asked for and waited for,
 * and it leaves after anything an earlier request sent.
 */
async function codesSentTo(email: string): Promise<number> {
	const mark = `mark-${++marks}@example.com`;
	await ask(mark);
	await mailbox.codeFor(mark);
	return mailbox.sent().filter(({ to }) => to === email).length;
}

/** Signs in as `email` in a browser holding `cookie`, and answers what it holds afterwards. */
async function signedInBefore(email = EMAIL, cookie?: string): Promise<string> {
	const { response } = await signIn(mailbox, email, { cookie });
	return knownCookie(response);
}

const signInWith = (email: string, otp: string, ...cookies: string[]) =>
	post("/sign-in/email-otp", { email, otp }, { cookie: cookies.join("; ") });

describe("a browser that has signed in as an address before", () => {
	it("is given a cookie on signing in that script cannot read, for this host alone, kept for a year, with no address in it", async () => {
		const { response } = await signIn(mailbox, EMAIL);

		const cookie = response.headers
			.getSetCookie()
			.find((header) => header.startsWith(`${KNOWN_COOKIE}=`));
		const [nameAndValue = "", ...attributes] = (cookie ?? "").split("; ");
		expect(nameAndValue).toMatch(/^__Host-timesifier\.known_browser=[0-9a-f]{64}$/);
		expect(attributes.sort()).toEqual([
			"HttpOnly",
			`Max-Age=${365 * 24 * 60 * 60}`,
			"Path=/",
			"SameSite=Lax",
			"Secure",
		]);
		expect(decodeURIComponent(nameAndValue)).not.toMatch(/ada|example/i);
	});

	it("can still ask for a code and sign in when strangers have used up the address's five in an hour", async () => {
		// The first sign-in was a stranger's request too: it is one of the five.
		const known = await signedInBefore();
		await strangersAsk(5);
		expect(await codesSentTo(EMAIL), "the strangers' five").toBe(5);

		// However the address is written.
		const asked = await ask("Ada@Example.COM", known);

		expect(await codesSentTo(EMAIL)).toBe(6);
		const response = await signInWith(
			EMAIL,
			await mailbox.codeFor(EMAIL),
			known,
			codeCookie(asked),
		);
		expect(response.status).toBe(200);
		expect(await whoIs(sessionCookie(response))).toMatchObject({ email: EMAIL });
	});

	it("has five an hour of its own: they take none of the strangers' five, and the strangers' take none of them", async () => {
		const known = await signedInBefore();

		let asked = await ask(EMAIL, known);
		for (let n = 0; n < 4; n++) asked = await ask(EMAIL, known);
		expect(await codesSentTo(EMAIL), "one stranger's and five of its own").toBe(6);
		await ask(EMAIL, known);
		expect(await codesSentTo(EMAIL), "its sixth is not sent").toBe(6);

		// Signed in, so that no code of its own is waiting (see the next describe).
		const signedIn = await signInWith(
			EMAIL,
			await mailbox.codeFor(EMAIL),
			known,
			codeCookie(asked),
		);
		expect(signedIn.status).toBe(200);
		await strangersAsk(5);
		expect(await codesSentTo(EMAIL), "the strangers still had four").toBe(10);
	});

	it.each<[string, (value: string) => string | Promise<string>]>([
		[
			"one character of it changed",
			(value) => value.replace(/.$/, (last) => (last === "0" ? "1" : "0")),
		],
		["a hash nobody made", () => "0".repeat(64)],
		["nothing in it", () => ""],
		["the address in it", () => EMAIL],
		[
			"the proof of another address",
			async () => (await signedInBefore("mallory@example.com")).split("=")[1] ?? "",
		],
	])("is a stranger with %s", async (_name, change) => {
		const known = await signedInBefore();
		const [name = "", value = ""] = known.split("=");
		const forged = `${name}=${await change(value)}`;
		await strangersAsk(4);
		expect(await codesSentTo(EMAIL), "the strangers' five").toBe(5);

		await ask(EMAIL, forged);
		expect(await codesSentTo(EMAIL), "the forged proof").toBe(5);

		await ask(EMAIL, known);
		expect(await codesSentTo(EMAIL), "the real one").toBe(6);
	});

	it("is answered exactly as a stranger is, whether or not a code is sent", async () => {
		const known = await signedInBefore();
		/** Everything of an answer but the value of its cookie, which is made from the address. */
		const answer = async (response: Response) => ({
			status: response.status,
			body: await response.text(),
			headers: [...response.headers.keys()].sort(),
			cookies: response.headers.getSetCookie().map((cookie) => cookie.replace(/=[^;]*/, "=")),
			cookieValue: codeCookie(response)
				.replace(/[0-9a-f]/g, "x")
				.replace(/\d/g, "9"),
		});

		const answers = [];
		// A stranger, served. The known browser, served. A stranger while the
		// known browser's code waits.
		answers.push(await answer(await ask(EMAIL)));
		answers.push(await answer(await ask(EMAIL, known)));
		answers.push(await answer(await ask(EMAIL)));
		// The known browser up to its five and past them; strangers past theirs.
		for (let n = 0; n < 5; n++) answers.push(await answer(await ask(EMAIL, known)));
		for (let n = 0; n < 3; n++) answers.push(await answer(await ask(EMAIL)));

		expect(await codesSentTo(EMAIL), "two to strangers, five to the known browser").toBe(7);
		for (const each of answers) expect(each).toEqual(answers[0]);
	});

	it("keeps the proofs of the last five addresses, so a browser that several people share works for each", async () => {
		const people = ["a", "b", "c", "d", "e", "f"].map((name) => `${name}@example.com`);
		let browser: string | undefined;
		for (const person of people) browser = await signedInBefore(person, browser);

		expect(browser).toMatch(/^[^=]+=[0-9a-f]{64}(\.[0-9a-f]{64}){4}$/);
		// The second of the six is still known; the first has made way for the sixth.
		for (const [person, sent] of [
			["b@example.com", 6],
			["a@example.com", 5],
		] as const) {
			await strangersAsk(4, person);
			await ask(person, browser);
			expect(await codesSentTo(person), person).toBe(sent);
		}
	});

	it("is still known after signing out everywhere", async () => {
		const { response, cookie } = await signIn(mailbox, EMAIL);
		const known = knownCookie(response);

		const signedOut = await post("/revoke-sessions", {}, { cookie: `${cookie}; ${known}` });

		expect(signedOut.status).toBe(200);
		expect(signedOut.headers.getSetCookie().join("\n")).not.toContain(KNOWN_COOKIE);
		await strangersAsk(4);
		await ask(EMAIL, known);
		expect(await codesSentTo(EMAIL)).toBe(6);
	});
});

describe("the code a known browser is waiting for", () => {
	it("is not replaced by a stranger's request, which sends nothing", async () => {
		const known = await signedInBefore();
		const asked = await ask(EMAIL, known);

		await strangersAsk(2);

		expect(await codesSentTo(EMAIL), "the first sign-in's and the one that waits").toBe(2);
		const code = await mailbox.codeFor(EMAIL);
		expect((await signInWith(EMAIL, code, known, codeCookie(asked))).status).toBe(200);
	});

	it("is not used up by a stranger's guesses, whether the stranger asked for a code before it or after", async () => {
		const known = await signedInBefore();
		const before = codeCookie(await ask(EMAIL));
		const asked = await ask(EMAIL, known);
		expect(await codesSentTo(EMAIL)).toBe(3);
		const code = await mailbox.codeFor(EMAIL);
		const after = codeCookie(await ask(EMAIL));

		const guesses = [];
		for (const strangers of [before, after]) {
			// Three wrong guesses are all that a code allows.
			for (let n = 0; n < 3; n++) guesses.push(await signInWith(EMAIL, wrongCode(code), strangers));
			guesses.push(await signInWith(EMAIL, code, strangers));
		}

		for (const refused of guesses) {
			expect(refused.status).toBe(400);
			expect(await refused.json()).toMatchObject({ code: "INVALID_OTP" });
		}
		expect((await signInWith(EMAIL, code, known, codeCookie(asked))).status).toBe(200);
	});

	it("holds strangers back no longer once it has signed the person in", async () => {
		const known = await signedInBefore();
		const asked = await ask(EMAIL, known);
		// Its code is sent after the answer: waited for, so the latest is this one.
		expect(await codesSentTo(EMAIL)).toBe(2);
		const signedIn = await signInWith(
			EMAIL,
			await mailbox.codeFor(EMAIL),
			known,
			codeCookie(asked),
		);
		expect(signedIn.status).toBe(200);

		// The same person, a minute later, on a telephone that has never signed in.
		const elsewhere = await ask(EMAIL);

		expect(await codesSentTo(EMAIL)).toBe(3);
		const response = await signInWith(EMAIL, await mailbox.codeFor(EMAIL), codeCookie(elsewhere));
		expect(response.status).toBe(200);
	});

	it("gives way to a newer one that the known browser asks for itself", async () => {
		const known = await signedInBefore();
		const first = await ask(EMAIL, known);
		const old = await mailbox.codeFor(EMAIL);
		const second = await ask(EMAIL, known);
		expect(await codesSentTo(EMAIL)).toBe(3);
		const newest = await mailbox.codeFor(EMAIL);

		expect((await signInWith(EMAIL, old, known, codeCookie(first))).status).toBe(400);
		expect((await signInWith(EMAIL, newest, known, codeCookie(second))).status).toBe(200);
	});
});
