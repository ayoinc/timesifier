import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";

import { nonceContext } from "../workers/nonce";

// React Router's default server entry for web-standard runtimes, plus the CSP
// nonce. The Worker creates the nonce and sends the policy header; here it is
// given to the two places that emit inline scripts: `ServerRouter` (which hands
// it to `Scripts`, `ScrollRestoration` and the streamed data scripts) and React.

export const streamTimeout = 5_000;

export default async function handleRequest(
	request: Request,
	responseStatusCode: number,
	responseHeaders: Headers,
	routerContext: EntryContext,
	loadContext: RouterContextProvider,
) {
	// https://httpwg.org/specs/rfc9110.html#HEAD
	if (request.method.toUpperCase() === "HEAD") {
		return new Response(null, {
			status: responseStatusCode,
			headers: responseHeaders,
		});
	}

	const nonce = loadContext.get(nonceContext);
	let shellRendered = false;
	const userAgent = request.headers.get("user-agent");

	const body = await renderToReadableStream(
		<ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
		{
			nonce,
			signal: AbortSignal.timeout(streamTimeout + 1000),
			onError(error: unknown) {
				responseStatusCode = 500;
				// Log streaming rendering errors from inside the shell. Don't log
				// errors encountered during initial shell rendering since they'll
				// reject and get logged in handleDocumentRequest.
				if (shellRendered) {
					console.error(error);
				}
			},
		},
	);
	shellRendered = true;

	// Bots and SPA Mode renders wait for all content to load before responding.
	if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
		await body.allReady;
	}

	responseHeaders.set("Content-Type", "text/html");
	return new Response(body, {
		headers: responseHeaders,
		status: responseStatusCode,
	});
}
