import { describe, expect, it } from "vitest";
import { compose } from "~/auth/email-frame";
import { invitationEmail } from "~/auth/invitation-email";
import { signInCodeEmail } from "~/auth/sign-in-code-email";
import { EMAIL_COLOURS } from "~/styles/email-colours";

// The look of every message the application sends (docs/design-direction.md,
// "Email"): what the frame puts in each message, what it never puts there, and
// that the two parts of a message say the same thing.

const CODE = "40817263";
const LINK = "https://timesifier.example/invitations/9f2c61d0b7";

const MESSAGES = {
	"the sign-in code": signInCodeEmail(CODE),
	"the invitation": invitationEmail({
		link: LINK,
		organisationName: "Harbour & Sons",
		inviterEmail: "ada@example.com",
		role: "member",
	}),
};

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&nbsp;": " ",
};

/** The pieces of text a reader of the HTML part sees, in order. */
function shown(html: string): string[] {
	const body = html.slice(html.indexOf("<body"));
	return body
		.split(/<[^>]*>/)
		.map((piece) =>
			piece.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity),
		)
		.map((piece) => piece.trim())
		.filter((piece) => piece !== "");
}

describe.each(Object.entries(MESSAGES))("%s, in the frame", (_, message) => {
	it("is headed with the product's name on paper, under the amber band and over the ink rule", () => {
		const [name] = shown(message.html);
		expect(name).toBe("Timesifier");

		const band = `<td bgcolor="${EMAIL_COLOURS.band}"`;
		expect(message.html.split(band)).toHaveLength(2);
		// Nothing is written on the amber: a program that forces a dark scheme would lose it.
		expect(message.html).toMatch(new RegExp(`${band}[^>]*>&nbsp;</td>`));
		expect(message.html).toContain(`border-bottom:2px solid ${EMAIL_COLOURS.ink};`);
		expect(message.text.startsWith("Timesifier\n\n")).toBe(true);
	});

	it("is one column no wider than 560px, with one heading and a footer under a rule", () => {
		expect(message.html.match(/max-width:(\d+)px/g)).toEqual([
			"max-width:560px",
			"max-width:560px",
		]);
		expect(message.html.match(/<h1\b/g)).toHaveLength(1);
		expect(message.html).toContain(`border-top:1px solid ${EMAIL_COLOURS.rule};`);
		expect(shown(message.html).at(-1)).toMatch(/^You got this email because /);
	});

	it("says it is drawn in the light scheme, in English", () => {
		expect(message.html).toContain('<html lang="en">');
		expect(message.html).toContain('<meta name="color-scheme" content="light">');
	});

	it("takes every colour from the tokens", () => {
		const allowed = new Set<string>(Object.values(EMAIL_COLOURS));
		const used = message.html.match(/#[0-9a-f]{3,8}\b/gi) ?? [];

		expect(used.length).toBeGreaterThan(0);
		expect(used.filter((colour) => !allowed.has(colour))).toEqual([]);
		expect(message.html).not.toMatch(/\b(?:rgb|hsl|oklch|color-mix)a?\(/i);
	});

	it("sets every colour of type beside the ground it stands on, so forcing a dark scheme cannot lose it", () => {
		expect(message.html).toContain(
			`<body style="margin:0;padding:0;background-color:${EMAIL_COLOURS.paper};">`,
		);
		// A cell that holds type on a ground of its own names that ground.
		for (const cell of message.html.match(/<(?:td|a)\b[^>]*>/g) ?? []) {
			// The text colour, not the ground: `background-color` also ends in `color:`.
			if (new RegExp(`(?<!-)color:${EMAIL_COLOURS.onAction}`).test(cell)) {
				expect(cell).toContain(`background-color:${EMAIL_COLOURS.action}`);
			}
		}
	});

	it("carries its styles inline: no style sheet, no class, nothing a mail program fetches", () => {
		expect(message.html).not.toMatch(
			/<style|<link|<script|<img|<picture|<svg|<video|<audio|<iframe|<object|<embed|<form|<base/i,
		);
		expect(message.html).not.toMatch(
			/\bclass=|\bsrc=|\bsrcset=|\bbackground=|url\(|@import|@font-face/i,
		);
		expect(message.text).not.toMatch(/<[a-z!/]/i);
	});

	it("says in the text part everything the HTML part shows, in the same order", () => {
		let from = 0;
		for (const piece of shown(message.html)) {
			const at = message.text.indexOf(piece, from);
			expect(at, piece).toBeGreaterThanOrEqual(0);
			from = at + piece.length;
		}
	});
});

describe("the sign-in code, in the frame", () => {
	const message = MESSAGES["the sign-in code"];

	it("has the same subject for every code", () => {
		expect(message.subject).toBe("Your Timesifier sign-in code");
		expect(signInCodeEmail("00000001").subject).toBe(message.subject);
	});

	it("names no address anywhere: not a link, not a host, not a scheme", () => {
		for (const part of [message.html, message.text]) {
			expect(part).not.toMatch(/http|www\.|\/\/|<a\b|href=/i);
		}
	});

	it("sets the code once in each part, as one unbroken run that copies as it is typed", () => {
		expect(message.html.split(CODE)).toHaveLength(2);
		expect(message.text.split(CODE)).toHaveLength(2);
		expect(message.html).toContain(`>${CODE}</td>`);
		expect(message.text).toContain(`\n${CODE}\n`);
		// The first figure in the text is the code: a program that reads one out reads the code.
		expect(message.text.match(/\d+/)?.[0]).toBe(CODE);
	});

	it("sets the code large, in tabular figures with air between them", () => {
		const cell = message.html.match(new RegExp(`<td[^>]*>${CODE}</td>`))?.[0] ?? "";

		expect(cell).toContain("font-size:44px");
		expect(cell).toContain("font-variant-numeric:tabular-nums");
		expect(cell).toContain("letter-spacing:4px");
		expect(cell).toContain("white-space:nowrap");
	});
});

describe("the invitation, in the frame", () => {
	const message = MESSAGES["the invitation"];

	it("has the same subject and heading whoever invites and whatever the organisation is called", () => {
		const other = invitationEmail({
			link: LINK,
			organisationName: "Another",
			inviterEmail: "grace@example.com",
			role: "admin",
		});

		expect(message.subject).toBe("You are invited to join an organisation on Timesifier");
		expect(other.subject).toBe(message.subject);
		expect(shown(other.html)[1]).toBe(shown(message.html)[1]);
	});

	it("names one address, its one link, once in each part, and has one action", () => {
		expect(message.html.match(/http/gi)).toHaveLength(1);
		expect(message.text.match(/http/gi)).toHaveLength(1);
		expect(message.html.match(/<a\b/g)).toHaveLength(1);
		expect(message.html).toContain(`<a href="${LINK}"`);
		expect(message.text).toContain(`Open the invitation:\n${LINK}\n`);
	});

	it("escapes the organisation's name in the HTML and quotes it in the text", () => {
		expect(message.html).toContain("“Harbour &amp; Sons”");
		expect(message.text).toContain("“Harbour & Sons”");
	});
});

describe("the frame", () => {
	it("escapes every word a message gives it", () => {
		const markup = `<b title="x">Tom's & Co</b>`;
		const { html, text } = compose({
			subject: markup,
			heading: markup,
			parts: [markup, { figure: markup, label: markup }, { action: markup, link: `/a?b="c"&d` }],
			reason: markup,
		});

		expect(html).not.toContain("<b title");
		expect(html.split("&lt;b title=&quot;x&quot;&gt;Tom&#39;s &amp; Co&lt;/b&gt;")).toHaveLength(8);
		expect(html).toContain(`href="/a?b=&quot;c&quot;&amp;d"`);
		expect(text.split(markup)).toHaveLength(7);
	});
});
