import { AS_ROLE } from "~/organisations/people";
import type { Email } from "./email.server";

import { compose } from "./email-frame";

/** How long an invitation works: exactly seven days. */
export const INVITATION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

type Invitation = {
	/** The page that shows the invitation, on the host the invitation was made on. */
	link: string;
	organisationName: string;
	/** The verified address of the member who sent it. */
	inviterEmail: string;
	role: "admin" | "finance" | "member";
};

/**
 * The message that carries an invitation, in the frame every message has
 * (email-frame.ts): one link, to our own host, and no image or other remote
 * content. The link appears once in the text and once in the HTML.
 *
 * The organisation's name is chosen by whoever created the organisation, and
 * the message goes to somebody who never asked for it. So the subject and the
 * heading are the same for every invitation and hold nothing anybody chose;
 * the name appears in the body alone, in quotation marks, and the frame
 * escapes it in the HTML.
 */
export function invitationEmail({
	link,
	organisationName,
	inviterEmail,
	role,
}: Invitation): Omit<Email, "to"> {
	const as = AS_ROLE[role];

	return compose({
		subject: "You are invited to join an organisation on Timesifier",
		heading: "You are invited",
		parts: [
			`${inviterEmail} has invited you to join “${organisationName}” on Timesifier as ${as}.`,
			{ action: "Open the invitation", link },
			"The invitation works once, for 7 days, and only when you sign in with the address this email was sent to.",
		],
		reason:
			"You got this email because that person entered this address. If you were not expecting it, you can ignore it.",
	});
}
