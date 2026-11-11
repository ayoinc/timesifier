import { index, type RouteConfig, route } from "@react-router/dev/routes";

import { APP_PATH, destinations } from "./shell/destinations";

// This file runs in Node when the routes are built, but is type-checked with the
// Worker's settings, which have no Node globals.
declare const process: { env: Record<string, string | undefined> };

// The component gallery is a development tool. It is registered when the dev
// server runs, and in a build made with DESIGN_ROUTE=1 (what `pnpm test:e2e`
// builds). A normal `pnpm build` leaves it out, so production answers 404 and
// ships none of its code.
const designRoute = import.meta.env.MODE === "development" || process.env.DESIGN_ROUTE === "1";

// The shell and its destinations, in the order of the one list that names them.
const shell = route(
	APP_PATH,
	"routes/app/layout.tsx",
	destinations.map(({ id, segment }) => {
		const file = `routes/app/${id}.tsx`;
		return segment ? route(segment, file) : index(file);
	}),
);

// The two pages a person uses without a session. Their addresses are also in
// routes/auth/paths.ts, which the guard and the pages read.
export default [
	index("routes/home.tsx"),
	route("sign-in", "routes/sign-in.tsx"),
	route("sign-up", "routes/sign-up.tsx"),
	shell,
	route("api/auth/*", "routes/api.auth.$.ts"),
	...(designRoute ? [route("design", "routes/design.tsx")] : []),
] satisfies RouteConfig;
