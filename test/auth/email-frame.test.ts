import { describe, expect, it } from "vitest";
import type { Email } from "~/auth/email.server";
import { CONTENT_IDS, compose, type OrganisationLook } from "~/auth/email-frame";
import { invitationEmail } from "~/auth/invitation-email";
import { signInCodeEmail } from "~/auth/sign-in-code-email";
import { MADE_WITH } from "~/brand/made-with";
import { builtInPlatformBrand } from "~/brand/platform-brand.server";
import { budgetAlertEmail } from "~/budgets/budget.server";
import { documentMessage } from "~/invoices/mail.server";
import { EMAIL_COLOURS } from "~/styles/email-colours";

// The look of every message the application sends (docs/design-direction.md,
// "Email"): what the frame puts in each message, what it never puts there, and
// that the two parts of a message say the same thing. Every message the
// application composes is here: the platform's own, in its name, and the ones an
// organisation sends its clients, in the organisation's (TS-100).

const CODE = "40817263";
const LINK = "https://timesifier.example/invitations/9f2c61d0b7";
const ESTIMATE_LINK = "https://timesifier.example/estimate/0192/abc";
const PLATFORM = builtInPlatformBrand();
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** An organisation with a logo and a colour of its own. */
const HARBOUR: OrganisationLook = {
	name: "Harbour & Sons",
	colour: "#1d4ed8",
	logo: { ...PLATFORM.markLight, type: "image/png" },
};
const DOCUMENT = {
	organisationName: "Harbour & Sons",
	clientName: "Globex",
	number: "42",
	amount: "£1,200.00",
	dueOn: "2026-12-01",
};

type Message = Omit<Email, "to">;
type Case = { message: Message; organisation: OrganisationLook | null };

const PLATFORM_MESSAGES: Record<string, Case> = {
	"the sign-in code": { message: signInCodeEmail(CODE, PLATFORM), organisation: null },
	"the invitation": {
		message: invitationEmail(
			{
				link: LINK,
				organisationName: "Harbour & Sons",
				inviterEmail: "ada@example.com",
				role: "member",
			},
			PLATFORM,
		),
		organisation: null,
	},
	"a budget alert": {
		message: budgetAlertEmail(
			{
				projectName: "Rebrand",
				organisationName: "Harbour & Sons",
				percent: 80,
				threshold: 75,
				link: "https://timesifier.example/app/harbour/projects/1",
			},
			PLATFORM,
		),
		organisation: null,
	},
};
const CLIENT_MESSAGES: Record<string, Case> = {
	"an invoice": {
		message: documentMessage({ ...DOCUMENT, kind: "invoice" }, PLATFORM, HARBOUR),
		organisation: HARBOUR,
	},
	"a reminder": {
		message: documentMessage({ ...DOCUMENT, kind: "reminder" }, PLATFORM, HARBOUR),
		organisation: HARBOUR,
	},
	"an estimate": {
		message: documentMessage(
			{ ...DOCUMENT, kind: "estimate", link: ESTIMATE_LINK },
			PLATFORM,
			HARBOUR,
		),
		organisation: HARBOUR,
	},
	"an estimate from an organisation with no logo or colour": {
		message: documentMessage(
			{ ...DOCUMENT, kind: "estimate", link: ESTIMATE_LINK },
			PLATFORM,
			null,
		),
		organisation: { name: "Harbour & Sons", colour: null, logo: null },
	},
};
const MESSAGES = { ...PLATFORM_MESSAGES, ...CLIENT_MESSAGES };

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

/** Each image the HTML shows: its source and its words. */
function images(html: string) {
	return [...html.matchAll(/<img\b[^>]*>/g)].map(([tag]) => ({
		src: tag.match(/\ssrc="([^"]*)"/)?.[1] ?? "",
		alt: tag.match(/\salt="([^"]*)"/)?.[1],
	}));
}

const inline = (message: Message) =>
	(message.attachments ?? []).filter((file) => file.disposition === "inline");

