const APEX = "timesifier.com";
const ALIAS = `www.${APEX}`;

/**
 * The application has one address. A request for the `www` alias is sent to
 * the same path on the apex; every other host (apex, preview, local) passes.
 */
export function canonicalRedirect(request: Request): Response | null {
	const url = new URL(request.url);
	if (url.hostname !== ALIAS) return null;
	url.hostname = APEX;
	// 308 keeps the method and body, so a form posted to the alias still arrives.
	return Response.redirect(url.toString(), 308);
}
