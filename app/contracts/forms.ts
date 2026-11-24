import * as z from "zod";

import { CurrencyCode } from "~/money/money";
import { Day } from "~/time/calendar";

import {
	JOB_TITLE_MAX_LENGTH,
	MULTIPLIERS,
	type Multiplier,
	OfferedKind,
	OvertimePay,
	PayBasis,
	WORKS_NUMBER_MAX_LENGTH,
} from "./contracts";

// What a contract sheet sends (TS-098a). Here, not in ./contracts beside the
// labels the sheets show: this module builds a `z.object` as it loads, and
// Zod 4 then tries `new Function`, which the page's Content Security Policy
// refuses in the browser (docs/security.md, "no unsafe-eval"). Only the
// server reads it.

const Optional = <T extends z.ZodType>(schema: T) =>
	z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** A multiplier as a form sends it: its basis points as text. */
const MultiplierField = z.preprocess(
	(value) => (value === "" || value === undefined ? undefined : Number(value)),
	z
		.number()
		.refine((n): n is Multiplier => (MULTIPLIERS as readonly number[]).includes(n))
		.optional(),
);

/** The terms as the contract sheets send them; amounts are read with the currency afterwards. */
export const TermsFields = z.object({
	jobTitle: Optional(z.string().trim().min(1).max(JOB_TITLE_MAX_LENGTH)),
	scheduleId: Optional(z.string().min(1).max(64)),
	payBasis: PayBasis,
	pay: z.string().trim().min(1).max(30),
	currency: CurrencyCode,
	overtimePay: OvertimePay,
	overtimeMultiplier: MultiplierField,
	restDayMultiplier: MultiplierField,
	leaveDays: Optional(z.coerce.number().int().min(0).max(366)),
});
export type TermsFields = z.infer<typeof TermsFields>;

/** The contract's own fields, as the sheet that gives or changes one sends them. */
export const ContractFields = TermsFields.extend({
	kind: OfferedKind,
	endsOn: Optional(Day),
	worksNumber: Optional(z.string().trim().min(1).max(WORKS_NUMBER_MAX_LENGTH)),
});
export type ContractFields = z.infer<typeof ContractFields>;
