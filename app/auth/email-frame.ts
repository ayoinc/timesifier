import { EMAIL_COLOURS as COLOUR } from "~/styles/email-colours";

import type { Email } from "./email.server";

// The one look of every message the application sends (docs/design-direction.md,
// "Email"): the amber band with the product's name, one column of paper no wider
// than 560px, a heading, what the message says, at most one figure and at most
// one action, and a footer that says why the person got it. A message gives its
// words to `compose` and gets both of its parts back, so the text part says what
// the HTML part says and a new message cannot look like another product's.
//
// Email is not a page. A mail program keeps the `style` attribute of an element
// and little else: it drops a style sheet or rewrites it, loads none of our
// fonts, and knows none of our custom properties. So every style here is inline
// and every colour a literal value, which `pnpm tokens` writes from the light
// scheme's roles. The site's Content Security Policy forbids inline styles on
// our pages and has no say here: a mail program applies its own rules to a
// message, not the headers of the site that sent it.
//
// Nothing in the frame is fetched: no image, no font, no style sheet. The band
// carries the name in type, not the mark, because a mark would have to be an
// image, and a mail program either blocks it or tells its host that the message
// was opened (docs/security.md, "Email").

/** The widest a message's column is, in px. */
const COLUMN = 560;

// A mail program has none of the site's fonts, so each stack names the site's own
// family first, for a reader who has it, and then the faces that devices carry
// which stand nearest to it: a condensed grotesque for the name, the heading and a
// figure, and the device's own interface face for what is read.
const BRAND =
	"'Sofia Sans Condensed','Avenir Next Condensed','Roboto Condensed','Arial Narrow',sans-serif-condensed,'Helvetica Neue',Helvetica,Arial,sans-serif";
const PLAIN =
	"'Sofia Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";

/** One role of the type scale as inline declarations: its family, weight, size and line height in px. */
function type(family: string, weight: number, size: number, line: number, colour: string) {
	return `font-family:${family};font-weight:${weight};font-size:${size}px;line-height:${line}px;color:${colour};`;
}

// A mail program that forces a dark scheme recolours what it finds, and each does
// it its own way: most turn dark type pale and a pale ground dark, and leave a
// strong colour such as the amber as it is. So no type stands on the amber, where
// it would be turned pale and lost; every colour of type is set beside the ground
// it stands on; and the action has a frame in its own ground's colour, which
// cannot be seen until a program turns the page under it dark.
const NAME = type(BRAND, 700, 24, 30, COLOUR.ink);
const HEADING = type(BRAND, 700, 36, 40, COLOUR.ink);
const BODY = type(PLAIN, 400, 16, 24, COLOUR.ink);
const LABEL = type(PLAIN, 600, 14, 20, COLOUR.quiet);
const FIGURE = type(BRAND, 800, 44, 46, COLOUR.ink);
const ACTION = type(PLAIN, 600, 16, 24, COLOUR.onAction);
const REASON = type(PLAIN, 400, 14, 20, COLOUR.quiet);

/** A table that lays out and means nothing: what a mail program lays out most reliably. */
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
/** The column: as wide as the window lets it be, and no wider than `COLUMN`. */
const COLUMN_TABLE = `${TABLE} width="${COLUMN}" style="width:100%;max-width:${COLUMN}px;"`;

