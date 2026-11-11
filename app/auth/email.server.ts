import { env } from "cloudflare:workers";
import { required } from "~/lib/deployment";

/** The name every message is from. */
const SENDER_NAME = "Timesifier";
/** One address: no display name, no brackets, nothing a header could be split on. */
const ADDRESS = /^[^\s@<>",;:]+@[^\s@<>",;:]+$/;

export type Email = {
	to: string;
	subject: string;
	text: string;
	html: string;
};

/**
 * Who every message the application sends is from: the product's name and the
 * one address in the deployment's `EMAIL_FROM`, which is also the only address
 * its `EMAIL` binding may send from (docs/security.md, "Secrets").
 *
 * `null` where the Worker has no `EMAIL` binding, which is every preview: it
 * sends nothing and needs no address. Where there is a binding and no address
 * this throws. Better Auth is not built without calling it, so a deployment
 * that could not send a sign-in code answers no sign-in request either.
 */
export function sender(): { name: string; email: string } | null {
	// The generated type says the binding always exists; a preview has none.
	const binding: SendEmail | undefined = env.EMAIL;
	if (!binding) return null;
	return { name: SENDER_NAME, email: required(env, "EMAIL_FROM", ADDRESS) };
}

/**
 * Sends one message through Cloudflare Email Service. This function is the only
 * code that touches the `EMAIL` binding.
 *
 * Where the Worker has no `EMAIL` binding, which is every preview, nothing is
 * sent. Either way the log says nothing about the recipient, not even the
 * domain, which names a person when one person uses it; and nothing of the
 * message, which may carry a sign-in code.
 *
 * It never throws, so a caller may hand the promise to `waitUntil` and answer
 * the request without waiting for the mail.
 */
export async function sendEmail({ to, subject, text, html }: Email): Promise<void> {
	try {
		const from = sender();
		if (!from) {
			console.log("email: not sent, this environment has no EMAIL binding");
			return;
		}
		await env.EMAIL.send({ from, to, subject, text, html });
	} catch (error) {
		// Email Service puts a code such as E_SENDER_NOT_VERIFIED on the error.
		// Its message is left out because it may quote the address.
		const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
		console.error(`email: send failed with ${code}`);
	}
}
