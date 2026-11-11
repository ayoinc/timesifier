import { createRequestHandler, RouterContextProvider } from "react-router";

import { canonicalHost } from "./canonical-host";
import { createNonce, nonceContext } from "./nonce";
import { rejectCrossOrigin } from "./origin-check";
import { withSecurityHeaders } from "./security-headers";

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function handleWithFramework(request: Request, nonce: string): Promise<Response> {
	const context = new RouterContextProvider();
	context.set(nonceContext, nonce);
	return requestHandler(request, context);
}

export default {
	// Keep this a short sequence of named steps; each step is one line.
	async fetch(request, env) {
		const nonce = createNonce();
		const response =
			canonicalHost(request, env) ??
			rejectCrossOrigin(request) ??
			(await handleWithFramework(request, nonce));
		return withSecurityHeaders(response, nonce);
	},
} satisfies ExportedHandler<Env>;
