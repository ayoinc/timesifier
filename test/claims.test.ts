import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { PHOTOS } from "~/landing/photos";
import { PRIMARY_ACTION, PRIVACY_PATH } from "~/landing/Site";
import { SIGN_IN_PATH } from "~/routes/auth/paths";
import { COLOR_SCHEME_COOKIE } from "~/shell/color-scheme.server";
import { GETTING_STARTED_COOKIE } from "~/timesheet/getting-started.server";

import { CODE_COOKIE, KNOWN_COOKIE, ORIGIN, SESSION_COOKIE, setBinding } from "./auth/harness";

// The public pages state facts. Each test here ties one of those sentences to
// the thing it is about, so that the code and the page cannot part company
// without a test failing. The claims were audited on 11 November 2026; what
// became of each is in docs/design-direction.md, "Nothing on the page is untrue".

async function page(path: string): Promise<string> {
	const response = await exports.default.fetch(`${ORIGIN}${path}`);
	expect(response.status).toBe(200);
	// As a person reads it: tags gone, entities and comments resolved, spaces single.
	return (await response.text())
		.replace(/<!--.*?-->/gs, "")
		.replace(/&#x27;|&#39;|’/g, "'")
		.replace(/&amp;/g, "&");
}

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// Only the words are read: nothing is run.
const readme = import.meta.glob<string>("../README.md", {
	eager: true,
	query: "?raw",
	import: "default",
})["../README.md"];
const wrangler = import.meta.glob<string>("../wrangler.jsonc", {
	eager: true,
	query: "?raw",
	import: "default",
})["../wrangler.jsonc"];

/** Every cookie the application sets, by the name a browser shows for it. */
const COOKIES = [
	SESSION_COOKIE,
	CODE_COOKIE,
	KNOWN_COOKIE,
	COLOR_SCHEME_COOKIE,
	GETTING_STARTED_COOKIE,
];
const COUNT = ["no", "one", "two", "three", "four", "five", "six"];

it("the privacy notice lists every cookie the application sets, and counts them", async () => {
	const html = await page(PRIVACY_PATH);

	for (const cookie of COOKIES) expect(html, cookie).toContain(`>${cookie}<`);
	// It names no cookie the application does not set.
	const named = new Set(html.match(/__Host-[\w.-]+/g));
	expect([...named].sort()).toEqual([...COOKIES].sort());
	expect(words(html)).toContain(`sets ${COUNT[COOKIES.length]} cookies and no others`);
});

it("the pages say the database is in the EU because that is how the databases are created", async () => {
	// A D1 database's jurisdiction is fixed when it is created and is in no
	// configuration file: the README's commands are where the repository keeps it.
	expect(readme).toBeDefined();
	const created = (readme ?? "").split("\n").filter((line) => line.includes("wrangler d1 create"));
	expect(created.length).toBeGreaterThan(0);
	for (const command of created) expect(command).toContain("--jurisdiction eu");

	for (const path of ["/", PRIVACY_PATH]) {
		expect(words(await page(path)), path).toContain("runs and stores its data only inside the EU");
	}
});

it("wherever a page says the database is in the EU, it says what is not", async () => {
	for (const path of ["/", PRIVACY_PATH]) {
		const text = words(await page(path));
		expect(text, path).toContain("data centre nearest to you");
		expect(text, path).toContain("not restricted to the EU");
	}
});

it("the pages say requests are handled in Frankfurt because the Worker is placed there", async () => {
	// A Placement Hint runs the Worker in the data centre with the lowest latency
	// to the cloud region it names; aws:eu-central-1 is Frankfurt
	// (docs/decisions.md 34). A commented-out line does not count.
	expect(wrangler).toMatch(/^\t"placement": \{ "region": "aws:eu-central-1" \},$/m);
	for (const path of ["/", PRIVACY_PATH]) {
		expect(words(await page(path)), path).toContain("is passed to Frankfurt");
	}
});

it("each photographer is named once, in the credits at the foot of the page, not under the photograph", async () => {
	const pages = { "/": Object.values(PHOTOS), [SIGN_IN_PATH]: [PHOTOS.platform] };
	for (const [path, photos] of Object.entries(pages)) {
		const html = await page(path);
		const footer = html.slice(html.lastIndexOf("<footer"));
		expect(words(footer), path).toContain("Credits");
		for (const photo of photos) {
			expect(html.split(photo.author).length - 1, `${path}: ${photo.author}`).toBe(1);
			expect(footer).toContain(photo.author);
		}
		expect(words(html.slice(0, html.lastIndexOf("<footer"))), path).not.toMatch(/Photograph/);
	}
});

it("the home page has one primary action, said the same at the top and at the end, and one way in", async () => {
	const html = await page("/");
	const actions = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].filter(
		([, , label]) => label === PRIMARY_ACTION,
	);

	expect(actions.map(([, href]) => href)).toEqual([SIGN_IN_PATH, SIGN_IN_PATH]);
	// And one quiet "Sign in", in the band at the top, to the same page.
	const quiet = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>Sign in<\/a>/g)];
	expect(quiet.map(([, href]) => href)).toEqual([SIGN_IN_PATH]);
});

it("the privacy notice names this deployment's host and sender, from its settings and the request", async () => {
	setBinding("EMAIL_FROM", "no-reply@mail.timesifier.example");
	const text = words(await page(PRIVACY_PATH));

	const { host } = new URL(ORIGIN);
	expect(text).toContain(`Each is sent only to ${host}`);
	expect(text).toContain(`cannot reach ${host}.`);
	expect(text).toContain("email service, from no-reply@mail.timesifier.example. The email");

	// A deployment that sends no mail names no address.
	setBinding("EMAIL_FROM", undefined);
	expect(words(await page(PRIVACY_PATH))).toContain("Cloudflare's email service. The email");
});