const HTML_ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Text made safe to place in HTML. Every word of a message passes through it. */
function escapeHtmlText(text: string): string {
	return text.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

/**
 * A number the person reads, types or says aloud, such as a sign-in code. It is
 * set large in tabular figures with air between them, as one unbroken run of
 * characters, so that selecting it copies exactly what is typed.
 */
export type Figure = { figure: string; label: string };

/** The one thing a message asks the person to do: a link, drawn as the filled button. */
export type Action = { action: string; link: string };

export type Message = {
	/** The same for every message of its kind. It holds nothing a person typed. */
	subject: string;
	/** What the message is, in a few words. It holds nothing a person typed either. */
	heading: string;
	/**
	 * What the message says, in order: paragraphs, and at most one figure and one
	 * action. A paragraph may quote a person's words; the frame escapes them.
	 */
	parts: readonly (string | Figure | Action)[];
	/** Why the person got the message and what to do if they did not expect it. */
	reason: string;
};

function partAsHtml(part: string | Figure | Action): string {
	if (typeof part === "string") {
		return `<p style="margin:16px 0 0;${BODY}">${escapeHtmlText(part)}</p>`;
	}
	if ("figure" in part) {
		return (
			`<table ${TABLE} width="100%" style="margin:24px 0 0;border:2px solid ${COLOUR.ink};border-radius:8px;background-color:${COLOUR.paper};">` +
			`<tr><td align="left" style="padding:12px 20px 0;${LABEL}">${escapeHtmlText(part.label)}</td></tr>` +
			`<tr><td align="left" style="padding:4px 20px 12px;${FIGURE}letter-spacing:4px;font-variant-numeric:tabular-nums;white-space:nowrap;-webkit-user-select:all;user-select:all;">${escapeHtmlText(part.figure)}</td></tr>` +
			"</table>"
		);
	}
	return (
		`<table ${TABLE} style="margin:24px 0 0;"><tr>` +
		`<td bgcolor="${COLOUR.action}" style="background-color:${COLOUR.action};border-radius:4px;">` +
		`<a href="${escapeHtmlText(part.link)}" style="display:inline-block;padding:10px 22px;border:2px solid ${COLOUR.action};${ACTION}background-color:${COLOUR.action};border-radius:4px;text-decoration:none;">${escapeHtmlText(part.action)}</a>` +
		"</td></tr></table>"
	);
}

function partAsText(part: string | Figure | Action): string {
	if (typeof part === "string") return part;
	if ("figure" in part) return `${part.label}:\n${part.figure}`;
	return `${part.action}:\n${part.link}`;
}

/** The name every message is headed with: the product's, as on every page. */
const PRODUCT = "Timesifier";

/**
 * Both parts of a message, in the frame. The text part holds every word the HTML
 * part shows, in the same order, and each figure and link once, as the HTML does.
 */
export function compose({ subject, heading, parts, reason }: Message): Omit<Email, "to"> {
	const html =
		`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		// The message is drawn in the light scheme and says so, for the programs that ask.
		`<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
		`<title>${escapeHtmlText(subject)}</title></head>` +
		`<body style="margin:0;padding:0;background-color:${COLOUR.paper};">` +
		`<table ${TABLE} width="100%" bgcolor="${COLOUR.paper}" style="background-color:${COLOUR.paper};">` +
		// The amber band, with nothing on it; then the name on paper over the ink rule.
		`<tr><td bgcolor="${COLOUR.band}" style="height:8px;background-color:${COLOUR.band};font-size:0;line-height:0;">&nbsp;</td></tr>` +
		`<tr><td align="center" bgcolor="${COLOUR.paper}" style="padding:0 20px;background-color:${COLOUR.paper};border-bottom:2px solid ${COLOUR.ink};">` +
		`<table ${COLUMN_TABLE}><tr><td align="left" style="padding:16px 0;${NAME}">${PRODUCT}</td></tr></table>` +
		"</td></tr>" +
		`<tr><td align="center" bgcolor="${COLOUR.paper}" style="padding:0 20px;background-color:${COLOUR.paper};">` +
		`<table ${COLUMN_TABLE}><tr><td align="left" style="padding:32px 0 48px;">` +
		`<h1 style="margin:0;${HEADING}">${escapeHtmlText(heading)}</h1>` +
		parts.map(partAsHtml).join("") +
		`<p style="margin:40px 0 0;padding:16px 0 0;border-top:1px solid ${COLOUR.rule};${REASON}">${escapeHtmlText(reason)}</p>` +
		"</td></tr></table>" +
		"</td></tr></table></body></html>";

	const text = `${[PRODUCT, heading, ...parts.map(partAsText), reason].join("\n\n")}\n`;

	return { subject, text, html };
}
