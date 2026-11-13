import { env } from "cloudflare:workers";
import { getPlatformBrand } from "~/brand/platform-brand.server";
import { required } from "~/lib/deployment";

/** One address: no display name, no brackets, nothing a header could be split on. */
const ADDRESS = /^[^\s@<>",;:]+@[^\s@<>",;:]+$/;

export type Email = {
	to: string;
	subject: string;
	text: string;
	html: string;
	/**
	 * Files sent with the message: an invoice's or an estimate's PDF (TS-074,
	 * TS-077), and the images its HTML shows, attached inline (TS-100).
	 */
	attachments?: EmailAttachment[];
	/** Headers of the message's own: a mailing's `List-Unsubscribe` and `List-Unsubscribe-Post` (TS-099). */
	headers?: Record<string, string>;
};

/**
 * The address every message the application sends is from: the one in the
 * deployment's `EMAIL_FROM`, which is also the only address its `EMAIL`
 * binding may send from (docs/security.md, "Secrets"). The name beside it is
 * the platform brand's sender name, read as each message is sent.
 *
 * `null` where the Worker has no `EMAIL` binding, which is every preview: it
 * sends nothing and needs no address. Where there is a binding and no address
 * this throws. Better Auth is not built without calling it, so a deployment
 * that could not send a sign-in code answers no sign-in request either.
 */
export function sender(): { email: string } | null {
	// The generated type says the binding always exists; a preview has none.
	const binding: SendEmail | undefined = env.EMAIL;
	if (!binding) return null;
	return { email: required(env, "EMAIL_FROM", ADDRESS) };
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
 * the request without waiting for the mail. It answers whether the message was
 * handed to Email Service, which the mailings' queue reads (TS-099).
 */
export async function sendEmail({
	to,
	subject,
	text,
	html,
	attachments,
	headers,
}: Email): Promise<boolean> {
	try {
		const from = sender();
		if (!from) {
			console.log("email: not sent, this environment has no EMAIL binding");
			return false;
		}
		const { senderName, replyTo } = await getPlatformBrand(env);
		await env.EMAIL.send({
			from: { name: senderName, email: from.email },
			...(replyTo ? { replyTo } : {}),
			to,
			subject,
			text,
			html,
			...(attachments ? { attachments } : {}),
			...(headers ? { headers } : {}),
		});
		return true;
	} catch (error) {
		// Email Service puts a code such as E_SENDER_NOT_VERIFIED on the error.
		// Its message is left out because it may quote the address.
		const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
		console.error(`email: send failed with ${code}`);
		return false;
	}
}
