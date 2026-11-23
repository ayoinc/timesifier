/**
 * Where a browser reports an error in a page and a CSP violation (TS-107d):
 * one log line for each report, holding nothing a person typed and no address,
 * a limit on how many a client may have logged, and always 204.
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BROWSER_ERROR_FIELDS,
	BROWSER_ERRORS_PATH,
	CSP_REPORT_FIELDS,
	REPORT_MAX_BYTES,
	REPORTS_PER_MINUTE,
} from "~/browser-errors/report";
import { cspReports } from "~/browser-errors/report.server";
import { ORIGIN } from "./auth/harness";

const CHROME_ON_MACOS =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Each test is its own client, so the per-minute counts of one never reach another. */
let client = 0;
const nextClient = () => `198.51.100.${++client}`;

const REPORT = {
	kind: "error",
	name: "TypeError",
	route: "/app/:organisation/expenses",
	frame: "assets/timesheet-Bq3x9.js:1:2045",
	release: "4f2a9c1e",
	time: "2026-11-23T07:00:00.000Z",
};

function send(
	body: string,
	{
		ip = nextClient(),
		contentType = "text/plain;charset=UTF-8",
		cookie,
	}: { ip?: string; contentType?: string; cookie?: string } = {},
) {
	return exports.default.fetch(
		new Request(`${ORIGIN}${BROWSER_ERRORS_PATH}`, {
			method: "POST",
			headers: {
				Origin: ORIGIN,
				"Content-Type": contentType,
				"User-Agent": CHROME_ON_MACOS,
				"CF-Connecting-IP": ip,
				...(cookie ? { Cookie: cookie } : {}),
			},
			body,
		}),
	);
}

/** Every line written to the console from here on. */
function logLines(): string[] {
	const lines: string[] = [];
	for (const level of ["debug", "log", "info", "warn", "error"] as const) {
		vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
			lines.push(parts.map(String).join(" "));
		});
	}
	return lines;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a report from the page's script", () => {
	it("is logged as one line of its fields, with the kind of browser, and answered 204", async () => {
		const lines = logLines();

		const response = await send(JSON.stringify(REPORT));

		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(lines).toEqual([
			"browser-error: error TypeError at /app/:organisation/expenses in assets/timesheet-Bq3x9.js:1:2045 (release 4f2a9c1e, 2026-11-23T07:00:00.000Z) on Chrome on macOS",
		]);
		expect(Object.keys(REPORT)).toEqual([...BROWSER_ERROR_FIELDS]);
	});

	it("never reads the session, nor anything else in the database", async () => {
		const prepare = vi.spyOn(env.DB, "prepare");
		const lines = logLines();

		await send(JSON.stringify(REPORT), {
			cookie: "__Secure-better-auth.session_token=secret-token",
		});

		expect(prepare).not.toHaveBeenCalled();
		expect(lines).toHaveLength(1);
		expect(lines.join("\n")).not.toContain("secret-token");
	});

	it.each([
		["a message", { ...REPORT, message: "Cannot read 'ada@example.com'" }],
		["the page's address", { ...REPORT, url: `${ORIGIN}/app/acme/timesheet?week=46` }],
		["an address for a route", { ...REPORT, route: "/app/acme/expenses" }],
		["a query in the route", { ...REPORT, route: "/app/:organisation?email=ada@example.com" }],
		["a fragment in the route", { ...REPORT, route: "/app/:organisation#ada" }],
		["words for a name", { ...REPORT, name: "Cannot read ada@example.com" }],
		["another site's script for a frame", { ...REPORT, frame: "https://evil.example/x.js:1:1" }],
		["an id", { ...REPORT, organisationId: "0193a1b2-c3d4" }],
		["a field missing", { ...REPORT, time: undefined }],
	])("is dropped whole, and answered 400, when it carries %s", async (_, report) => {
		const lines = logLines();

		const response = await send(JSON.stringify(report));

		expect(response.status).toBe(400);
		expect(lines).toEqual([]);
	});

	it("is dropped unread when it is larger than 4 KB", async () => {
		const lines = logLines();
		const padded = JSON.stringify({ ...REPORT, release: "x".repeat(REPORT_MAX_BYTES.script) });

		const response = await send(padded);

		expect(response.status).toBe(400);
		expect(lines).toEqual([]);
	});

	it("is not answered to a GET", async () => {
		const response = await exports.default.fetch(`${ORIGIN}${BROWSER_ERRORS_PATH}`);

		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST");
	});
});

