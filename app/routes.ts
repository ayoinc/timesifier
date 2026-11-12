import { index, type RouteConfig, route } from "@react-router/dev/routes";
import {
	EXPENSE_REPORT_EXPORT_SEGMENT,
	EXPENSE_REPORT_SEGMENT,
	RECEIPT_SEGMENT,
} from "./expenses/paths";
	API_PATH,
	CALENDAR_FEEDS_SEGMENT,
	EXPORT_SEGMENT,
	FEED_PATH,
	IMPORT_SEGMENT,
} from "./integrations/paths";
import { REPORT_EXPORT_SEGMENT } from "./reports/paths";
import {
	ACCOUNT_SEGMENT,
	APP_PATH,
	destinations,
	INVITATIONS_SEGMENT,
	MEMBERS_SEGMENT,
	MOVED,
	NEW_ORGANISATION_SEGMENT,
	ORGANISATION_PARAM,
} from "./shell/destinations";

// This file runs in Node when the routes are built, but is type-checked with the
// Worker's settings, which have no Node globals.
declare const process: { env: Record<string, string | undefined> };

// The component gallery is a development tool. It is registered when the dev
// server runs, and in a build made with DESIGN_ROUTE=1 (what `pnpm test:e2e`
// builds). A normal `pnpm build` leaves it out, so production answers 404 and
// ships none of its code.
const designRoute = import.meta.env.MODE === "development" || process.env.DESIGN_ROUTE === "1";

// One organisation's pages: its destinations, in the order of the one list that
// names them, the pages below a destination, My account, the addresses that
// have moved, and a 404 for every other address. The layout in front of them
// answers 404 to a person who is not a member, and to a member at a destination
// their role is not shown (docs/security.md, "Organisations and roles"), so a
// route added here is covered by being here.
const organisation = route(`:${ORGANISATION_PARAM}`, "routes/app/organisation.tsx", [
	...destinations.map(({ id, segment }) => {
		const file = `routes/app/${id}.tsx`;
		return segment ? route(segment, file) : index(file);
	}),
	route(MEMBERS_SEGMENT, "routes/app/members.tsx"),
	route(INVITATIONS_SEGMENT, "routes/app/invitations.tsx"),
	route(REPORT_EXPORT_SEGMENT, "routes/app/reports.export.ts"),
	route(IMPORT_SEGMENT, "routes/app/integrations.import.tsx"),
	route(EXPORT_SEGMENT, "routes/app/integrations.export.ts"),
	route(EXPENSE_REPORT_SEGMENT, "routes/app/reports.expenses.tsx"),
	route(EXPENSE_REPORT_EXPORT_SEGMENT, "routes/app/reports.expenses.export.ts"),
	route(RECEIPT_SEGMENT, "routes/app/expenses.receipt.ts"),
	route(ACCOUNT_SEGMENT, "routes/app/account.tsx"),
	route(CALENDAR_FEEDS_SEGMENT, "routes/app/calendar-feeds.tsx"),
	...Object.keys(MOVED).map((segment) =>
		route(segment, "routes/app/moved.tsx", { id: `routes/app/moved/${segment}` }),
	),
	// Any other address under the organisation: a 404 drawn inside the shell.
	route("*", "routes/app/not-found.tsx"),
]);

// Everything that needs a session. The layout holds the guard and the shell.
// `/app` itself sends a person to their organisation, and `new` creates one.
const app = route(APP_PATH, "routes/app/layout.tsx", [
	index("routes/app/index.tsx"),
	route(NEW_ORGANISATION_SEGMENT, "routes/app/new.tsx"),
	organisation,
]);

// The privacy notice and the terms have their addresses in landing/Site.tsx.
// The one page a person uses without a session has its address in
// routes/auth/paths.ts as well, which the guard and the pages read. An
// invitation's page is outside `/app`: the person it is for is not a member yet.
export default [
	index("routes/home.tsx"),
	route("sign-in", "routes/sign-in.tsx"),
	route("privacy", "routes/privacy.tsx"),
	route("terms", "routes/terms.tsx"),
	app,
	route("invitations/:id", "routes/invitations.$id.tsx"),
	route("api/auth/*", "routes/api.auth.$.ts"),
	// The public API (TS-081) and calendar feeds (TS-089): a token, not a
	// session, says whose they are, so they sit outside `/app`.
	route(`${API_PATH.slice(1)}/*`, "routes/api.v1.$.ts"),
	route(`${FEED_PATH.slice(1)}/:token`, "routes/calendar.$token.ts"),
	...(designRoute ? [route("design", "routes/design.tsx")] : []),
] satisfies RouteConfig;
