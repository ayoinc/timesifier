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
			{ term: "Your account", tables: ["users", "accounts", "notification_choices"] },
			{ term: "Your sessions", tables: ["sessions"] },
			{ term: "Your sign-ins", tables: ["sign_ins"] },
			{ term: "Mail from Timesifier", tables: ["mailings", "mailing_deliveries"] },
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
				tables: [
					"time_entries",
					"entry_tags",
					"periods",
					"period_events",
					"work_requests",
					"timesheet_rule_versions",
				],
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
			{
				term: "Clients and their contacts",
				tables: ["clients", "client_contacts", "client_managers"],
			},
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
			{ term: "Pinned projects and people", tables: ["pins"] },
			{ term: "Support access", tables: ["support_grants"] },
			{ term: "Exports of everything", tables: ["organisation_exports"] },
			{ term: "Verified domains", tables: ["organisation_domains", "membership_removals"] },
			{ term: "Notifications", tables: ["notifications", "reminder_pass"] },
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
	{
		heading: "Timesifier itself",
		rows: [
			{ term: "Timesifier's brand", tables: ["platform_brand"] },
			{ term: "The platform console", tables: ["platform_events", "platform_step_ups"] },
		],
	},
] as const;

/** The name of a row of "What is stored". */
export type StoredTerm = (typeof STORED)[number]["rows"][number]["term"];

/** The heading of a part of "What is stored". */
export type StoredHeading = (typeof STORED)[number]["heading"];

/**
 * The parts of "What is stored" that belong to an organisation, which is their
 * controller: Timesifier processes them for it, under the data processing
 * agreement (`/dpa`, TS-105). The company is the controller of the rest: a
 * person's account, sign-ins and mail, and Timesifier's own records.
 */
export const PROCESSED_FOR_ORGANISATIONS = [
	"Your organisation's work",
	"Integrations",
	"The activity log",
] as const satisfies readonly StoredHeading[];
