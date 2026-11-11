import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://timesifier.com";

// `exports.default.fetch` calls the Worker's real fetch handler (workers/app.ts).
const worker = exports.default;

function nonceIn(policy: string | null): string {
	const nonce = policy?.match(/'nonce-([^']+)'/)?.[1];
	if (!nonce) throw new Error(`no nonce in policy: ${policy}`);
	return nonce;
}

async function expectBrowserPolicy(response: Response) {
	const { headers } = response;
	expect(headers.get("Content-Type")).toContain("text/html");

	const policy = headers.get("Content-Security-Policy") ?? "";
	const nonce = nonceIn(policy);
	expect(policy.split("; ")).toEqual([
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}'`,
		// The two hashes are the <style> elements React Aria inserts from script; see
		// docs/security.md. test/node/react-aria-styles.test.ts derives them from the library.
		"style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='",
		"img-src 'self' data:",
		"font-src 'self'",
		"connect-src 'self'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"object-src 'none'",
	]);
	expect(policy).not.toContain("unsafe-inline");
	expect(policy).not.toContain("unsafe-eval");
	// At least 128 bits: 16 bytes are 24 base64 characters.
	expect(atob(nonce).length).toBeGreaterThanOrEqual(16);

	expect(headers.get("Strict-Transport-Security")).toBe("max-age=63072000");
	expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
	expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(headers.get("X-Frame-Options")).toBe("DENY");
	expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");

	const permissions = (headers.get("Permissions-Policy") ?? "").split(", ");
	const allowed = permissions.filter((directive) => !directive.endsWith("=()"));
	expect(allowed.sort()).toEqual([
		"publickey-credentials-create=(self)",
		"publickey-credentials-get=(self)",
	]);
	for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
		expect(permissions).toContain(`${feature}=()`);
	}

	// Every script in the document carries this response's nonce.
	const scripts = (await response.text()).match(/<script\b[^>]*>/g) ?? [];
	expect(scripts.length).toBeGreaterThan(0);
	for (const script of scripts) {
		expect(script).toContain(`nonce="${nonce}"`);
	}
}

describe("browser policy headers", () => {
	it("sends the full policy on an HTML page, with the page's scripts carrying the nonce", async () => {
		const response = await worker.fetch(`${ORIGIN}/`);
		expect(response.status).toBe(200);
		await expectBrowserPolicy(response);
	});

	it("uses a different nonce for every request", async () => {
		const first = await worker.fetch(`${ORIGIN}/`);
		const second = await worker.fetch(`${ORIGIN}/`);
		expect(nonceIn(first.headers.get("Content-Security-Policy"))).not.toBe(
			nonceIn(second.headers.get("Content-Security-Policy")),
		);
	});

	it("sends the same policy on a 404 page", async () => {
		const response = await worker.fetch(`${ORIGIN}/no-such-page`);
		expect(response.status).toBe(404);
		await expectBrowserPolicy(response);
	});

	it("sends HSTS, nosniff and a policy under which nothing loads on a response that is not HTML", async () => {
		const response = await worker.fetch(`${ORIGIN}/`, {
			method: "POST",
			headers: { Origin: "https://attacker.example" },
		});
		expect(response.headers.get("Content-Type")).toContain("text/plain");
		expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=63072000");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Content-Security-Policy")).toBe(
			"default-src 'none'; frame-ancestors 'none'",
		);
	});

	it("redirects www to the apex with HSTS, so the alias is never served over plain HTTP again", async () => {
		const response = await worker.fetch("https://www.timesifier.com/reports?week=46", {
			redirect: "manual",
		});
		expect(response.status).toBe(308);
		expect(response.headers.get("Location")).toBe(`${ORIGIN}/reports?week=46`);
		expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=63072000");
	});

	it("answers 404 on the workers.dev address Cloudflare gives each production version", async () => {
		const response = await worker.fetch("https://41b1b1d9-timesifier.ayoinc.workers.dev/");
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("Timesifier");
	});
});

describe("origin check on state-changing requests", () => {
	// No route answers this path, so the framework's own reply to a request that
	// reaches it is its 404 page.
	const url = `${ORIGIN}/no-such-page`;

	it.each(["POST", "PUT", "PATCH", "DELETE"])(
		"rejects a %s from a foreign Origin",
		async (method) => {
			const response = await worker.fetch(url, {
				method,
				headers: { Origin: "https://attacker.example" },
			});
			expect(response.status).toBe(403);
		},
	);

	it("rejects a POST from an opaque origin", async () => {
		const response = await worker.fetch(url, { method: "POST", headers: { Origin: "null" } });
		expect(response.status).toBe(403);
	});

	it.each(["cross-site", "same-site"])("rejects a POST with Sec-Fetch-Site: %s", async (site) => {
		const response = await worker.fetch(url, {
			method: "POST",
			headers: { "Sec-Fetch-Site": site },
		});
		expect(response.status).toBe(403);
	});

	it("rejects a POST whose Origin is ours when the browser says it is cross-site", async () => {
		const response = await worker.fetch(url, {
			method: "POST",
			headers: { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" },
		});
		expect(response.status).toBe(403);
	});

	it("lets a POST from the application's own origin reach the framework", async () => {
		const response = await worker.fetch(url, {
			method: "POST",
			headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
		});
		expect(response.status).toBe(404);
	});

	it("lets a POST with neither header reach the framework", async () => {
		const response = await worker.fetch(url, { method: "POST" });
		expect(response.status).toBe(404);
	});

	it("does not block a GET from a foreign Origin", async () => {
		const response = await worker.fetch(`${ORIGIN}/`, {
			headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
		});
		expect(response.status).toBe(200);
	});

	it("rejects a WebSocket handshake from a foreign Origin, and lets one from our own through", async () => {
		const handshake = (origin: string) =>
			worker.fetch(url, { headers: { Upgrade: "websocket", Origin: origin } });

		expect((await handshake("https://attacker.example")).status).toBe(403);
		expect((await handshake(ORIGIN)).status).toBe(404);
	});
});
