const APEX = "timesifier.com";
const ALIAS = `www.${APEX}`;
const LOOPBACK: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

/**
 * Production has one address. Cloudflare also publishes every version of the
 * Worker on its own workers.dev address with the production bindings, so an
 * old version with a fixed bug would stay reachable there. In production the
 * Worker therefore answers only on the apex: `www` is redirected to it and any
 * other host gets 404.
 *
 * A preview (`ENVIRONMENT` is "preview") and a local server answer on whatever
 * host they are given. A missing or unknown `ENVIRONMENT` is treated as
 * production.
 *
 * Returns the response to send instead of the page, or `null` to carry on.
 */
export function canonicalHost(request: Request, environment: string | undefined): Response | null {
	const url = new URL(request.url);
	if (environment === "preview" || LOOPBACK[url.hostname] || url.hostname === APEX) {
		return null;
	}
	if (url.hostname === ALIAS) {
		url.hostname = APEX;
		// 308 keeps the method and body, so a form posted to the alias still arrives.
		return Response.redirect(url.toString(), 308);
	}
	return new Response("Not found", { status: 404 });
}
