import { productionHost } from "../app/auth/hosts";
import { type Settings, setting } from "../app/lib/deployment";

const LOOPBACK: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

/**
 * Production has one address, the host its deployment names in `APP_HOST`.
 * Cloudflare also publishes every version of the Worker on its own workers.dev
 * address with the production bindings, so an old version with a fixed bug
 * would stay reachable there. In production the Worker therefore answers only
 * on that host: `www.` in front of it is redirected to it and any other host
 * gets 404.
 *
 * A preview (`ENVIRONMENT` is "preview") and a local server answer on whatever
 * host they are given. A missing or unknown `ENVIRONMENT` is treated as
 * production. Where `APP_HOST` is missing, or is not a host name, no host is
 * production's: every request gets 500 and the log names the setting.
 *
 * Returns the response to send instead of the page, or `null` to carry on.
 */
export function canonicalHost(request: Request, env: Settings): Response | null {
	const url = new URL(request.url);
	if (setting(env, "ENVIRONMENT") === "preview" || LOOPBACK[url.hostname]) return null;

	let host: string;
	try {
		host = productionHost(env);
	} catch {
		return new Response("Server error", { status: 500 });
	}
	if (url.hostname === host) return null;
	if (url.hostname === `www.${host}`) {
		url.hostname = host;
		// 308 keeps the method and body, so a form posted to the alias still arrives.
		return Response.redirect(url.toString(), 308);
	}
	return new Response("Not found", { status: 404 });
}
