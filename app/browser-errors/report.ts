// What a browser tells the application when something goes wrong in a page
// (TS-107d, decision 61), shared by the script that sends it
// (./reporter.ts), the endpoint that logs it (./report.server.ts) and the
// privacy notice, which names these fields from the lists below.
//
// The rule: a report names what failed and where in the code, never what a
// person typed or which record they were on. So it carries the error's name and
// never its message (which can hold anything typed, or an address), and the
// route's pattern, such as `/app/:organisation/expenses`, and never the page's
// address (which holds the organisation's slug, record ids, a query and a
// fragment).

/** Where a browser sends its reports, both the script's and the CSP's. Same origin, so `connect-src 'self'` allows it. */
export const BROWSER_ERRORS_PATH = "/browser-errors";

/** The name the CSP's `report-to` and the `Reporting-Endpoints` header give that address. */
export const REPORTING_ENDPOINT = "csp";

/** The most reports one page load sends; each distinct error is sent once. */
export const MAX_REPORTS_PER_PAGE = 5;

/** The most a report from the script, or a batch from the browser's Reporting API, may weigh. Larger ones are dropped unread. */
export const REPORT_MAX_BYTES = { script: 4 * 1024, reports: 16 * 1024 };

/** How many reports one client may have logged a minute (the binding's limit in wrangler.jsonc). */
export const REPORTS_PER_MINUTE = 20;

/** The beginning of every line a report writes, which the Cloudflare Monitor counts (docs/operations.md). */
export const LOG_PREFIX = "browser-error:";

/**
 * The kinds of error the script reports: an error nothing caught, a promise
 * rejection nothing handled, and an error a route's error boundary caught
 * while drawing a page. A CSP violation, the fourth kind, comes from the
 * browser itself.
 */
export const SCRIPT_KINDS = ["error", "rejection", "react"] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

/** Every field of a report from the script, and nothing else. */
export const BROWSER_ERROR_FIELDS = ["kind", "name", "route", "frame", "release", "time"] as const;

/** The fields kept from a CSP violation report. Everything else in it (the page's address, the referrer, a sample of the code) is dropped. */
export const CSP_REPORT_FIELDS = [
	"effectiveDirective",
	"blockedURL",
	"sourceFile",
	"lineNumber",
] as const;

/** How the privacy notice names each field of a report from the script, in the fields' order. */
export const BROWSER_ERROR_FIELD_WORDS: Record<(typeof BROWSER_ERROR_FIELDS)[number], string> = {
	kind: "the kind of failure",
	name: "the error's name (such as TypeError)",
	route: "the pattern of the page's address (such as /app/:organisation/expenses)",
	frame: "the place in Timesifier's own code",
	release: "Timesifier's release",
	time: "the time",
};

/** How the privacy notice names each field kept from a CSP violation report, in the fields' order. */
export const CSP_REPORT_FIELD_WORDS: Record<(typeof CSP_REPORT_FIELDS)[number], string> = {
	effectiveDirective: "the rule",
	blockedURL: "the site of what was blocked",
	sourceFile: "the script that asked for it",
	lineNumber: "the line",
};

/**
 * The privacy notice's sentence about these reports (its "Logs" row), from the
 * fields above, so the notice names exactly what a report carries.
 */
export function browserErrorNotice(host: string): string {
	const list = new Intl.ListFormat("en-GB", { type: "conjunction" });
	const script = list.format(BROWSER_ERROR_FIELDS.map((field) => BROWSER_ERROR_FIELD_WORDS[field]));
	const csp = list.format(CSP_REPORT_FIELDS.map((field) => CSP_REPORT_FIELD_WORDS[field]));
	return `If a page fails in your browser, or your browser blocks something the page does not allow, ${host} keeps only ${script}, or ${csp}, and never the error's message, the page's address or anything you typed, each as one line of this log with the kind of browser, such as Chrome on macOS.`;
}

/** A route's pattern: `/`-separated literal words, `:name` parameters and `*`. No query, no fragment, nothing typed. */
export const ROUTE_PATTERN =
	/^\/(?:(?:[a-z0-9.-]+|:[A-Za-z][A-Za-z0-9]*\??|\*)(?:\/(?:[a-z0-9.-]+|:[A-Za-z][A-Za-z0-9]*\??|\*))*)?$/;

/** The route when none was matched yet. */
export const UNKNOWN_ROUTE = "unknown";

/** An error's name as JavaScript writes one, such as `TypeError`. */
export const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

/** The top frame in one of the site's own scripts, as `assets/<file>.js:<line>:<column>`. */
export const OWN_FRAME = /^assets\/[\w.-]{1,120}\.js:\d{1,7}:\d{1,7}$/;

/** The build's version, from React Router's manifest. */
export const RELEASE = /^[\w.-]{1,40}$/;

/** A report from the script: exactly `BROWSER_ERROR_FIELDS`. */
export type BrowserErrorReport = {
	kind: ScriptKind;
	name: string;
	route: string;
	frame: string | null;
	release: string;
	time: string;
};

/** An error's name, for a report, without reading its message or anything else it holds. */
export function errorName(value: unknown): string {
	if (value instanceof Error) return ERROR_NAME.test(value.name) ? value.name : "Error";
	return value === null ? "null" : typeof value;
}

/** A route's pattern from the paths of the routes that matched, outermost first. */
export function routePattern(paths: readonly (string | undefined)[]): string {
	const segments = paths.flatMap((path) => (path ?? "").split("/")).filter(Boolean);
	const pattern = `/${segments.join("/")}`;
	return ROUTE_PATTERN.test(pattern) ? pattern : UNKNOWN_ROUTE;
}

/** The top frame of a stack that is in one of the site's own scripts under `/assets/`, or `null`. */
export function ownFrame(stack: string | undefined, origin: string): string | null {
	if (!stack) return null;
	for (const line of stack.split("\n")) {
		const at = line.indexOf(`${origin}/assets/`);
		if (at === -1) continue;
		const match = /^\/(assets\/[\w.-]+\.js):(\d+):(\d+)/.exec(line.slice(at + origin.length));
		if (match) return `${match[1]}:${match[2]}:${match[3]}`;
	}
	return null;
}
