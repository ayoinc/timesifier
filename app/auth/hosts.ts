/**
 * The hosts the application answers on, by environment. Nothing about a
 * session or a cookie is ever derived from a `Host` header that is
 * not one of them, and no environment trusts another's hosts: production does
 * not trust a preview, which runs code that has not been reviewed, nor a
 * service on a person's own machine.
 *
 * No host is written in the code. A deployment names its own in its settings
 * (docs/security.md, "Secrets"):
 *
 * - `ENVIRONMENT` is `production`, `preview` or `development`;
 * - production trusts the one host in `APP_HOST`;
 * - a preview trusts the hosts that end with `PREVIEW_HOST_SUFFIX`;
 * - `development`, a developer's machine or a test, trusts `localhost`.
 *
 * A setting that is missing, or is not what it should be, is not replaced by
 * a guess: every function here throws, so the request fails.
 */
import { required, type Settings } from "~/lib/deployment";

const ENVIRONMENT = /^(?:production|preview|development)$/;

/** One label of a host name. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/**
 * A host name written out: lower-case labels with dots between them. Better
 * Auth reads each host it is given as a pattern, where `*` matches anything,
 * so a value must be exactly one name before it is trusted.
 */
const HOST = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);
/**
 * What follows a preview's own name: `-<worker>.<account>.workers.dev`. A
 * pull request's preview is `pr-<number>-<worker>.<account>.workers.dev`.
 */
const PREVIEW_SUFFIX = new RegExp(`^-${LABEL}\\.${LABEL}\\.workers\\.dev$`);
/** A developer's machine, on any port. */
const LOCAL = "localhost";

type OwnHosts =
	| { environment: "production"; host: string }
	| { environment: "preview"; suffix: string }
	| { environment: "development" };

function ownHosts(env: Settings): OwnHosts {
	const environment = required(env, "ENVIRONMENT", ENVIRONMENT);
	if (environment === "production") return { environment, host: productionHost(env) };
	if (environment === "preview") {
		return { environment, suffix: required(env, "PREVIEW_HOST_SUFFIX", PREVIEW_SUFFIX) };
	}
	return { environment: "development" };
}

/** The one host production is served on. Throws where the deployment names none. */
export function productionHost(env: Settings): string {
	return required(env, "APP_HOST", HOST);
}

/** The environment's hosts as patterns for Better Auth's `baseURL.allowedHosts`. */
export function allowedHosts(env: Settings): string[] {
	const hosts = ownHosts(env);
	if (hosts.environment === "production") return [hosts.host];
	if (hosts.environment === "preview") return [`*${hosts.suffix}`];
	return [LOCAL, `${LOCAL}:*`];
}

/** Whether a request was made to one of the environment's own hosts. */
export function isOurHost(request: Request, env: Settings): boolean {
	const hosts = ownHosts(env);
	const { host, hostname } = new URL(request.url);
	if (hosts.environment === "production") return host === hosts.host;
	if (hosts.environment === "preview") return host.endsWith(hosts.suffix);
	return hostname === LOCAL;
}