describe.each(Object.entries(MESSAGES))("%s, in the frame", (_, { message, organisation }) => {
	const name = organisation?.name ?? "Timesifier";
	const band = organisation?.colour ?? PLATFORM.colour;

	it("is headed with its sender's name on paper, under the band and over the ink rule", () => {
		expect(shown(message.html)[0]).toBe(name);
		const cell = `<td bgcolor="${band}"`;
		// One band, and nothing is written on it: a program that forces a dark scheme would lose it.
		expect(message.html.match(new RegExp(`${cell}[^>]*>&nbsp;</td>`, "g"))).toHaveLength(1);
		expect(message.html).toContain(`border-bottom:2px solid ${EMAIL_COLOURS.ink};`);
		expect(message.text.startsWith(`${name}\n\n`)).toBe(true);
	});

	it("is one column no wider than 560px, with one heading and a footer under a rule", () => {
		expect(message.html.match(/max-width:(\d+)px/g)).toEqual([
			"max-width:560px",
			"max-width:560px",
		]);
		expect(message.html.match(/<h1\b/g)).toHaveLength(1);
		expect(message.html).toContain(`border-top:1px solid ${EMAIL_COLOURS.rule};`);
		const words = shown(message.html);
		expect(words.at(-2)).toMatch(/^You (?:got this email|are getting this|are a billing contact) /);
		expect(words.at(-1)).toBe(
			organisation ? MADE_WITH : `${PLATFORM.emailFooter} ${PLATFORM.tagline}`,
		);
	});

	it("says it is drawn in the light scheme, in English", () => {
		expect(message.html).toContain('<html lang="en">');
		expect(message.html).toContain('<meta name="color-scheme" content="light">');
	});

	it("takes every colour from the tokens, and the organisation's own", () => {
		const allowed = new Set<string>([...Object.values(EMAIL_COLOURS), band]);
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
			if (new RegExp(`(?<!-)color:${EMAIL_COLOURS.onBrand}`).test(cell)) {
				expect(cell).toContain(`background-color:${organisation?.colour}`);
			}
		}
	});

	it("carries its styles inline, and fetches nothing: every image is attached to the message", () => {
		expect(message.html).not.toMatch(
			/<style|<link|<script|<picture|<svg|<video|<audio|<iframe|<object|<embed|<form|<base/i,
		);
		expect(message.html).not.toMatch(/\bclass=|\bsrcset=|\bbackground=|url\(|@import|@font-face/i);
		// The only sources are the message's own parts, by Content-ID: no http(s), no data.
		const sources = [...message.html.matchAll(/\ssrc="([^"]*)"/g)].map(([, src]) => src);
		expect(sources.length).toBeGreaterThan(0);
		for (const src of sources) expect(src).toMatch(/^cid:[a-z-]+$/);
		expect(message.text).not.toMatch(/<[a-z!/]/i);
	});

	it("attaches, inline, exactly the images its HTML shows, each a PNG or a JPEG with its Content-ID", () => {
		const shownIds = images(message.html).map(({ src }) => src.slice("cid:".length));
		const attached = inline(message);
		expect(attached.map((file) => file.contentId).sort()).toEqual([...shownIds].sort());
		for (const file of attached) {
			expect(["image/png", "image/jpeg"]).toContain(file.type);
			expect(file.content).toBeInstanceOf(Uint8Array);
			const bytes = file.content as Uint8Array;
			if (file.type === "image/png") expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
			expect(file.filename).toMatch(/^[a-z-]+\.(?:png|jpg)$/);
		}
	});

	it("carries the product's mark: its logo at the top, or beside the line at the foot", () => {
		const shownImages = images(message.html);
		if (!organisation) {
			// The logo, named "Timesifier", with the name in type beside it.
			expect(shownImages).toEqual([{ src: `cid:${CONTENT_IDS.logo}`, alt: "Timesifier" }]);
			expect(message.html).toMatch(
				/<img [^>]*alt="Timesifier"[^>]*><\/td><td[^>]*>Timesifier<\/td>/,
			);
			expect(inline(message)[0]?.content).toEqual(PLATFORM.logo.bytes);
			return;
		}
		// The organisation's logo leads, named for it; the mark is beside "Made with Timesifier".
		const expected = [
			...(organisation.logo
				? [{ src: `cid:${CONTENT_IDS.organisationLogo}`, alt: "Harbour &amp; Sons" }]
				: []),
			{ src: `cid:${CONTENT_IDS.mark}`, alt: "" },
		];
		expect(shownImages).toEqual(expected);
		expect(message.html).toMatch(new RegExp(`cid:${CONTENT_IDS.mark}[^>]*>&nbsp;${MADE_WITH}</p>`));
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
	const { message } = PLATFORM_MESSAGES["the sign-in code"] as Case;

	it("has the same subject for every code", () => {
		expect(message.subject).toBe("Your Timesifier sign-in code");
		expect(signInCodeEmail("00000001", PLATFORM).subject).toBe(message.subject);
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
	const { message } = PLATFORM_MESSAGES["the invitation"] as Case;

	it("has the same subject and heading whoever invites and whatever the organisation is called", () => {
		const other = invitationEmail(
			{
				link: LINK,
				organisationName: "Another",
				inviterEmail: "grace@example.com",
				role: "admin",
			},
			PLATFORM,
		);

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

describe("a message to a client, in the organisation's look", () => {
	const { message } = CLIENT_MESSAGES["an estimate"] as Case;

	it("draws its one action in the organisation's colour, with white words", () => {
		const action = message.html.match(/<a\b[^>]*>/)?.[0] ?? "";
		expect(action).toContain(`background-color:${HARBOUR.colour}`);
		expect(action).toContain(`color:${EMAIL_COLOURS.onBrand}`);
	});

	it("draws the action in the product's colours where the organisation has none", () => {
		const plain = (
			CLIENT_MESSAGES["an estimate from an organisation with no logo or colour"] as Case
		).message;
		const action = plain.html.match(/<a\b[^>]*>/)?.[0] ?? "";
		expect(action).toContain(`background-color:${EMAIL_COLOURS.action}`);
	});
});

describe("the frame", () => {
	it("escapes every word a message gives it", () => {
		const markup = `<b title="x">Tom's & Co</b>`;
		const { html, text } = compose(
			{
				subject: markup,
				heading: markup,
				parts: [markup, { figure: markup, label: markup }, { action: markup, link: `/a?b="c"&d` }],
				reason: markup,
			},
			PLATFORM,
			{ name: markup, colour: null, logo: { ...PLATFORM.logo, type: "image/png" } },
		);

		expect(html).not.toContain("<b title");
		// The title, the name, the heading, the paragraph, the figure's label and figure,
		// the action, the reason, and the logo's words.
		expect(html.split("&lt;b title=&quot;x&quot;&gt;Tom&#39;s &amp; Co&lt;/b&gt;")).toHaveLength(
			10,
		);
		expect(html).toContain(`href="/a?b=&quot;c&quot;&amp;d"`);
		expect(text.split(markup)).toHaveLength(8);
	});
});
