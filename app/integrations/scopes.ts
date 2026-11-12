import * as z from "zod";

/**
 * What an API token may do (TS-081) and what a webhook hears about (TS-087).
 * A token acts as the person who made it, with their role as it is on each
 * request, so it never reaches more than that person could on the pages; its
 * scopes narrow that further. Both lists are shown on Integrations, in this
 * order, with these words.
 */

export const API_SCOPES = [
	"time:read",
	"time:write",
	"descriptions:read",
	"projects:read",
	"people:read",
	"expenses:read",
	"invoices:read",
] as const;

export const ApiScope = z.enum(API_SCOPES);
export type ApiScope = z.infer<typeof ApiScope>;

/** What each scope lets a token do, as Integrations says it. */
export const SCOPE_LABELS: Record<ApiScope, string> = {
	"time:read": "Read time entries",
	"time:write": "Add, change and delete the maker's own time entries",
	"descriptions:read": "Read entry descriptions",
	"projects:read": "Read projects, clients and tasks",
	"people:read": "Read people and their leave",
	"expenses:read": "Read expenses",
	"invoices:read": "Read invoices",
};

/** The kinds of event a webhook may be told about: the first part of an activity's action. */
export const WEBHOOK_EVENTS = ["time_entry", "period", "expense", "invoice", "payment"] as const;

export const WebhookEvent = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/** Each kind of event, as Integrations names it. */
export const EVENT_LABELS: Record<WebhookEvent, string> = {
	time_entry: "Time entries",
	period: "Timesheet periods",
	expense: "Expenses",
	invoice: "Invoices",
	payment: "Payments",
};

/** The kind of event of an activity's action, such as `time_entry` for `time_entry.created`, or null when webhooks hear nothing of it. */
export function eventOf(action: string): WebhookEvent | null {
	const kind = WebhookEvent.safeParse(action.split(".", 1)[0]);
	return kind.success ? kind.data : null;
}

/** The longest address a webhook may have. */
export const WEBHOOK_URL_MAX = 2000;
