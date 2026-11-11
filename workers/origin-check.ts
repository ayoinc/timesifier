const STATE_CHANGING_METHODS: Record<string, true> = {
	POST: true,
	PUT: true,
	PATCH: true,
	DELETE: true,
};

/**
 * Cross-site request forgery check, run before the framework sees the request.
 *
 * A browser attaches `Origin` to every state-changing request and to every
 * WebSocket handshake, and `Sec-Fetch-Site` to every request it makes; a page
 * cannot forge either. A request carrying neither does not come from a browser,
 * so it cannot ride on a person's session.
 *
 * A WebSocket handshake is a GET, but the connection it opens can change state
 * and the same-origin policy does not apply to it, so it is checked like a POST.
 *
 * Returns the 403 response for a request to refuse, or `null` to let it through.
 */
export function rejectCrossOrigin(request: Request): Response | null {
	const opensWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
	if (!STATE_CHANGING_METHODS[request.method.toUpperCase()] && !opensWebSocket) return null;

	const origin = request.headers.get("Origin");
	const site = request.headers.get("Sec-Fetch-Site");
	const foreignOrigin = origin !== null && origin !== new URL(request.url).origin;
	const foreignSite = site !== null && site !== "same-origin" && site !== "none";

	return foreignOrigin || foreignSite ? new Response("Forbidden", { status: 403 }) : null;
}
