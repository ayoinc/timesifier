import type { Email } from "~/auth/email.server";
import { compose, type PlatformLook } from "~/auth/email-frame";
import type { platformData } from "~/db";

// The messages the platform console sends (TS-099), in the one frame every
// message of the product is drawn in (docs/design-direction.md, "Email").

/** How long a step-up code works, in seconds. */
export const STEP_UP_CODE_SECONDS = 300;

/** The code that opens the platform console for one session. */
export function stepUpCodeEmail(code: string, platform: PlatformLook): Omit<Email, "to"> {
	return compose(
		{
			subject: "Your Timesifier platform console code",
			heading: "Your platform console code",
			parts: [
				"Enter this code to open the platform console.",
				{ figure: code, label: "Console code" },
				`It works for ${STEP_UP_CODE_SECONDS / 60} minutes, once, and only in the session that asked for it.`,
			],
			reason:
				"You got this email because you are one of Timesifier's platform owners and somebody signed in as you asked to open the console. If it was not you, end every session on My account at once.",
		},
		platform,
	);
}

/** The two kinds of mail to account holders. */
export type MailKind = platformData.MailKind;

export const MAIL_KIND_LABELS: Record<MailKind, string> = {
	announcement: "Product announcement",
	newsletter: "Newsletter",
};

/** Why a person got a mailing of each kind, under it. */
const MAIL_REASONS: Record<MailKind, string> = {
	announcement:
		"You got this email because you have a Timesifier account and product announcements are on. You can turn them off on My account, or here:",
	newsletter:
		"You got this email because you asked for Timesifier's newsletter. You can stop it on My account, or here:",
};

/**
 * One mailing to one person: its paragraphs as the platform owner wrote them,
 * a blank line between each, and the link that stops this kind of mail. The
 * headers let a mail program offer the same in one press (RFC 8058).
 */
export function mailingEmail(
	{
		kind,
		subject,
		body,
		unsubscribe,
	}: {
		kind: MailKind;
		subject: string;
		body: string;
		unsubscribe: string;
	},
	platform: PlatformLook,
): Omit<Email, "to"> {
	const paragraphs = body
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	return {
		...compose(
			{
				subject,
				heading: subject,
				parts: paragraphs,
				reason: MAIL_REASONS[kind],
				unsubscribe: { action: "Unsubscribe", link: unsubscribe },
			},
			platform,
		),
		headers: {
			"List-Unsubscribe": `<${unsubscribe}>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
	};
}

/** Where a person downloads everything held about them, sent when they ask the platform for it. */
export function dataExportEmail(link: string, platform: PlatformLook): Omit<Email, "to"> {
	return compose(
		{
			subject: "Your Timesifier data",
			heading: "Your data is ready",
			parts: [
				"You asked for a copy of everything Timesifier holds about you. Sign in with this address and download it from My account.",
				{ action: "Download your data", link },
				"It is made fresh each time you download it, so it is always up to date.",
			],
			reason:
				"You got this email because you asked Timesifier for your data. If you did not, you can ignore it: the download needs you to sign in.",
		},
		platform,
	);
}

/**
 * The console's test of the platform's brand (TS-120): a message in the saved
 * brand, to the platform owner who asked for it and nobody else.
 */
export function brandTestEmail(platform: PlatformLook): Omit<Email, "to"> {
	return compose(
		{
			subject: "A test of Timesifier's brand",
			heading: "A test of the brand",
			parts: [
				"This is how every message Timesifier sends in its own name looks now: the band in the brand's colour, the logo and the name at the top, and the footer line and the tagline at the foot.",
				"The sender name and the reply-to address are the ones this message came with.",
			],
			reason:
				"You got this email because you asked the platform console for a test of the brand. It goes only to the platform owner who asks for it.",
		},
		platform,
	);
}
