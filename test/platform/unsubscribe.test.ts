import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformData } from "~/db";
import { unsubscribePath } from "~/platform/mail.server";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { row } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "../pages/harness";

// A mailing's unsubscribe link (TS-099), /unsubscribe/<kind>/<person>/<signature>.
// The signature says whose mail it stops and which kind; no session is
// needed. Opening the link changes nothing; posting stops that kind alone,
// from the page's button or from a mail client's one-click (RFC 8058), which
// posts with no session and no Origin. Any link this deployment did not make
// is a 404.

let mailbox: Mailbox;
let ada: Person;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	await platformData.setMailChoice(env.DB, ada.user.id, "newsletter", true);
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

function choicesOf(userId: string) {
	return row<{ newsletter: number; announcements: number }>(
		"select newsletter, announcements from users where id = ?",
		userId,
	);
}

/** A mail client's one-click unsubscribe: a form POST from its own server, with no session and no Origin. */
function oneClick(path: string): Promise<Response> {
	return exports.default.fetch(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
			redirect: "manual",
		}),
	);
}

describe("an unsubscribe link", () => {
	it("opens without a session, asks before it stops anything, and changes nothing", async () => {
		const path = await unsubscribePath("newsletter", ada.user.id);
		const response = await open(path);
		expect(response.status).toBe(200);
		const html = await pageBody(response);
		expect(textOf(html)).toContain("Stop the newsletter?");
		expect(html.match(/<button[^>]*type="submit"/g)).toHaveLength(1);
		expect(await choicesOf(ada.user.id)).toEqual({ newsletter: 1, announcements: 1 });
	});

	it("stops that kind alone when the page's button is pressed", async () => {
		const path = await unsubscribePath("newsletter", ada.user.id);
		const response = await submit(path, {});
		expect(response.status).toBe(200);
		expect(textOf(await pageBody(response))).toContain("Done.");
		expect(await choicesOf(ada.user.id)).toEqual({ newsletter: 0, announcements: 1 });

		// Opened again, it says the newsletter is off already, with nothing to press.
		const again = await pageBody(await open(path));
		expect(textOf(again)).toContain("It is already off");
		expect(again).not.toMatch(/<button[^>]*type="submit"/);
	});

	it("stops that kind alone on a mail client's one-click, with no session and no Origin", async () => {
		const path = await unsubscribePath("announcement", ada.user.id);
		const response = await oneClick(path);
		expect(response.status).toBe(200);
		expect(await choicesOf(ada.user.id)).toEqual({ newsletter: 1, announcements: 0 });
	});

	it("is 404 with a signature this deployment did not make", async () => {
		const path = await unsubscribePath("newsletter", ada.user.id);
		const last = path.at(-1) === "a" ? "b" : "a";
		const forged = `${path.slice(0, -1)}${last}`;
		expect((await open(forged)).status).toBe(404);
		expect((await oneClick(forged)).status).toBe(404);
		expect(await choicesOf(ada.user.id)).toEqual({ newsletter: 1, announcements: 1 });
	});

	it("is 404 for a kind it does not know, or another kind's signature", async () => {
		const path = await unsubscribePath("newsletter", ada.user.id);
		const unknown = path.replace("/unsubscribe/newsletter/", "/unsubscribe/news/");
		const otherKind = path.replace("/unsubscribe/newsletter/", "/unsubscribe/announcements/");
		for (const each of [unknown, otherKind]) {
			expect((await open(each)).status, each).toBe(404);
			expect((await oneClick(each)).status, each).toBe(404);
		}
		expect(await choicesOf(ada.user.id)).toEqual({ newsletter: 1, announcements: 1 });
	});

	it("is 404 for another person with this person's signature", async () => {
		const bola = await person(mailbox, "bola@example.com");
		await platformData.setMailChoice(env.DB, bola.user.id, "newsletter", true);
		const adas = await unsubscribePath("newsletter", ada.user.id);
		const signature = adas.split("/").at(-1) ?? "";
		const forBola = `/unsubscribe/newsletter/${encodeURIComponent(bola.user.id)}/${signature}`;
		expect((await open(forBola)).status).toBe(404);
		expect((await oneClick(forBola)).status).toBe(404);
		expect(await choicesOf(bola.user.id)).toEqual({ newsletter: 1, announcements: 1 });
	});

	it("is 404 for a person who is not there", async () => {
		const path = await unsubscribePath("newsletter", "no-such-person");
		expect((await open(path)).status).toBe(404);
	});
});
