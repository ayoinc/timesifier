import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_PATH } from "~/shell/destinations";

import { captureEmail, type Mailbox, ORIGIN } from "./auth/harness";
import { freshDatabase } from "./db/database";
import { createOrganisation, invite } from "./organisations/harness";
import { open, type Person, pageBody, person, textOf } from "./pages/harness";
import { allRoutes } from "./routes";

// Card TS-036: there is one way in. The sign-in page takes a person who is new
// and a person coming back alike, so nothing a person can read speaks of making
// an account, and the address of the page that used to is answered with the way
// to the one page.

const worker = exports.default;

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/sign-up, where a page for new people once was", () => {
	const ask = (path: string, init: RequestInit = {}) =>
		worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, redirect: "manual" }));

	it.each([
		["/sign-up", "/sign-in"],
		["/sign-up?next=/invitations/abc", "/sign-in?next=%2Finvitations%2Fabc"],
		[
			"/sign-up?next=%2Fapp%2Facme%2Freports%3Fweek%3D46",
			"/sign-in?next=%2Fapp%2Facme%2Freports%3Fweek%3D46",
		],
		// Every other query is dropped.
		["/sign-up?utm_source=mail&next=/invitations/abc&x=1", "/sign-in?next=%2Finvitations%2Fabc"],
		["/sign-up?email=ada@example.com", "/sign-in"],
		// Where a person goes afterwards is judged by the one rule for it.
		["/sign-up?next=https://attacker.example/app", "/sign-in"],
		["/sign-up?next=//attacker.example/app", "/sign-in"],
		["/sign-up?next=/sign-up", "/sign-in"],
	])("%s is answered 302 with Location %s", async (path, location) => {
		const response = await ask(path);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(location);
		expect(await response.text()).toBe("");
		// It is the Worker's answer like any other: the browser policy is on it.
		expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
	});

	it("is answered the same for a person with a session, who is then sent on by the sign-in page", async () => {
		const ada = await person(mailbox, "ada@example.com");

		const response = await open("/sign-up?next=/invitations/abc", ada);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/sign-in?next=%2Finvitations%2Fabc");
		const onward = await open(response.headers.get("Location") ?? "", ada);
		expect(onward.headers.get("Location")).toBe("/invitations/abc");
	});

	it("is not a route: nothing below it, and no data of its own, is answered as it", async () => {
		for (const path of ["/sign-up/", "/sign-up/x", "/sign-up.data"]) {
			const response = await ask(path);
			expect(response.status, path).toBe(404);
		}
		expect(allRoutes.map(({ address }) => address)).not.toContain("/sign-up");
	});

	it("takes no form: a POST is not redirected", async () => {
		const response = await ask("/sign-up", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
			body: "email=ada@example.com",
		});

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.headers.get("Location")).toBeNull();
	});

	it("is still production's alone: another host is answered 404 first", async () => {
		const response = await worker.fetch(
			new Request("https://41b1b1d9-timesifier.acme.workers.dev/sign-up", { redirect: "manual" }),
		);
		expect(response.status).toBe(404);
	});
});

/** What nothing a person reads may say: there is no page that makes an account. */
const FORMER_WORDS = /creat(e|ing) (an |your )?account|sign(ed|ing)?[ -]?up/i;

