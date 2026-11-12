import * as z from "zod";

import { Day } from "~/time/calendar";

import { FREQUENCY_LABELS, Frequency } from "./recurring";

// The fields of a recurring invoice's forms (TS-078), for the list that sets
// one up and its page that changes it.

/** The fields a recurring invoice is set up and changed with, shared with its own page. */
export const RecurringFields = {
	frequency: Frequency,
	endsOn: z.union([Day, z.literal("").transform(() => null)]),
	sendAutomatically: z
		.literal("on")
		.optional()
		.transform((value) => value === "on"),
	includeUninvoicedTime: z
		.literal("on")
		.optional()
		.transform((value) => value === "on"),
	paymentTermsDays: z
		.string()
		.trim()
		.refine(
			(value) => /^\d{1,3}$/.test(value) && Number(value) <= 365,
			"Enter a whole number of days from 0 to 365.",
		)
		.transform(Number),
	subject: z
		.string()
		.trim()
		.max(200, "Use up to 200 characters.")
		.transform((value) => (value === "" ? null : value)),
	notes: z
		.string()
		.trim()
		.max(2000, "Use up to 2000 characters.")
		.transform((value) => (value === "" ? null : value)),
};

export const FREQUENCY_OPTIONS = Frequency.options.map((id) => ({
	id,
	label: FREQUENCY_LABELS[id],
}));
