import type { Email } from "./email.server";

/** How long an emailed code works. Better Auth's default, stated here because the message quotes it. */
export const CODE_LIFETIME_SECONDS = 300;

/**
 * The message that carries a sign-in code: short, plain, no images and no
 * links, so nothing in it can track the reader or be swapped for a phishing
 * address. The code appears once in the text and once in the HTML.
 */
export function signInCodeEmail(code: string): Omit<Email, "to"> {
	const minutes = CODE_LIFETIME_SECONDS / 60;
	const lead = "Enter this code to sign in to Timesifier:";
	const expiry = `It works for ${minutes} minutes, once, and only in the browser that asked for it.`;
	const ignore =
		"If you did not ask for it, you can ignore this email: nobody can sign in without the code.";

	return {
		subject: "Your Timesifier sign-in code",
		text: `${lead}\n\n${code}\n\n${expiry}\n\n${ignore}\n`,
		html: `<!doctype html><html lang="en"><body><p>${lead}</p><p><strong>${code}</strong></p><p>${expiry}</p><p>${ignore}</p></body></html>`,
	};
}