describe("the rate limit", () => {
	it(`logs at most ${REPORTS_PER_MINUTE} reports a minute from one client, and another client still gets through`, async () => {
		const lines = logLines();
		const ip = nextClient();

		for (let sent = 0; sent < REPORTS_PER_MINUTE + 5; sent++) {
			const response = await send(JSON.stringify(REPORT), { ip });
			expect(response.status).toBe(204);
		}
		expect(lines).toHaveLength(REPORTS_PER_MINUTE);

		await send(JSON.stringify(REPORT));
		expect(lines).toHaveLength(REPORTS_PER_MINUTE + 1);
	});

	it("is the binding's, in wrangler.jsonc, for production and the previews alike", () => {
		const wrangler = import.meta.glob<string>("../wrangler.jsonc", {
			eager: true,
			query: "?raw",
			import: "default",
		})["../wrangler.jsonc"];
		const limits = [
			...(wrangler ?? "").matchAll(
				/"name": "BROWSER_ERRORS_LIMIT"[\s\S]*?"limit": (\d+),\s*"period": (\d+)/g,
			),
		];
		expect(limits.map(([, limit, period]) => [Number(limit), Number(period)])).toEqual([
			[REPORTS_PER_MINUTE, 60],
			[REPORTS_PER_MINUTE, 60],
		]);
	});
});

describe("a CSP violation report", () => {
	const violation = (body: Record<string, unknown>) => ({
		type: "csp-violation",
		age: 10,
		url: `${ORIGIN}/app/acme/projects/0193a1b2?search=ada@example.com`,
		user_agent: CHROME_ON_MACOS,
		body: {
			documentURL: `${ORIGIN}/app/acme/projects/0193a1b2?search=ada@example.com`,
			referrer: `${ORIGIN}/app/acme?from=ada@example.com`,
			sample: "console.log('ada@example.com')",
			disposition: "enforce",
			statusCode: 200,
			originalPolicy: "default-src 'self'",
			columnNumber: 7,
			...body,
		},
	});

	it("keeps only the directive, the blocked origin, the script and the line", async () => {
		const lines = logLines();
		const batch = [
			violation({
				effectiveDirective: "script-src-elem",
				blockedURL: "https://evil.example/steal.js?token=secret-token",
				sourceFile: `${ORIGIN}/assets/entry.client-Ab12.js`,
				lineNumber: 12,
			}),
			violation({
				effectiveDirective: "script-src-elem",
				blockedURL: "inline",
				sourceFile: `${ORIGIN}/app/acme/projects/0193a1b2?search=ada@example.com`,
				lineNumber: 3,
			}),
		];

		const response = await send(JSON.stringify(batch), { contentType: "application/reports+json" });

		expect(response.status).toBe(204);
		expect(lines).toEqual([
			"browser-error: csp script-src-elem blocked https://evil.example from /assets/entry.client-Ab12.js:12 on Chrome on macOS",
			"browser-error: csp script-src-elem blocked inline from page:3 on Chrome on macOS",
		]);
		for (const secret of [
			"acme",
			"0193a1b2",
			"ada@example.com",
			"secret-token",
			"steal.js",
			"console.log",
		]) {
			expect(lines.join("\n")).not.toContain(secret);
		}
	});

	it("is read into exactly the kept fields", () => {
		const [kept] = cspReports(
			[
				violation({
					effectiveDirective: "img-src",
					blockedURL: "data:image/png;base64,AAAA",
					lineNumber: 1,
				}),
			],
			ORIGIN,
		);
		expect(Object.keys(kept ?? {})).toEqual([...CSP_REPORT_FIELDS]);
		expect(kept).toEqual({
			effectiveDirective: "img-src",
			blockedURL: "data:",
			sourceFile: "unknown",
			lineNumber: "1",
		});
	});

	it("skips anything in the batch that is not a CSP violation, and a batch over 16 KB", async () => {
		const lines = logLines();

		await send(
			JSON.stringify([{ type: "deprecation", body: { id: "x", message: "ada@example.com" } }]),
			{
				contentType: "application/reports+json",
			},
		);
		const heavy = JSON.stringify(
			Array.from({ length: 40 }, () =>
				violation({ effectiveDirective: "img-src", blockedURL: "https://evil.example/a.png" }),
			),
		);
		expect(heavy.length).toBeGreaterThan(REPORT_MAX_BYTES.reports);
		await send(heavy, { contentType: "application/reports+json" });

		expect(lines).toEqual([]);
	});
});
