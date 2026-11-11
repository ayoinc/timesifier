import { createRequestHandler } from "react-router";
import { canonicalRedirect } from "./canonical-host";

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

export default {
	async fetch(request) {
		return canonicalRedirect(request) ?? requestHandler(request);
	},
} satisfies ExportedHandler<Env>;
