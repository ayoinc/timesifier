/**
 * Turnstile on the one request that sends email, which is also the only way to
 * start an account. The token arrives in the `x-captcha-response` header.
 *
 * Better Auth's captcha plugin asks Cloudflare whether the token is good, and
 * fails closed when Cloudflare cannot be reached. It also compares the
 * hostname in Cloudflare's answer, the site the widget was solved on, with a
 * list it is given. That list is fixed when the plugin is made, and a
 * preview's host is different for every pull request, so the plugin is made
 * for each request, with that request's own host as the one hostname allowed.
 * A token solved on any other site is refused, even where the widget's own
 * settings at Cloudflare would have let it through.
 */
import { captcha } from "better-auth/plugins/captcha";
import type { BetterAuthPlugin } from "better-auth/types";

/**
 * Cloudflare's published test secrets. They are the same for everyone and are
 * not secrets: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
const TEST_SECRETS: Record<string, true> = {
	"1x0000000000000000000000000000000AA": true,
	"2x0000000000000000000000000000000AA": true,
	"3x0000000000000000000000000000000AA": true,
};
/**
 * The hostname in every answer to a test secret, wherever the widget was. It
 * is accepted with a test secret and with nothing else.
 */
const TEST_HOSTNAME = "example.com";

/** Spread into Better Auth's `plugins`. `path` is the one request it guards. */
export function turnstile(secretKey: string, path: string): BetterAuthPlugin {
	const hostnameFor = Object.hasOwn(TEST_SECRETS, secretKey)
		? () => TEST_HOSTNAME
		: (request: Request) => new URL(request.url).hostname;

	return {
		id: "turnstile",
		onRequest: (request, ctx) =>
			captcha({
				provider: "cloudflare-turnstile",
				secretKey,
				endpoints: [path],
				allowedHostnames: [hostnameFor(request)],
			}).onRequest(request, ctx),
	};
}
