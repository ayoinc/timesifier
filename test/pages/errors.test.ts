import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { COLOR_SCHEME_COOKIE } from "~/shell/color-scheme.server";
import { organisationPath } from "~/shell/destinations";
import { errorWords, NOT_YOURS, NOTHING_HERE } from "~/shell/error-words";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership } from "../organisations/harness";
import { open, openData, type Person, pageBody, person, textOf } from "./harness";

// Audit W14: an error inside an organisation is drawn inside its shell, with
// the band, the organisation's name and the navigation kept; every error page
// keeps the colour scheme the person chose; and each says what happened by its
// status, never "Internal Server Error" for a request that was the asker's.

const ACME = organisationPath("acme");
const NAVIGATION = '<nav aria-label="Main"';

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

/** Ada, who owns Acme, at /app/acme. */
async function ada(): Promise<Person> {
	const who = await person(mailbox, "ada@example.com");
	expect((await createOrganisation(who.cookie, "Acme")).slug).toBe("acme");
	return who;
}

/** The same person, with a colour scheme chosen on My account. */
function choosing(who: Person, scheme: "light" | "dark" | "system"): Person {
	return { ...who, cookie: `${who.cookie}; ${COLOR_SCHEME_COOKIE}=${scheme}` };
}

function htmlTag(html: string): string | undefined {
	return html.match(/<html[^>]*>/)?.[0];
}

