/**
 * The hosts the application answers on. Nothing about a session, a cookie or a
 * passkey is ever derived from a `Host` header that is not one of these.
 */
const PRODUCTION = "timesifier.com";
/** A pull request's preview is `pr-<number>-timesifier.ayoinc.workers.dev`. */
const PREVIEW_SUFFIX = "-timesifier.ayoinc.workers.dev";
/** A developer's machine, on any port. */
const LOCAL = "localhost";

/** The same hosts as patterns for Better Auth's `baseURL.allowedHosts`. */
export const ALLOWED_HOSTS = [PRODUCTION, `*${PREVIEW_SUFFIX}`, LOCAL, `${LOCAL}:*`];

/** Whether a request was made to one of the application's own hosts. */
export function isOurHost(request: Request): boolean {
	const { host, hostname } = new URL(request.url);
	return host === PRODUCTION || host.endsWith(PREVIEW_SUFFIX) || hostname === LOCAL;
}
