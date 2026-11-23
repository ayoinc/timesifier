import { MADE_WITH } from "~/brand/made-with";
import type { PlatformBrand } from "~/brand/platform-brand.server";
import { EMAIL_COLOURS as COLOUR } from "~/styles/email-colours";

import type { Email } from "./email.server";

// The one look of every message the application sends (docs/design-direction.md,
// "Email"): a band in the brand's colour, the logo and the name, one column of
// paper no wider than 560px, a heading, what the message says, at most one
// figure and at most one action, and a footer that says why the person got it.
// A message gives its words to `compose` and gets both of its parts back, so the
// text part says what the HTML part says and a new message cannot look like
// another product's.
//
// Email is not a page. A mail program keeps the `style` attribute of an element
// and little else: it drops a style sheet or rewrites it, loads none of our
// fonts, and knows none of our custom properties. So every style here is inline
// and every colour a literal value, which `pnpm tokens` writes from the light
// scheme's roles. The site's Content Security Policy forbids inline styles on
// our pages and has no say here: a mail program applies its own rules to a
// message, not the headers of the site that sent it.
//
// Nothing in the frame is fetched: no font, no style sheet, no image from
// anywhere. The logo and the mark are attached to the message itself, inline,
// and the HTML names them by Content-ID (`cid:`), so a mail program shows them
// without asking any host, and nobody learns that the message was opened
// (docs/security.md, "Email"; TS-100). Each image has words beside it, the
// name in type, so a program that hides images loses nothing.

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
const REASON = type(PLAIN, 400, 14, 20, COLOUR.quiet);
/** An image in a message: no border, which some programs draw round a picture. */
const IMAGE =
	"display:inline-block;border:0;outline:none;text-decoration:none;vertical-align:middle;";

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

/** An image a message carries attached: a PNG or a JPEG and its size in pixels. */
export interface EmailImage {
	bytes: Uint8Array;
	type: "image/png" | "image/jpeg";
	width: number;
	height: number;
}

/** What a message takes from the platform's brand (`app/brand/platform-brand.server.ts`). */
export type PlatformLook = Pick<
	PlatformBrand,
	"colour" | "tagline" | "emailFooter" | "logo" | "markLight"
>;

/**
 * A message to a client in an organisation's name (TS-100): the organisation's
 * logo and name lead it, its colour is the band and the action, and the
 * platform keeps a small line at the foot.
 */
export interface OrganisationLook {
	name: string;
	/** `#rrggbb`, dark enough for white type; null for the platform's look. */
	colour: string | null;
	logo: EmailImage | null;
}

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
	/**
	 * The way to stop mail of this kind, under the reason: every mailing to
	 * account holders carries one (TS-099). Not an action: it is drawn as a plain link.
	 */
	unsubscribe?: Action;
};

/** The colours of the one action: the organisation's colour with white words, or the product's. */
type ActionColours = { ground: string; words: string };

function partAsHtml(part: string | Figure | Action, action: ActionColours): string {
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
		`<td bgcolor="${action.ground}" style="background-color:${action.ground};border-radius:4px;">` +
		`<a href="${escapeHtmlText(part.link)}" style="display:inline-block;padding:10px 22px;border:2px solid ${action.ground};${type(PLAIN, 600, 16, 24, action.words)}background-color:${action.ground};border-radius:4px;text-decoration:none;">${escapeHtmlText(part.action)}</a>` +
		"</td></tr></table>"
	);
}

function partAsText(part: string | Figure | Action): string {
	if (typeof part === "string") return part;
	if ("figure" in part) return `${part.label}:\n${part.figure}`;
	return `${part.action}:\n${part.link}`;
}

/** The name every message from the platform is headed with: the product's, as on every page. */
export const PRODUCT = "Timesifier";

/** The Content-IDs a message names its attached images by. */
export const CONTENT_IDS = {
	logo: "timesifier-logo",
	mark: "timesifier-mark",
	organisationLogo: "organisation-logo",
} as const;

const EXTENSION = { "image/png": "png", "image/jpeg": "jpg" } as const;

function attached(contentId: string, image: EmailImage, name: string): EmailAttachment {
	return {
		disposition: "inline",
		contentId,
		filename: `${name}.${EXTENSION[image.type]}`,
		type: image.type,
		content: image.bytes,
	};
}

/** An attached image as the HTML shows it, `height` px tall and no wider than `widest`. */
function imageHtml(
	contentId: string,
	image: EmailImage,
	alt: string,
	height: number,
	widest: number,
) {
	const scale = Math.min(height / image.height, widest / image.width);
	const width = Math.max(1, Math.round(image.width * scale));
	const tall = Math.max(1, Math.round(image.height * scale));
	return `<img src="cid:${contentId}" width="${width}" height="${tall}" alt="${escapeHtmlText(alt)}" style="${IMAGE}width:${width}px;height:${tall}px;">`;
}

