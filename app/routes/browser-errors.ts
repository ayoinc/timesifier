import { env } from "cloudflare:workers";
import { REPORT_MAX_BYTES } from "~/browser-errors/report";
import {
	BrowserErrorReportSchema,
	cspLine,
	cspReports,
	isKnownRoute,
	scriptLine,
} from "~/browser-errors/report.server";
import { deviceOf } from "~/platform/device";

import type { Route } from "./+types/browser-errors";

// Where a browser reports an error in a page (app/browser-errors/reporter.ts)
// and a Content Security Policy violation (workers/security-headers.ts). Each
// report becomes one line in the Worker's log, which the Cloudflare Monitor
// counts (docs/operations.md); nothing is stored and nothing leaves Cloudflare.
//
// It never reads the session: the browser sends the site's cookies with a
// beacon on its own, and they are ignored. A report it cannot read is answered
// 400, as every action's malformed input is (decision 18); anything else 204,
// whether logged or over the limit, so probing the limit teaches nothing.
// Decision 61.

const NOTHING = () => new Response(null, { status: 204 });
const MALFORMED = () => new Response(null, { status: 400 });

/** The body as text, or `null` when it is longer than `max` bytes, which is not read any further. */
async function bodyOf(request: Request, max: number): Promise<string | null> {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function parsed(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function loader() {
	return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export async function action({ request }: Route.ActionArgs) {
	if (request.method !== "POST") return loader();

	// Per client, per minute. The address is the key and nothing else: it is
	// neither stored nor logged.
	const client = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const { success } = await env.BROWSER_ERRORS_LIMIT.limit({ key: client });
	if (!success) return NOTHING();

	const fromReportingApi =
		request.headers.get("Content-Type")?.startsWith("application/reports+json") ?? false;
	const text = await bodyOf(
		request,
		fromReportingApi ? REPORT_MAX_BYTES.reports : REPORT_MAX_BYTES.script,
	);
	if (text === null) return MALFORMED();
	const device = deviceOf(request.headers.get("User-Agent"));

	if (fromReportingApi) {
		for (const report of cspReports(parsed(text), new URL(request.url).origin)) {
			console.error(cspLine(report, device));
		}
		return NOTHING();
	}

	const report = BrowserErrorReportSchema.safeParse(parsed(text));
	if (!report.success || !(await isKnownRoute(report.data.route))) return MALFORMED();
	console.error(scriptLine(report.data, device));
	return NOTHING();
}
