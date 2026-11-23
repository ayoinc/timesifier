import { z } from "zod";

import {
	type BrowserErrorReport,
	type CSP_REPORT_FIELDS,
	ERROR_NAME,
	LOG_PREFIX,
	MAX_REPORTS_PER_PAGE,
	OWN_FRAME,
	RELEASE,
	ROUTE_PATTERN,
	routePattern,
	SCRIPT_KINDS,
	UNKNOWN_ROUTE,
} from "./report";

// How the endpoint (routes/browser-errors.ts) reads a report and the one log
// line it writes for each. A report that does not match is dropped whole.

export const BrowserErrorReportSchema = z.strictObject({
	kind: z.enum(SCRIPT_KINDS),
	name: z.string().regex(ERROR_NAME),
	route: z.union([z.literal(UNKNOWN_ROUTE), z.string().max(200).regex(ROUTE_PATTERN)]),
	frame: z.string().regex(OWN_FRAME).nullable(),
	release: z.string().regex(RELEASE),
	time: z.iso.datetime(),
}) satisfies z.ZodType<BrowserErrorReport>;

let patterns: Set<string> | undefined;

/**
 * Whether `route` is the pattern of one of the application's routes, or
 * `unknown`. A route's address has the shape of a pattern (`/app/acme`), so the
 * shape alone does not keep an address, and the organisation it names, out of
 * the log: the list of the routes that exist does.
 */
export async function isKnownRoute(route: string): Promise<boolean> {
	if (route === UNKNOWN_ROUTE) return true;
	if (!patterns) {
		// The build this Worker runs, already loaded: it is what answered the request.
		const { routes } = await import("virtual:react-router/server-build");
		const pathsOf = (id: string | undefined): (string | undefined)[] => {
			const route = id === undefined ? undefined : routes[id];
			return route ? [...pathsOf(route.parentId), route.path] : [];
		};
		patterns = new Set(Object.keys(routes).map((id) => routePattern(pathsOf(id))));
	}
	return patterns.has(route);
}

/** The one log line for a report from the script. */
export function scriptLine(report: BrowserErrorReport, device: string): string {
	const { kind, name, route, frame, release, time } = report;
	return `${LOG_PREFIX} ${kind} ${name} at ${route} in ${frame ?? "unknown"} (release ${release}, ${time}) on ${device}`;
}

/** A violation report as the Reporting API sends it, with only the fields that are read. */
const CspViolation = z.object({
	type: z.literal("csp-violation"),
	body: z.object({
		effectiveDirective: z.string().regex(/^[a-z-]{1,40}$/),
		blockedURL: z.string().max(2048).optional(),
		sourceFile: z.string().max(2048).optional(),
		lineNumber: z.number().int().nonnegative().optional(),
	}),
});

/** The CSP report's keywords for what was blocked when it was not a file. */
const BLOCKED_KEYWORDS: Record<string, true> = {
	inline: true,
	eval: true,
	"wasm-eval": true,
	"trusted-types-policy": true,
	"trusted-types-sink": true,
};

/** The origin of an address, or its scheme where it has no origin (`data:`), or `unknown`. */
function originOf(address: string): string {
	try {
		const url = new URL(address);
		return url.origin === "null" ? url.protocol : url.origin;
	} catch {
		return "unknown";
	}
}

/**
 * Where the violating code was: a path of the site's own scripts, kept whole;
 * the site's page itself, as `page`, since its path holds the organisation and
 * record ids; or another origin.
 */
function sourceOf(address: string | undefined, origin: string): string {
	if (!address) return "unknown";
	try {
		const url = new URL(address);
		if (url.origin !== origin) return originOf(address);
		return /^\/assets\/[\w.-]+\.js$/.test(url.pathname) ? url.pathname : "page";
	} catch {
		return "unknown";
	}
}

export type CspReport = Record<(typeof CSP_REPORT_FIELDS)[number], string>;

/** The kept fields of each CSP violation in a Reporting API batch, at most `MAX_REPORTS_PER_PAGE`. Anything else is skipped. */
export function cspReports(batch: unknown, origin: string): CspReport[] {
	if (!Array.isArray(batch)) return [];
	return batch
		.flatMap((entry) => {
			const parsed = CspViolation.safeParse(entry);
			if (!parsed.success) return [];
			const { effectiveDirective, blockedURL, sourceFile, lineNumber } = parsed.data.body;
			return [
				{
					effectiveDirective,
					blockedURL:
						blockedURL === undefined
							? "unknown"
							: BLOCKED_KEYWORDS[blockedURL] === true
								? blockedURL
								: originOf(blockedURL),
					sourceFile: sourceOf(sourceFile, origin),
					lineNumber: lineNumber === undefined ? "unknown" : String(lineNumber),
				},
			];
		})
		.slice(0, MAX_REPORTS_PER_PAGE);
}

/** The one log line for a CSP violation. */
export function cspLine(report: CspReport, device: string): string {
	const { effectiveDirective, blockedURL, sourceFile, lineNumber } = report;
	return `${LOG_PREFIX} csp ${effectiveDirective} blocked ${blockedURL} from ${sourceFile}:${lineNumber} on ${device}`;
}
