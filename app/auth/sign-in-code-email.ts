import type { Email } from "./email.server";
import { compose } from "./email-frame";

/** How long an emailed code works. Better Auth's default, stated here because the message quotes it. */
export const CODE_LIFETIME_SECONDS = 300;

/**
 * The message that carries a sign-in code, in the frame every message has
 * (email-frame.ts): no images and no links, so nothing in it can track the
 * reader or be swapped for a phishing address. The code appears once in the
 * text and once in the HTML, each time as one unbroken run of figures, and no
 * figure stands before it in the text.
 */
export function signInCodeEmail(code: string): Omit<Email, "to"> {
	const minutes = CODE_LIFETIME_SECONDS / 60;

	return compose({
		subject: "Your Timesifier sign-in code",
		heading: "Your sign-in code",
		parts: [
			"Enter this code to sign in to Timesifier.",
			{ figure: code, label: "Sign-in code" },
			`It works for ${minutes} minutes, once, and only in the browser that asked for it.`,
		],
		reason:
			"You got this email because somebody asked to sign in to Timesifier with this address. If it was not you, you can ignore it: nobody can sign in without the code.",
	});
}
