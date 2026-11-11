import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";

import { nonceContext } from "../workers/nonce";
import { readColorScheme } from "./shell/color-scheme.server";
import { RequestColorScheme } from "./shell/request-scheme";

// React Router's default server entry for web-standard runtimes, plus the CSP
// nonce. The Worker creates the nonce and sends the policy header; here it is
// given to the two places that emit inline scripts: `ServerRouter` (which hands
// it to `Scripts`, `ScrollRestoration` and the streamed data scripts) and React.
// It also provides the colour scheme the request's cookie chose, which an error
// page drawn before any loader ran has no other way to know.

export const streamTimeout = 5_000;

/**
 * What the log says about an error React Router caught on the server, in a
 * loader, an action, a middleware or while rendering: the error's name and the
 * path that was asked for, and nothing else.
 *
 * Not the message: Drizzle's, for a statement the database refused, is the
 * statement with its parameters, which may be an address, a token or anything
 * else a row holds. Not the query string. And not the values in the path
 * either: each parameter is written as its name, so `/invitations/<id>` is
 * logged as `/invitations/:id` (docs/security.md, "Never logged").
 *
 * A request the browser gave up on is aborted, and React Router reports that
 * here too; it is not an error and is not logged.
 * https://reactrouter.com/how-to/error-reporting
 */
export function handleError(
	error: unknown,
	{ request, params }: { request: Request; params: Record<string, string | undefined> },
): void {
	if (request.signal.aborted) return;
	const path = Object.entries(params).reduce(
		(path, [name, value]) => (value ? path.replaceAll(value, `:${name}`) : path),
		new URL(request.url).pathname,
	);
	console.error(`error: ${error instanceof Error ? error.name : "error"} at ${path}`);
}

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
		// The colour scheme from the cookie, for a page drawn without the root
		// loader's answer (app/shell/request-scheme.ts).
		<RequestColorScheme value={readColorScheme(request.headers.get("Cookie"))}>
			<ServerRouter context={routerContext} url={request.url} nonce={nonce} />
		</RequestColorScheme>,
		{
			nonce,
			signal: AbortSignal.timeout(streamTimeout + 1000),
			onError(error: unknown) {
				responseStatusCode = 500;
				// Log streaming rendering errors from inside the shell. Don't log
				// errors encountered during initial shell rendering since they'll
				// reject and get logged in handleDocumentRequest.
				if (shellRendered) {
					const params = routerContext.staticHandlerContext.matches.at(-1)?.params ?? {};
					handleError(error, { request, params });
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
