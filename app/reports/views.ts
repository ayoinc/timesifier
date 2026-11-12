import { destination, destinationPath } from "../shell/destinations";

// The views of Reports, each a page below it (TS-068, TS-070, TS-071, TS-079,
// TS-080, TS-084): Time, the report of TS-014a, at Reports itself;
// Utilisation, Profitability, Leave, Expenses and Contractors beside it; and
// the reports people have saved. Each is a page of its own, so a view is a
// link and its query travels in the address, and the tabs are the one way in
// to each (TS-092). The route configuration (app/routes.ts) reads this file in
// Node, so it imports by relative path, as that file does.

export const REPORT_VIEWS = [
	{ id: "time", label: "Time", segment: "", file: "" },
	{
		id: "utilisation",
		label: "Utilisation",
		segment: "utilisation",
		file: "routes/app/reports.utilisation.tsx",
	},
	{
		id: "profitability",
		label: "Profitability",
		segment: "profitability",
		file: "routes/app/reports.profitability.tsx",
	},
	{ id: "leave", label: "Leave", segment: "leave", file: "routes/app/reports.leave.tsx" },
	{
		id: "expenses",
		label: "Expenses",
		segment: "expenses",
		file: "routes/app/reports.expenses.tsx",
	},
	{
		id: "contractors",
		label: "Contractors",
		segment: "contractors",
		file: "routes/app/contractors.tsx",
	},
	{ id: "saved", label: "Saved", segment: "saved", file: "routes/app/reports.saved.tsx" },
] as const;

export type ReportView = (typeof REPORT_VIEWS)[number]["id"];

/**
 * The views that show money, and so only to those who see rates
 * (`maySeeRates`): owners, admins and Finance. Their routes answer anybody
 * else the organisation's 404.
 */
export const MONEY_VIEWS: readonly ReportView[] = ["profitability", "contractors"];

const reports = destination("reports").segment;

/** What follows the organisation in the address of each view below Reports, with its route file. */
export const REPORT_VIEW_ROUTES = REPORT_VIEWS.flatMap(({ segment, file }) =>
	segment ? [{ path: `${reports}/${segment}`, file }] : [],
);

/** What follows the organisation in the address of the Leave view's export. */
export const LEAVE_EXPORT_SEGMENT = `${reports}/leave/export`;

/** The address of `view`, with `search` (from its "?") when given. */
export function reportViewPath(slug: string, view: ReportView, search = ""): string {
	const { segment } = REPORT_VIEWS.find((each) => each.id === view) ?? REPORT_VIEWS[0];
	const base = destinationPath(slug, "reports");
	return `${segment ? `${base}/${segment}` : base}${search}`;
}

/** The address of the Leave view's export, with its query. */
export function leaveExportPath(slug: string, search: string): string {
	return `${destinationPath(slug, "reports")}/leave/export${search}`;
}
