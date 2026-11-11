/**
 * The hosts the application answers on, by environment. Nothing about a
 * session or a cookie is ever derived from a `Host` header that is
 * not one of them, and no environment trusts another's hosts: production does
 * not trust a preview, which runs code that has not been reviewed, nor a
 * service on a person's own machine.
 *
 * The environment is the variable `ENVIRONMENT` (wrangler.jsonc). Any value
 * but `production` and `preview` means a developer's machine or a test, where
 * only `localhost` is trusted; a deployed Worker that lost the variable would
 * therefore answer no sign-in request at all.
 */
const PRODUCTION = "timesifier.com";
/** A pull request's preview is `pr-<number>-timesifier.ayoinc.workers.dev`. */
const PREVIEW_SUFFIX = "-timesifier.ayoinc.workers.dev";
/** A developer's machine, on any port. */
const LOCAL = "localhost";

/** The environment's hosts as patterns for Better Auth's `baseURL.allowedHosts`. */
export function allowedHosts(environment: string | undefined): string[] {
	if (environment === "production") return [PRODUCTION];
	if (environment === "preview") return [`*${PREVIEW_SUFFIX}`];
	return [LOCAL, `${LOCAL}:*`];
}

/** Whether a request was made to one of the environment's own hosts. */
export function isOurHost(request: Request, environment: string | undefined): boolean {
	const { host, hostname } = new URL(request.url);
	if (environment === "production") return host === PRODUCTION;
	if (environment === "preview") return host.endsWith(PREVIEW_SUFFIX);
	return hostname === LOCAL;
}
