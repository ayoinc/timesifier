import { createRequestHandler, RouterContextProvider } from "react-router";

import { dispatchWebhooks } from "~/integrations/webhooks.server";

import { canonicalHost } from "./canonical-host";
import { formerSignUp } from "./former-sign-up";
import { keepNoCopy } from "./no-copy";
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
			formerSignUp(request) ??
			(await handleWithFramework(request, nonce));
		return withSecurityHeaders(keepNoCopy(request, response), nonce);
	},
	// The cron trigger in wrangler.jsonc: the webhooks' deliveries that are due.
	async scheduled(controller, _env, context) {
		context.waitUntil(dispatchWebhooks({ now: controller.scheduledTime }));
	},
} satisfies ExportedHandler<Env>;
