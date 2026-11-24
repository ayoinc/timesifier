import { compose, type PlatformLook } from "~/auth/email-frame";
import { accountPath, organisationPath } from "~/shell/destinations";

import { KIND_WORDS, type NotificationKind } from "./kinds";

/** Where My account › Notifications is, below the account page. */
export const NOTIFICATIONS_ANCHOR = "notifications";

/** What a notification's email is made from: the notification as its person sees it in the bell. */
export interface NotificationMail {
	kind: NotificationKind;
	title: string;
	body: string | null;
	/** Below the organisation's address. */
	path: string;
	organisationName: string;
	slug: string;
	/** The origin links point to: production's host. */
	origin: string;
}

/**
 * A notification's email (TS-049): its kind's subject and heading, which
 * hold nothing anybody typed; the organisation, and the notification's words
 * as the bell shows them, and nothing more; a link to where it leads in the
 * application; and a link to My account › Notifications, where its kind's
 * email is turned off.
 */
export function notificationEmail(mail: NotificationMail, platform: PlatformLook) {
	const words = KIND_WORDS[mail.kind];
	const base = `${mail.origin}${organisationPath(mail.slug)}`;
	return compose(
		{
			subject: words.subject,
			heading: words.heading,
			parts: [
				`In “${mail.organisationName}”: ${mail.title}`,
				...(mail.body ? [mail.body] : []),
				{ action: "Open Timesifier", link: `${base}${mail.path}` },
			],
			reason: words.reason,
			unsubscribe: {
				action: "Turn these emails off",
				link: `${mail.origin}${accountPath(mail.slug)}#${NOTIFICATIONS_ANCHOR}`,
			},
		},
		platform,
	);
}