/**
 * Both parts of a message, in the frame, with the images it shows attached.
 * The text part holds every word the HTML part shows, in the same order, and
 * each figure and link once, as the HTML does. Given an organisation, the
 * message is the organisation's: its logo, name and colour, and `MADE_WITH`
 * beside the mark at the foot. Without one, it is the platform's: its logo and
 * name, and its footer line.
 */
export function compose(
	{ subject, heading, parts, reason, unsubscribe }: Message,
	platform: PlatformLook,
	organisation?: OrganisationLook,
): Omit<Email, "to"> {
	const band = organisation?.colour ?? platform.colour;
	const action: ActionColours = organisation?.colour
		? { ground: organisation.colour, words: COLOUR.onBrand }
		: { ground: COLOUR.action, words: COLOUR.onAction };
	const name = organisation ? organisation.name : PRODUCT;
	const attachments: EmailAttachment[] = [];
	const stop = unsubscribe
		? ` <a href="${escapeHtmlText(unsubscribe.link)}" style="${REASON}text-decoration:underline;">${escapeHtmlText(unsubscribe.action)}</a>`
		: "";

	let logo = "";
	if (organisation?.logo) {
		attachments.push(attached(CONTENT_IDS.organisationLogo, organisation.logo, "logo"));
		logo = imageHtml(CONTENT_IDS.organisationLogo, organisation.logo, organisation.name, 40, 200);
	} else if (!organisation) {
		const image: EmailImage = { ...platform.logo, type: "image/png" };
		attachments.push(attached(CONTENT_IDS.logo, image, "timesifier"));
		logo = imageHtml(CONTENT_IDS.logo, image, PRODUCT, 28, 28);
	}

	let foot: string;
	let footText: string;
	if (organisation) {
		const mark: EmailImage = { ...platform.markLight, type: "image/png" };
		attachments.push(attached(CONTENT_IDS.mark, mark, "timesifier-mark"));
		foot = `${imageHtml(CONTENT_IDS.mark, mark, "", 14, 40)}&nbsp;${escapeHtmlText(MADE_WITH)}`;
		footText = MADE_WITH;
	} else {
		footText = `${platform.emailFooter} ${platform.tagline}`;
		foot = escapeHtmlText(footText);
	}

	const html =
		`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		// The message is drawn in the light scheme and says so, for the programs that ask.
		`<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
		`<title>${escapeHtmlText(subject)}</title></head>` +
		`<body style="margin:0;padding:0;background-color:${COLOUR.paper};">` +
		`<table ${TABLE} width="100%" bgcolor="${COLOUR.paper}" style="background-color:${COLOUR.paper};">` +
		// The band, with nothing on it; then the logo and the name on paper over the ink rule.
		`<tr><td bgcolor="${band}" style="height:8px;background-color:${band};font-size:0;line-height:0;">&nbsp;</td></tr>` +
		`<tr><td align="center" bgcolor="${COLOUR.paper}" style="padding:0 20px;background-color:${COLOUR.paper};border-bottom:2px solid ${COLOUR.ink};">` +
		`<table ${COLUMN_TABLE}><tr><td align="left" style="padding:16px 0;">` +
		`<table ${TABLE}><tr>` +
		(logo ? `<td style="padding:0 12px 0 0;font-size:0;line-height:0;">${logo}</td>` : "") +
		`<td align="left" style="${NAME}">${escapeHtmlText(name)}</td>` +
		"</tr></table>" +
		"</td></tr></table>" +
		"</td></tr>" +
		`<tr><td align="center" bgcolor="${COLOUR.paper}" style="padding:0 20px;background-color:${COLOUR.paper};">` +
		`<table ${COLUMN_TABLE}><tr><td align="left" style="padding:32px 0 48px;">` +
		`<h1 style="margin:0;${HEADING}">${escapeHtmlText(heading)}</h1>` +
		parts.map((part) => partAsHtml(part, action)).join("") +
		`<p style="margin:40px 0 0;padding:16px 0 0;border-top:1px solid ${COLOUR.rule};${REASON}">${escapeHtmlText(reason)}${stop}</p>` +
		`<p style="margin:12px 0 0;${REASON}">${foot}</p>` +
		"</td></tr></table>" +
		"</td></tr></table></body></html>";

	const footer = unsubscribe ? [reason, partAsText(unsubscribe)] : [reason];
	const text = `${[name, heading, ...parts.map(partAsText), ...footer, footText].join("\n\n")}\n`;

	return { subject, text, html, attachments };
}
