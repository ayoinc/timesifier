import { env } from "cloudflare:workers";

/**
 * Every message the application sends comes from this one address, on the
 * subdomain that exists only for the application's mail (docs/architecture.md).
 */
export const SENDER = { name: "Timesifier", email: "no-reply@mail.timesifier.com" } as const;

export type Email = {
	to: string;
	subject: string;
	text: string;
	html: string;
};

/**
 * Sends one message through Cloudflare Email Service. This function is the only
 * code that touches the `EMAIL` binding.
 *
 * Where the Worker has no `EMAIL` binding, which is every preview, nothing is
 * sent. Either way the log names the recipient's domain only: the address and
 * the message, which may carry a sign-in code, are never logged.
 *
 * It never throws, so a caller may hand the promise to `waitUntil` and answer
 * the request without waiting for the mail.
 */
export async function sendEmail({ to, subject, text, html }: Email): Promise<void> {
	const domain = to.slice(to.lastIndexOf("@") + 1);
	// The generated type says the binding always exists; a preview has none.
	const binding: SendEmail | undefined = env.EMAIL;

	if (!binding) {
		console.log(`email: not sent, this environment has no EMAIL binding (recipient at ${domain})`);
		return;
	}

	try {
		await binding.send({ from: SENDER, to, subject, text, html });
	} catch (error) {
		// Email Service puts a code such as E_SENDER_NOT_VERIFIED on the error.
		// Its message is left out because it may quote the address.
		const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
		console.error(`email: send failed with ${code} (recipient at ${domain})`);
	}
}