describe("an address under the person's own organisation that holds no page", () => {
	it("is 404, drawn inside the shell: the band, the organisation's name, the navigation and a way to the Timesheet", async () => {
		const response = await open(`${ACME}/does-not-exist`, await ada());
		expect(response.status).toBe(404);

		const html = await pageBody(response);
		const text = textOf(html);
		expect(html).toContain(NAVIGATION);
		expect(text).toContain("Acme");
		expect(html).toMatch(/<h1[^>]*>There(&#x27;|')s no page here<\/h1>/);
		expect(html).toMatch(/<title>There(&#x27;|')s no page here · Timesifier<\/title>/);
		expect(text).toContain(NOTHING_HERE);
		expect(html).toMatch(new RegExp(`<a[^>]*href="${ACME}"[^>]*>Go to the Timesheet</a>`));
		expect(text).not.toContain("Internal Server Error");
	});

	it("is 404 a level deeper too, inside the shell, and for the data a move to it asks for", async () => {
		const who = await ada();
		const deeper = await open(`${ACME}/projects/nothing/here`, who);
		expect(deeper.status).toBe(404);
		expect(await pageBody(deeper)).toContain(NAVIGATION);
		expect((await openData(`${ACME}/does-not-exist`, who)).status).toBe(404);
	});

	it("below a destination the person is not shown, is the stranger's 404, with no shell", async () => {
		const who = await ada();
		await env.DB.prepare("update organisations set clients_enabled = 0 where slug = ?")
			.bind("acme")
			.run();

		const response = await open(`${ACME}/clients/nothing`, who);
		expect(response.status).toBe(404);
		const html = await pageBody(response);
		expect(html).not.toContain(NAVIGATION);
		expect(textOf(html)).toContain(NOT_YOURS);
	});

	it("stays dark for a person who chose dark", async () => {
		const html = await pageBody(
			await open(`${ACME}/does-not-exist`, choosing(await ada(), "dark")),
		);
		expect(htmlTag(html)).toBe('<html lang="en" data-color-scheme="dark">');
	});
});

describe("an address in the organisation that asks for something that is not valid", () => {
	for (const address of [`${ACME}/approvals?status=bogus`, `${ACME}?view=bogus`]) {
		it(`${address} is 400, drawn inside the shell and said as such`, async () => {
			const response = await open(address, choosing(await ada(), "dark"));
			expect(response.status).toBe(400);

			const html = await pageBody(response);
			const text = textOf(html);
			expect(html).toContain(NAVIGATION);
			expect(htmlTag(html)).toBe('<html lang="en" data-color-scheme="dark">');
			expect(text).toContain("That address asks for something that isn't valid");
			expect(html).toMatch(
				/<title>That address asks for something that isn(&#x27;|')t valid · Timesifier<\/title>/,
			);
			expect(text).not.toContain("Internal Server Error");
			expect(text).not.toContain("Something went wrong");
		});
	}
});

describe("an error page drawn before any loader ran", () => {
	it("for a member at a destination their role is not shown: 404 with the stranger's words, in their scheme", async () => {
		const owner = await person(mailbox, "ada@example.com");
		const acme = await createOrganisation(owner.cookie, "Acme");
		const bob = await person(mailbox, "bob@example.com");
		await seedMembership(acme.id, bob.user.id, "member");

		for (const segment of ["team/members", "team/invitations", "settings"]) {
			const response = await open(`${ACME}/${segment}`, choosing(bob, "dark"));
			expect(response.status, segment).toBe(404);
			const html = await pageBody(response);
			expect(textOf(html), segment).toContain(NOT_YOURS);
			expect(html, segment).not.toContain(NAVIGATION);
			expect(htmlTag(html), segment).toBe('<html lang="en" data-color-scheme="dark">');
			expect(html, segment).toMatch(/<title>There(&#x27;|')s no page here · Timesifier<\/title>/);
		}
	});

	it("for an organisation that is not the person's keeps their scheme, and shows no shell", async () => {
		const who = choosing(await ada(), "dark");
		await createOrganisation((await person(mailbox, "grace@example.com")).cookie, "Initech");

		const response = await open(`${organisationPath("initech")}/does-not-exist`, who);
		expect(response.status).toBe(404);
		const html = await pageBody(response);
		expect(htmlTag(html)).toBe('<html lang="en" data-color-scheme="dark">');
		expect(html).not.toContain(NAVIGATION);
		expect(html).not.toContain("Initech");
		expect(textOf(html)).toContain(NOT_YOURS);
		expect(html).toMatch(/<title>There(&#x27;|')s no page here · Timesifier<\/title>/);
	});

	it("for an address no route answers keeps the scheme of a person signed out", async () => {
		const signedOut = { cookie: `${COLOR_SCHEME_COOKIE}=dark`, client: "198.51.100.250" } as Person;
		const response = await open("/no-such-page", signedOut);
		expect(response.status).toBe(404);
		const html = await pageBody(response);
		expect(htmlTag(html)).toBe('<html lang="en" data-color-scheme="dark">');
		expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Go to the home page<\/a>/);
	});

	it("follows the device for a person who chose that, and is light for one who chose nothing", async () => {
		const who = await ada();
		const nobodys = `${organisationPath("globex")}/x`;
		expect(htmlTag(await pageBody(await open(nobodys, choosing(who, "system"))))).toBe(
			'<html lang="en">',
		);
		expect(htmlTag(await pageBody(await open(nobodys, who)))).toBe(
			'<html lang="en" data-color-scheme="light">',
		);
	});
});

describe("what an error page says", () => {
	/** A response a loader threw, as React Router hands it to an error page. */
	const thrown = (status: number, data: unknown) => ({
		status,
		statusText: "",
		internal: false,
		data,
	});

	it("by status, and never that the server failed for a request that was the asker's", () => {
		expect(errorWords(thrown(404, "Not Found"), "organisation").heading).toBe(
			"There's no page here",
		);
		expect(errorWords(thrown(404, "Not Found"), "outside").details).toBe(NOT_YOURS);
		expect(errorWords(thrown(400, "Bad Request"), "organisation").heading).toBe(
			"That address asks for something that isn't valid",
		);
		expect(errorWords(thrown(403, "Forbidden"), "organisation").heading).toBe(
			"This page isn't yours to open",
		);
		expect(errorWords(thrown(500, "Internal Server Error"), "organisation").heading).toBe(
			"Something went wrong on our side",
		);
		expect(errorWords(new Error("boom"), "outside").heading).toBe(
			"Something went wrong on our side",
		);
		for (const status of [400, 401, 403, 404, 405, 409, 422, 429]) {
			const { heading, details } = errorWords(thrown(status, "Internal Server Error"), "outside");
			expect(`${heading} ${details}`, String(status)).not.toMatch(
				/Internal Server Error|on our side/,
			);
		}
	});

	it("gives the sentence a loader threw with the response, and not a bare reason phrase", () => {
		expect(errorWords(thrown(400, "That date isn't valid."), "organisation").details).toBe(
			"That date isn't valid.",
		);
		expect(
			errorWords(thrown(400, { message: "The range ends before it starts." }), "organisation")
				.details,
		).toBe("The range ends before it starts.");
		expect(errorWords(thrown(400, "Bad Request"), "organisation").details).not.toBe("Bad Request");
	});
});