describe("the words", () => {
	/** Every page the server renders for this person: its address and its HTML. */
	async function pages(who: Person | undefined, addresses: string[]) {
		const rendered: [string, string][] = [];
		for (const address of addresses) {
			const response = await open(address, who);
			if (!response.headers.get("Content-Type")?.includes("text/html")) continue;
			rendered.push([address, await pageBody(response)]);
		}
		return rendered;
	}

	it("no page the server renders, and no email, speaks of creating an account or signing up", async () => {
		// Ada owns two organisations, so `/app` is a page; Bob has been invited to one.
		const ada = await person(mailbox, "ada@example.com");
		const acme = await createOrganisation(ada.cookie, "Acme");
		await createOrganisation(ada.cookie, "Globex");
		const { id } = await invite(ada.cookie, acme.id, "bob@example.com");
		const bob = await person(mailbox, "bob@example.com");

		const everyRoute = allRoutes
			.map(({ address }) => address)
			.filter((address) => !address.startsWith("/api/"));
		const read = [
			// Signed out: the public pages, and the page nothing answers.
			...(await pages(undefined, [...everyRoute, "/no-such-page"])),
			// Signed in, in an organisation.
			...(await pages(ada, [...everyRoute, "/no-such-page", "/app/no-such-organisation"])),
			// Signed in, in none: the page a new account lands on, and an invitation both ways.
			...(await pages(bob, [APP_PATH, "/app/new", `/invitations/${id}`, "/invitations/x"])),
		];

		// The pages a person meets on the way in are all among them.
		const addresses = read.map(([address]) => address);
		for (const met of ["/", "/sign-in", "/privacy", "/terms", "/app/new", `/invitations/${id}`]) {
			expect(addresses).toContain(met);
		}
		expect(read.length).toBeGreaterThan(15);
		for (const [address, html] of read) {
			expect(html, address).not.toMatch(FORMER_WORDS);
		}

		// The two messages: a sign-in code, and an invitation.
		const sent = mailbox.sent();
		expect(sent.some(({ subject }) => subject.includes("sign-in code"))).toBe(true);
		expect(sent.some(({ subject }) => subject.includes("invited"))).toBe(true);
		for (const { subject, text, html } of sent) {
			expect(`${subject}\n${text}\n${html}`, subject).not.toMatch(FORMER_WORDS);
		}
	});

	it("the sign-in page speaks to a person who is new and a person coming back in the same words", async () => {
		const response = await open("/sign-in");
		const html = await pageBody(response);
		const text = textOf(html);

		expect(html).toContain("<title>Sign in · Timesifier</title>");
		expect(html).toMatch(/<h1[^>]*>Enter your email<\/h1>/);
		expect(text).toContain(
			"We will email you a code. If you are new here, the same code sets you up.",
		);
		expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Continue<\/button>/);
		// One field: no name is asked on the way in. Beside it, the newsletter's
		// box, unticked until the person ticks it (TS-099).
		const inputs = html.match(/<input\b[^>]*>/g) ?? [];
		expect(inputs).toHaveLength(2);
		expect(inputs.filter((input) => /type="email"/.test(input))).toHaveLength(1);
		const box = inputs.find((input) => /type="checkbox"/.test(input));
		expect(box).toMatch(/name="newsletter"/);
		expect(box).not.toMatch(/\bchecked\b/);
		expect(text).toContain("New here? Email me the Timesifier newsletter.");
		// Where script does not run, the page says so.
		expect(html).toMatch(/<noscript>.*Signing in needs JavaScript\..*<\/noscript>/s);
	});
});

describe("the source", () => {
	// Only the words are read: nothing is run.
	const source = import.meta.glob<string>(["../app/**/*.{ts,tsx,css}", "../workers/**/*.ts"], {
		eager: true,
		query: "?raw",
		import: "default",
	});

	it("names the former page only where its address is reserved and where it is answered", () => {
		expect(Object.keys(source).length).toBeGreaterThan(50);
		const naming = Object.entries(source)
			.filter(([, text]) => /sign[-_ ]?up/i.test(text))
			.map(([file]) => file)
			.sort();

		expect(naming).toEqual([
			// An organisation may not take the address.
			"../app/organisations/slug.ts",
			// The Worker answers it, and its entry calls that step.
			"../workers/app.ts",
			"../workers/former-sign-up.ts",
		]);
		for (const [file, text] of Object.entries(source)) {
			expect(text, file).not.toMatch(/creat(e|ing) (an |your )?account/i);
		}
	});
});
