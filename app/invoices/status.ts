import * as z from "zod";

import type { Day } from "~/time/calendar";

/**
 * An invoice's state (TS-073, TS-074). The table stores one of five words;
 * what a person reads is worked out from it and the invoice's payments:
 *
 * - `draft`: its lines still change. It has its number, which is never reused.
 * - `sent`: issued. Its number, issue date, due date and lines are fixed. It
 *   is "open", and "overdue" once its due date has passed in the
 *   organisation's time zone. Whether it has been emailed is `sent_at`.
 * - `partially_paid`: issued, with payments or write-offs that leave a balance.
 * - `paid`: issued, and its payments and write-offs come to its total. It
 *   reads "written off" when any part of that is a write-off.
 * - `void`: cancelled. Its entries and expenses are released.
 */
export const InvoiceStatus = z.enum(["draft", "sent", "partially_paid", "paid", "void"]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

/** What a person reads for an invoice's state. */
export type InvoiceState =
	| "draft"
	| "open"
	| "overdue"
	| "partly-paid"
	| "paid"
	| "written-off"
	| "void";

export const STATE_LABELS: Record<InvoiceState, string> = {
	draft: "Draft",
	open: "Open",
	overdue: "Overdue",
	"partly-paid": "Partly paid",
	paid: "Paid",
	"written-off": "Written off",
	void: "Void",
};

/** The statuses of an issued invoice that may still be owed something. */
export const OWING: readonly InvoiceStatus[] = ["sent", "partially_paid"];

/** What has been settled on an invoice: its payments and its write-offs, each summed. */
export interface Settled {
	paidMinor: number;
	writtenOffMinor: number;
}

/**
 * What is still owed: the total less payments and write-offs. Recording a
 * payment or a write-off larger than this is refused, so it is never below 0.
 */
export function balanceOf(totalMinor: number, { paidMinor, writtenOffMinor }: Settled): number {
	return totalMinor - paidMinor - writtenOffMinor;
}

/**
 * The status an issued invoice is stored with once its payments are `settled`:
 * paid when nothing is owed, partly paid when something has been settled,
 * otherwise still open (`sent`).
 */
export function settledStatus(totalMinor: number, settled: Settled): InvoiceStatus {
	const balance = balanceOf(totalMinor, settled);
	if (balance <= 0) return "paid";
	return settled.paidMinor + settled.writtenOffMinor > 0 ? "partially_paid" : "sent";
}

/** What a person reads for an invoice stored with `status`, on `today` in the organisation's zone. */
export function stateOf(
	invoice: { status: string; dueOn: Day },
	settled: Settled,
	today: Day,
): InvoiceState {
	switch (invoice.status) {
		case "draft":
			return "draft";
		case "void":
			return "void";
		case "paid":
			return settled.writtenOffMinor > 0 ? "written-off" : "paid";
		default:
			if (invoice.dueOn < today) return "overdue";
			return invoice.status === "partially_paid" ? "partly-paid" : "open";
	}
}

/** Whole days from `from` to `to`: positive when `to` is later. */
export function daysBetween(from: Day, to: Day): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The ages receivables are grouped by: days past the due date, in the organisation's zone. */
export const AGES = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type Age = (typeof AGES)[number];

export const AGE_LABELS: Record<Age, string> = {
	current: "Current",
	"1-30": "1–30 days overdue",
	"31-60": "31–60 days overdue",
	"61-90": "61–90 days overdue",
	"90+": "Over 90 days overdue",
};

/** How overdue an invoice due on `dueOn` is on `today`: current until the day after it is due. */
export function ageOf(dueOn: Day, today: Day): Age {
	const late = daysBetween(dueOn, today);
	if (late <= 0) return "current";
	if (late <= 30) return "1-30";
	if (late <= 60) return "31-60";
	if (late <= 90) return "61-90";
	return "90+";
}
