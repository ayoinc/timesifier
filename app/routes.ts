import { index, type RouteConfig, route } from "@react-router/dev/routes";

// This file runs in Node when the routes are built, but is type-checked with the
// Worker's settings, which have no Node globals.
declare const process: { env: Record<string, string | undefined> };

// The component gallery is a development tool. It is registered when the dev
// server runs, and in a build made with DESIGN_ROUTE=1 (what `pnpm test:e2e`
// builds). A normal `pnpm build` leaves it out, so production answers 404 and
// ships none of its code.
const designRoute = import.meta.env.MODE === "development" || process.env.DESIGN_ROUTE === "1";

export default [
	index("routes/home.tsx"),
	route("api/auth/*", "routes/api.auth.$.ts"),
	...(designRoute ? [route("design", "routes/design.tsx")] : []),
] satisfies RouteConfig;
