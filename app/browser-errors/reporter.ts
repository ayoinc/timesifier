import {
	BROWSER_ERRORS_PATH,
	type BrowserErrorReport,
	errorName,
	MAX_REPORTS_PER_PAGE,
	ownFrame,
	routePattern,
	type ScriptKind,
	UNKNOWN_ROUTE,
} from "./report";

// The browser's side of the error reports (TS-107d, decision 61). It runs from
// app/entry.client.tsx, the site's own script, which the page's nonce lets in;
// the policy gains nothing. Each distinct error is sent once, and a page load
// sends at most `MAX_REPORTS_PER_PAGE`. What a report holds is in ./report.ts.

/** What React Router keeps on `window` that a report reads: the routes that matched, and the build's version. */
type RouterGlobals = {
	__reactRouterDataRouter?: { state: { matches: readonly { route: { path?: string } }[] } };
	__reactRouterManifest?: { version?: string };
};

const sent = new Set<string>();

/** The pattern of the route on show, such as `/app/:organisation/expenses`. */
function currentPattern(): string {
	const matches = (window as RouterGlobals).__reactRouterDataRouter?.state.matches;
	return matches ? routePattern(matches.map(({ route }) => route.path)) : UNKNOWN_ROUTE;
}

/** Sends one report of `value`, thrown or rejected, unless it was sent already or the page has sent its share. */
export function report(kind: ScriptKind, value: unknown, pattern?: string): void {
	if (sent.size >= MAX_REPORTS_PER_PAGE) return;
	const body: BrowserErrorReport = {
		kind,
		name: errorName(value),
		route: pattern === undefined ? currentPattern() : routePattern([pattern]),
		frame: ownFrame(value instanceof Error ? value.stack : undefined, window.location.origin),
		release: (window as RouterGlobals).__reactRouterManifest?.version ?? "unknown",
		time: new Date().toISOString(),
	};
	const fingerprint = `${body.kind} ${body.name} ${body.route} ${body.frame}`;
	if (sent.has(fingerprint)) return;
	sent.add(fingerprint);
	// A beacon is sent even as the page closes. Sent as text, so it needs no preflight.
	navigator.sendBeacon(BROWSER_ERRORS_PATH, JSON.stringify(body));
}

/**
 * Reports every error nothing caught and every rejection nothing handled. React
 * hands the errors it does not catch, and those it recovers from, to the same
 * place (`window.reportError`), so they arrive here too.
 */
export function startReporting(): void {
	window.addEventListener("error", (event) => report("error", event.error));
	window.addEventListener("unhandledrejection", (event) => report("rejection", event.reason));
}
