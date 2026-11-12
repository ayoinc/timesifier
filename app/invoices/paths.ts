import { destination, destinationPath } from "../shell/destinations";

// Invoices and Estimates (TS-073 to TS-078, TS-088). Every page below a
// destination continues its address, so the organisation layout's destination
// check covers it: owners, admins and Finance are shown them. The route
// configuration (app/routes.ts) reads this in Node, so it imports by relative
// path, as that file does. It builds the routes from the segments; the pages
// build their links from the functions.

const INVOICES = destination("invoices").segment;
const ESTIMATES = destination("estimates").segment;

/** The route parameter that holds an invoice's id. */
export const INVOICE_PARAM = "invoice";
/** The route parameter that holds an estimate's id. */
export const ESTIMATE_PARAM = "estimate";
/** The route parameter that holds a recurring invoice's id. */
export const RECURRING_PARAM = "recurring";

/** What follows the organisation in each address, for `app/routes.ts`. */
export const BILLING_SEGMENTS = {
	newInvoice: `${INVOICES}/new`,
	uninvoiced: `${INVOICES}/uninvoiced`,
	reports: `${INVOICES}/reports`,
	reportsExport: `${INVOICES}/reports/export`,
	xero: `${INVOICES}/xero`,
	recurring: `${INVOICES}/recurring`,
	recurringOne: `${INVOICES}/recurring/:${RECURRING_PARAM}`,
	retainers: `${INVOICES}/retainers`,
	settings: `${INVOICES}/settings`,
	invoice: `${INVOICES}/:${INVOICE_PARAM}`,
	invoicePdf: `${INVOICES}/:${INVOICE_PARAM}/pdf`,
	estimate: `${ESTIMATES}/:${ESTIMATE_PARAM}`,
	estimatePdf: `${ESTIMATES}/:${ESTIMATE_PARAM}/pdf`,
} as const;

const invoices = (slug: string) => destinationPath(slug, "invoices");
const estimates = (slug: string) => destinationPath(slug, "estimates");

export const invoicesPath = invoices;
export const newInvoicePath = (slug: string) => `${invoices(slug)}/new`;
export const uninvoicedPath = (slug: string) => `${invoices(slug)}/uninvoiced`;
export const recurringListPath = (slug: string) => `${invoices(slug)}/recurring`;
export const recurringPath = (slug: string, id: string) => `${invoices(slug)}/recurring/${id}`;
export const retainersPath = (slug: string) => `${invoices(slug)}/retainers`;
export const invoiceSettingsPath = (slug: string) => `${invoices(slug)}/settings`;
export const xeroExportPath = (slug: string) => `${invoices(slug)}/xero`;
export const invoicePath = (slug: string, id: string) => `${invoices(slug)}/${id}`;
export const invoicePdfPath = (slug: string, id: string) => `${invoices(slug)}/${id}/pdf`;

/** The billing reports: what was invoiced, what was paid, and what is owed by age. */
export type BillingReport = "receivables" | "invoiced" | "payments";
export const billingReportPath = (slug: string, report: BillingReport = "receivables") =>
	`${invoices(slug)}/reports?report=${report}`;
/** What is owed now, by how long it is overdue: the figure a dashboard links to. */
export const receivablesPath = (slug: string) => billingReportPath(slug, "receivables");
export const billingReportExportPath = (slug: string, search: string) =>
	`${invoices(slug)}/reports/export${search}`;

export const estimatesPath = estimates;
export const estimatePath = (slug: string, id: string) => `${estimates(slug)}/${id}`;
export const estimatePdfPath = (slug: string, id: string) => `${estimates(slug)}/${id}/pdf`;

/** Where a client reads an estimate and accepts or declines it, without signing in. */
export const ESTIMATE_LINK_SEGMENT = "estimate";
export const estimateLinkPath = (id: string, token: string) =>
	`/${ESTIMATE_LINK_SEGMENT}/${id}/${token}`;
