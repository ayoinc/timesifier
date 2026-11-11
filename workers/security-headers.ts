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

function contentSecurityPolicy(nonce: string): string {
	// The one relaxation, and only under the dev server: Vite injects stylesheets
	// as <style> elements so it can hot-reload them. Its WebSocket is same-origin,
	// which `connect-src 'self'` already allows.
	const styleSrc = import.meta.env.DEV ? "'self' 'unsafe-inline'" : "'self'";

	return [
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}'`,
		`style-src ${styleSrc}`,
		"img-src 'self' data:",
		"font-src 'self'",
		"connect-src 'self'",
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
 * this request's nonce and the framing, referrer and permissions headers; any
 * other response gets a policy under which nothing loads.
 */
export function withSecurityHeaders(response: Response, nonce: string): Response {
	// A response the framework returns can have immutable headers.
	const secured = new Response(response.body, response);
	const { headers } = secured;

	headers.set("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
	headers.set("X-Content-Type-Options", "nosniff");

	if (headers.get("Content-Type")?.toLowerCase().startsWith("text/html")) {
		headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
		headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
		headers.set("X-Frame-Options", "DENY");
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
		headers.set("Permissions-Policy", PERMISSIONS_POLICY);
	} else {
		headers.set("Content-Security-Policy", NOTHING_LOADS);
	}

	return secured;
}
