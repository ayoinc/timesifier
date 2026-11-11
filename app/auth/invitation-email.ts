import type { Email } from "./email.server";

/** How long an invitation works: exactly seven days. */
export const INVITATION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

const HTML_ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Text chosen by a person, made safe to place in HTML. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

type Invitation = {
	/** The page that shows the invitation, on the host the invitation was made on. */
	link: string;
	organisationName: string;
	/** The verified address of the member who sent it. */
	inviterEmail: string;
	role: "admin" | "member";
};

/**
 * The message that carries an invitation: short and plain, with one link, to
 * our own host, and no image or other remote content. The link appears once in
 * the text and once in the HTML.
 *
 * The organisation's name is chosen by whoever created the organisation, so it
 * is quoted in the text and escaped in the HTML.
 */
export function invitationEmail({
	link,
	organisationName,
	inviterEmail,
	role,
}: Invitation): Omit<Email, "to"> {
	const as = role === "admin" ? "an admin" : "a member";
	const lead = (name: string, inviter: string) =>
		`${inviter} has invited you to join “${name}” on Timesifier as ${as}.`;
	const terms =
		"The invitation works once, for 7 days, and only when you sign in with the address this email was sent to.";
	const ignore = "If you were not expecting it, you can ignore this email.";

	return {
		subject: `You are invited to join ${organisationName} on Timesifier`,
		text: `${lead(organisationName, inviterEmail)}\n\nOpen the invitation:\n${link}\n\n${terms}\n\n${ignore}\n`,
		html: `<!doctype html><html lang="en"><body><p>${lead(escapeHtml(organisationName), escapeHtml(inviterEmail))}</p><p><a href="${escapeHtml(link)}">Open the invitation</a></p><p>${terms}</p><p>${ignore}</p></body></html>`,
	};
}
