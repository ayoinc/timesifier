import type { BillingType } from "~/billing/billable";
import type { BudgetKind } from "~/budgets/budget";
import type { RateMode } from "~/rates/price";

/**
 * How a project's money settings are put into words (TS-067, TS-069). Nothing
 * here runs only on the server: the pages import it freely.
 */

export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
	hourly: "Time and materials",
	fixed_fee: "Fixed fee",
	non_billable: "Non-billable",
};

export const BILLING_TYPE_MEANINGS: Record<BillingType, string> = {
	hourly: "Bill by the hour, at the project's rates.",
	fixed_fee:
		"Bill one fee. The time is still priced, to show what it would have billed by the hour.",
	non_billable: "Bill nothing. Every task on it is non-billable.",
};

/** The rate modes, in the order a field offers them. */
export const RATE_MODES = ["project", "person", "task"] as const satisfies readonly RateMode[];

export const RATE_MODE_LABELS: Record<RateMode, string> = {
	project: "One rate for the project",
	person: "Each person's rate",
	task: "Each task's rate",
};

export const BUDGET_KIND_LABELS: Record<BudgetKind, string> = {
	none: "No budget",
	total_hours: "Total hours",
	task_hours: "Hours per task",
	person_hours: "Hours per person",
	total_fees: "Total fees",
	task_fees: "Fees per task",
};

/** The budget kinds in money, which only those who see rates are offered and shown. */
export const FEES_BUDGETS: readonly BudgetKind[] = ["total_fees", "task_fees"];

/**
 * The currencies offered, by code: the common ones. Any ISO 4217 code is
 * accepted by the server; these are what the fields list.
 */
export const CURRENCIES = [
	"AUD",
	"CAD",
	"CHF",
	"EUR",
	"GBP",
	"GHS",
	"INR",
	"JPY",
	"KES",
	"NGN",
	"NZD",
	"SEK",
	"USD",
	"ZAR",
] as const;

/** The value of a currency field that means "the one it would otherwise take". No currency's code is this word. */
export const INHERITED = "inherit";
