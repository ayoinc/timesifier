// The policy as shipped is described in docs/security.md, "Browser policy".

// Two years. No `includeSubDomains` and no `preload`: other subdomains of
// timesifier.com belong to other services.
const STRICT_TRANSPORT_SECURITY = "max-age=63072000";

// Every policy-controlled feature is denied except passkeys (TS-008).
const DENIED_FEATURES = [
	"accelerometer",
	"autoplay",
	"bluetooth",
	"browsing-topics",
	"camera",
	"clipboard-read",
	"clipboard-write",
	"compute-pressure",
	"display-capture",
	"encrypted-media",
	"fullscreen",
	"gamepad",
	"geolocation",
	"gyroscope",
	"hid",
	"identity-credentials-get",
	"idle-detection",
	"local-fonts",
	"magnetometer",
	"microphone",
	"midi",
	"otp-credentials",
	"payment",
	"picture-in-picture",
	"screen-wake-lock",
	"serial",
	"storage-access",
	"usb",
	"window-management",
	"xr-spatial-tracking",
];

const PERMISSIONS_POLICY = [
	...DENIED_FEATURES.map((feature) => `${feature}=()`),
	"publickey-credentials-get=(self)",
	"publickey-credentials-create=(self)",
].join(", ");

/**
 * The `<style>` elements React Aria inserts from script, each allowed by the
 * SHA-256 hash of its exact text and by nothing else. They are listed in
 * docs/security.md; test/node/react-aria-styles.test.ts derives them from the
 * installed library and fails when this list and the library disagree.
 */
export const REACT_ARIA_STYLE_HASHES = [
	// usePress: `touch-action` on pressable elements, so a tap is not delayed.
	"sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=",
	// usePreventScroll, iOS only: `overscroll-behavior: contain` while an overlay is open.
	"sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg=",
];

/**
 * How a route asks for an addition to the policy of its own page: its `headers`
 * export sets this response header to the addition's name. The Worker reads it
 * here and removes it, so it never reaches a browser. Every page that does not
 * ask keeps the policy without the addition. docs/security.md lists what each
 * addition allows and which routes ask for it.
 */
export const POLICY_ADDITION_HEADER = "Timesifier-Policy-Addition";

/** For a page that shows the Turnstile widget: Cloudflare's script, and the frame it runs in. */
export const TURNSTILE_ADDITION = "turnstile";
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

function contentSecurityPolicy(nonce: string, addition: string | null): string {
	const hashes = REACT_ARIA_STYLE_HASHES.map((hash) => `'${hash}'`).join(" ");
	// The one relaxation, and only under the dev server: Vite injects stylesheets
	// as <style> elements so it can hot-reload them. Its WebSocket is same-origin,
	// which `connect-src 'self'` already allows. A browser ignores `'unsafe-inline'`
	// when the directive also carries a hash, so the hashes are left out there.
	const styleSrc = import.meta.env.DEV ? "'self' 'unsafe-inline'" : `'self' ${hashes}`;
	const turnstile = addition === TURNSTILE_ADDITION;

	return [
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}'${turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}`,
		`style-src ${styleSrc}`,
		"img-src 'self' data:",
		"font-src 'self'",
		"connect-src 'self'",
		// Without this directive a frame falls back to `default-src 'self'`.
		...(turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"object-src 'none'",
	].join("; ");
}

// For a response that is not a page: nothing may load from it or frame it, so a
// file opened on its own (an SVG, a JSON document) cannot run script.
const NOTHING_LOADS = "default-src 'none'; frame-ancestors 'none'";

/**
 * Returns the response with the browser policy attached: every response gets
 * HSTS and `nosniff`; an HTML response gets the Content Security Policy for
 * this request's nonce, with the addition its route asked for, and the framing,
 * referrer and permissions headers; any other response gets a policy under
 * which nothing loads.
 */
export function withSecurityHeaders(response: Response, nonce: string): Response {
	// A response the framework returns can have immutable headers.
	const secured = new Response(response.body, response);
	const { headers } = secured;

	const addition = headers.get(POLICY_ADDITION_HEADER);
	headers.delete(POLICY_ADDITION_HEADER);

	headers.set("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
	headers.set("X-Content-Type-Options", "nosniff");

	if (headers.get("Content-Type")?.toLowerCase().startsWith("text/html")) {
		headers.set("Content-Security-Policy", contentSecurityPolicy(nonce, addition));
		headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
		headers.set("X-Frame-Options", "DENY");
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
		headers.set("Permissions-Policy", PERMISSIONS_POLICY);
	} else {
		headers.set("Content-Security-Policy", NOTHING_LOADS);
	}

	return secured;
}
