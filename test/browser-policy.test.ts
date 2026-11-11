import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POLICY_ADDITION_HEADER, withSecurityHeaders } from "../workers/security-headers";
import { captureEmail, signIn } from "./auth/harness";
import { freshDatabase } from "./db/database";
import { createOrganisation, invite } from "./organisations/harness";

const ORIGIN = "https://timesifier.example";

// `exports.default.fetch` calls the Worker's real fetch handler (workers/app.ts).
const worker = exports.default;

function nonceIn(policy: string | null): string {
	const nonce = policy?.match(/'nonce-([^']+)'/)?.[1];
	if (!nonce) throw new Error(`no nonce in policy: ${policy}`);
	return nonce;
}

/**
 * The whole policy of an HTML page, directive by directive. `turnstile` is the
 * one addition a route can ask for: Cloudflare's script, and the frame it runs in.
 */
async function expectBrowserPolicy(response: Response, { turnstile = false } = {}) {
	const { headers } = response;
	expect(headers.get("Content-Type")).toContain("text/html");
	// How a route asks for the addition is the Worker's business, not a browser's.
	expect(headers.has(POLICY_ADDITION_HEADER)).toBe(false);

	const policy = headers.get("Content-Security-Policy") ?? "";
	const nonce = nonceIn(policy);
	expect(policy.split("; ")).toEqual([
		"default-src 'self'",
		turnstile
			? `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com`
			: `script-src 'self' 'nonce-${nonce}'`,
		// The two hashes are the <style> elements React Aria inserts from script; see
		// docs/security.md. test/node/react-aria-styles.test.ts derives them from the library.
		"style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='",
		"img-src 'self' data:",
		"font-src 'self'",
		"connect-src 'self'",
		...(turnstile ? ["frame-src https://challenges.cloudflare.com"] : []),
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
	expect(permissions.filter((directive) => !directive.endsWith("=()"))).toEqual([]);
	for (const feature of [
		"camera",
		"microphone",
		"geolocation",
		"payment",
		"usb",
		"publickey-credentials-create",
		"publickey-credentials-get",
	]) {
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
		const response = await worker.fetch("https://www.timesifier.example/reports?week=46", {
			redirect: "manual",
		});
		expect(response.status).toBe(308);
		expect(response.headers.get("Location")).toBe(`${ORIGIN}/reports?week=46`);
		expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=63072000");
	});

	it("answers 404 on the workers.dev address Cloudflare gives each production version", async () => {
		const response = await worker.fetch("https://41b1b1d9-timesifier.acme.workers.dev/");
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("Timesifier");
	});
});

describe("the Turnstile addition to the policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("/sign-in, which shows the widget, may load Turnstile's script and frame", async () => {
		const response = await worker.fetch(`${ORIGIN}/sign-in`);
		expect(response.status).toBe(200);
		await expectBrowserPolicy(response, { turnstile: true });
	});

	it("is on no page under /app, nor on an invitation's page", async () => {
		await freshDatabase();
		const mailbox = captureEmail();
		const { cookie } = await signIn(mailbox, "ada@example.com");
		// With two organisations, /app itself is a page: the chooser.
		const acme = await createOrganisation(cookie, "Acme");
		await createOrganisation(cookie, "Globex");
		const { id } = await invite(cookie, acme.id, "bob@example.com");
		const bob = await signIn(mailbox, "bob@example.com", { client: "203.0.113.8" });

		const invitation = await worker.fetch(`${ORIGIN}/invitations/${id}`, {
			headers: { Cookie: bob.cookie },
		});
		expect(invitation.status).toBe(200);
		await expectBrowserPolicy(invitation);

		for (const path of [
			"/app",
			"/app/new",
			"/app/acme",
			"/app/acme/reports",
			"/app/acme/projects",
			"/app/acme/settings",
			"/app/acme/settings/members",
		]) {
			const response = await worker.fetch(`${ORIGIN}${path}`, { headers: { Cookie: cookie } });
			expect(response.status, path).toBe(200);
			await expectBrowserPolicy(response);
		}
	});

	it("cannot be asked for by a request", async () => {
		const response = await worker.fetch(`${ORIGIN}/`, {
			headers: { [POLICY_ADDITION_HEADER]: "turnstile" },
		});
		await expectBrowserPolicy(response);
	});

	it("is not on the redirect that sends a stranger to a page that has it", async () => {
		const response = await worker.fetch(`${ORIGIN}/app`, { redirect: "manual" });
		expect(response.status).toBe(302);
		expect(response.headers.has(POLICY_ADDITION_HEADER)).toBe(false);
		expect(response.headers.get("Content-Security-Policy")).toBe(
			"default-src 'none'; frame-ancestors 'none'",
		);
	});

	it("is given to an HTML response that names it, and the name is removed", () => {
		const page = new Response("<!doctype html>", {
			headers: { "Content-Type": "text/html", [POLICY_ADDITION_HEADER]: "turnstile" },
		});
		const { headers } = withSecurityHeaders(page, "bm9uY2U=");

		expect(headers.has(POLICY_ADDITION_HEADER)).toBe(false);
		const policy = headers.get("Content-Security-Policy") ?? "";
		expect(policy).toContain(
			"script-src 'self' 'nonce-bm9uY2U=' https://challenges.cloudflare.com;",
		);
		expect(policy).toContain("; frame-src https://challenges.cloudflare.com;");
	});

	it.each(["Turnstile", "turnstile, anything", "https://attacker.example", ""])(
		"gives nothing to a response that names %j",
		(name) => {
			const page = new Response("<!doctype html>", {
				headers: { "Content-Type": "text/html", [POLICY_ADDITION_HEADER]: name },
			});
			const { headers } = withSecurityHeaders(page, "bm9uY2U=");

			expect(headers.has(POLICY_ADDITION_HEADER)).toBe(false);
			const policy = headers.get("Content-Security-Policy") ?? "";
			expect(policy).toContain("script-src 'self' 'nonce-bm9uY2U=';");
			expect(policy).not.toContain("frame-src");
			expect(policy).not.toContain("attacker");
		},
	);

	it("gives nothing to a response that is not HTML, and still removes the name", () => {
		const data = new Response("{}", {
			headers: { "Content-Type": "application/json", [POLICY_ADDITION_HEADER]: "turnstile" },
		});
		const { headers } = withSecurityHeaders(data, "bm9uY2U=");

		expect(headers.has(POLICY_ADDITION_HEADER)).toBe(false);
		expect(headers.get("Content-Security-Policy")).toBe(
			"default-src 'none'; frame-ancestors 'none'",
		);
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
