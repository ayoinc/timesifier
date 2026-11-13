/**
 * Every table of `schema.ts`, under the row of the privacy notice that says
 * what it holds (`app/routes/privacy.tsx`, "What is stored"). The notice draws
 * its headings and its rows' names from this list, and `test/claims.test.ts`
 * fails when a table of the schema is in no row, or a row names a table the
 * schema does not have. A new table therefore goes here, and its words into
 * the notice, in the pull request that adds it.
 *
 * A table is listed even when it holds nobody's personal data, such as an
 * organisation's tax rates, so that what is left out is left out on purpose.
 */
export const STORED = [
	{
		heading: "Your account",
		rows: [
			{ term: "Your account", tables: ["users", "accounts"] },
			{ term: "Your sessions", tables: ["sessions"] },
			{ term: "Sign-in codes", tables: ["verifications"] },
			{ term: "Limits on requests", tables: ["rate_limits"] },
		],
	},
	{
		heading: "Your organisation's work",
		rows: [
			{
				term: "The organisation and its people",
				tables: ["organisations", "memberships", "invitations", "teams", "team_members"],
			},
			{
				term: "Time and approvals",
				tables: ["time_entries", "entry_tags", "periods", "period_events", "work_requests"],
			},
			{
				term: "Leave",
				tables: ["leave_requests", "leave_kinds", "public_holidays", "working_days"],
			},
			{
				term: "Work schedules",
				tables: [
					"work_schedules",
					"work_schedule_versions",
					"work_schedule_days",
					"schedule_assignments",
				],
			},
			{
				term: "Projects, tasks and budgets",
				tables: [
					"projects",
					"project_tasks",
					"project_tags",
					"tasks",
					"tags",
					"budget_lines",
					"budget_alerts",
				],
			},
			{ term: "Clients and their contacts", tables: ["clients", "client_contacts"] },
			{
				term: "Rates, invoices and estimates",
				tables: [
					"rates",
					"taxes",
					"invoice_settings",
					"invoices",
					"invoice_lines",
					"invoice_line_sources",
					"payments",
					"estimates",
					"estimate_lines",
					"recurring_invoices",
					"recurring_invoice_lines",
					"retainers",
					"retainer_movements",
				],
			},
			{
				term: "Expenses and receipts",
				tables: ["expenses", "expense_tags", "expense_categories", "expense_category_prices"],
			},
			{ term: "Saved reports", tables: ["saved_reports", "saved_report_shares"] },
		],
	},
	{
		heading: "Integrations",
		rows: [
			{ term: "API tokens", tables: ["api_tokens"] },
			{ term: "Webhooks", tables: ["webhooks", "webhook_deliveries"] },
			{ term: "Imports", tables: ["import_jobs"] },
			{ term: "Calendar feeds", tables: ["calendar_feeds"] },
		],
	},
	{
		heading: "The activity log",
		rows: [{ term: "The activity log", tables: ["activity_records"] }],
	},
] as const;

/** The name of a row of "What is stored". */
export type StoredTerm = (typeof STORED)[number]["rows"][number]["term"];
