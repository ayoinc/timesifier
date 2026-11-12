import type { SubjectType } from "./actions";

// What the Activity log page and its server share (TS-072): the page's words
// and limits, with nothing that reads the database, so the page's own code may
// import them. The query is `log.server.ts`.

/** How many records a page lists; the export holds them all. */
export const PAGE_RECORDS = 200;

/** The system, in the "performed by" filter. */
export const SYSTEM = "system";

/** The kinds of thing, as the "Kind" filter lists them. */
export const KIND_LABELS: Record<SubjectType, string> = {
	time_entry: "Time entries",
	period: "Weeks",
	project: "Projects",
	client: "Clients",
	membership: "Members",
	invitation: "Invitations",
	team: "Teams",
	task: "Tasks",
	tag: "Tags",
	rate: "Rates",
	budget: "Budgets",
	expense: "Expenses",
	expense_category: "Expense categories",
	retainer: "Retainers",
	recurring_invoice: "Recurring invoices",
	invoice: "Invoices",
	estimate: "Estimates",
	payment: "Payments",
	leave: "Leave",
	organisation: "Lock date and deadline",
	api_token: "API tokens",
	webhook: "Webhooks",
	import: "Imports",
};
