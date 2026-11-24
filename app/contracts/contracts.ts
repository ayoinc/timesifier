import * as z from "zod";

import { BASIS_POINTS, formatMoney } from "~/money/money";
import { versionOn } from "~/schedules/schedules";
import { addDays, type Day } from "~/time/calendar";
import { formatDayWithYear, LOCALE } from "~/time/format";
import type { TermsFields } from "./forms";
import { type ContractSpan, END_OF_TIME, overlaps, spanOn } from "./spans";

/**
 * Contracts (TS-098a, `docs/research/contracts-model.md` sections 1 and 2):
 * the terms on which one person works for the organisation over a run of
 * days. A person has none, one or several, one after another and never
 * overlapping. A contract's terms change from a day: each change is a version
 * from its day, and days before it keep the terms they had, as a schedule's
 * versions do (`versionOn`). A change of kind ends one contract and starts the
 * next. Nothing here reads the database: `contracts.server.ts` does.
 */

/** The kinds of contract. `irregular`, zero hours, is in the model but not offered yet (the owner's answer 8). */
export const CONTRACT_KINDS = ["permanent", "fixed_term", "contractor", "irregular"] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** The kinds a person may be given today. */
export const OFFERED_KINDS = ["permanent", "fixed_term", "contractor"] as const;
export const OfferedKind = z.enum(OFFERED_KINDS);

export const KIND_LABELS: Record<ContractKind, string> = {
	permanent: "Permanent",
	fixed_term: "Fixed term",
	contractor: "Contractor",
	irregular: "Zero hours",
};

/** How pay is stated. */
export const PAY_BASES = ["yearly", "hourly", "daily"] as const;
export type PayBasis = (typeof PAY_BASES)[number];
export const PayBasis = z.enum(PAY_BASES);

export const PAY_BASIS_LABELS: Record<PayBasis, string> = {
	yearly: "A year",
	hourly: "An hour",
	daily: "A day",
};

const PAY_BASIS_WORDS: Record<PayBasis, string> = {
	yearly: "a year",
	hourly: "an hour",
	daily: "a day",
};

/** What recorded overtime earns. The schedule still decides whether it may be recorded. */
export const OVERTIME_PAYS = ["unpaid", "paid", "toil"] as const;
export type OvertimePay = (typeof OVERTIME_PAYS)[number];
export const OvertimePay = z.enum(OVERTIME_PAYS);

export const OVERTIME_PAY_LABELS: Record<OvertimePay, string> = {
	unpaid: "Recorded, not paid",
	paid: "Paid",
	toil: "Time off in lieu",
};

/** The multipliers offered, in basis points: those BrightPay's import has columns for. */
export const MULTIPLIERS = [10000, 12500, 13333, 15000, 20000, 30000, 40000] as const;
export type Multiplier = (typeof MULTIPLIERS)[number];

export const MULTIPLIER_LABELS: Record<Multiplier, string> = {
	10000: "Plain time",
	12500: "Time and a quarter",
	13333: "Time and a third",
	15000: "Time and a half",
	20000: "Double time",
	30000: "Triple time",
	40000: "Four times",
};

/** Why a contract ended. `replaced` is written when the next one follows it with a change of kind. */
export const END_REASONS = ["resigned", "dismissed", "end_of_term", "replaced"] as const;
export type EndReason = (typeof END_REASONS)[number];
export const EndReason = z.enum(END_REASONS);

export const END_REASON_LABELS: Record<EndReason, string> = {
	resigned: "They resigned",
	dismissed: "They were dismissed",
	end_of_term: "The term came to its end",
	replaced: "A new contract follows it",
};

/** The reasons a person ending a contract chooses from; `replaced` is the server's own. */
export const CHOSEN_END_REASONS = ["resigned", "dismissed", "end_of_term"] as const;

/** The longest job title and works number. */
export const JOB_TITLE_MAX_LENGTH = 100;
export const WORKS_NUMBER_MAX_LENGTH = 35;

/**
 * How long an ended contract is kept (contracts-model.md section 6, "Keeping"):
 * HMRC asks for payroll records "for 3 years from the end of the tax year they
 * relate to", and the UK tax year ends on 5 April.
 */
export const CONTRACT_KEEP_YEARS = 3;
export const TAX_YEAR_END = "04-05";

/**
 * The last day a contract may have ended on and be deleted on `today`: the
 * end of the latest tax year whose three years were over before `today`. A
 * contract that ended on Sunday 5 April 2026 is kept until Thursday 5 April
 * 2029 and deleted from Friday 6 April 2029.
 */
export function deletableEndedBy(today: Day): Day {
	const year = Number(today.slice(0, 4));
	const lastOver = today > `${year}-${TAX_YEAR_END}` ? year : year - 1;
	return `${lastOver - CONTRACT_KEEP_YEARS}-${TAX_YEAR_END}`;
}

/** The terms of one version: what a change from a day sets. */
export interface ContractTerms {
	jobTitle: string | null;
	/** The schedule the contract gives from this day; null gives none. */
	scheduleId: string | null;
	payBasis: PayBasis;
	payMinor: number;
	currency: string;
	overtimePay: OvertimePay;
	/** Null when overtime is not paid or banked. */
	overtimeMultiplierBp: Multiplier | null;
	/** On a day not worked or a public holiday; null for the overtime multiplier. */
	restDayMultiplierBp: Multiplier | null;
	/** A year for a full week; null for the kind of leave's allowance. */
	leaveDays: number | null;
	/** Days left at the end of a leave year that carry into the next (TS-098b); 0 carries none. */
	carryOverDays: number;
	/** Days into the next leave year that carried leave lasts; null to that year's end. */
	carryOverExpiresAfterDays: number | null;
}

/** One version of a contract. */
export interface ContractVersion extends ContractTerms {
	id: string;
	effectiveFrom: Day;
}

/** A contract with its versions, in order of their days. */
export interface Contract {
	id: string;
	userId: string;
	kind: ContractKind;
	startsOn: Day;
	endsOn: Day | null;
	endReason: EndReason | null;
	worksNumber: string | null;
	/** Whether, as the person's first, the days of a leave year before it count at the annual kind's allowance (TS-098b, decision 76). */
	priorDaysAtAllowance: boolean;
	versions: readonly ContractVersion[];
}

/** How the days of a leave year before a person's first contract count: at the kind's allowance, or not at all. */
export const PRIOR_DAYS = ["allowance", "nothing"] as const;
export type PriorDays = (typeof PRIOR_DAYS)[number];

/** The Give sheet's answers to how the days before a first contract count. */
export const PRIOR_DAYS_LABELS: Record<PriorDays, string> = {
	allowance: "Count at the usual allowance",
	nothing: "Count nothing",
};

/** What each answer means, under it. */
export const PRIOR_DAYS_HINTS: Record<PriorDays, string> = {
	allowance: "They worked here before; their balance stays as it is.",
	nothing: "They start with this contract.",
};

/** Days a member joined before their first contract starts from which the Give sheet suggests their earlier days count at the allowance. */
export const PRIOR_DAYS_SUGGESTED_FROM = 28;

/**
 * Whether giving a contract from `startsOn` asks how the days of the leave
 * year before it count, and the answer it suggests: asked only of a first
 * contract for someone who joined before it starts. It suggests the allowance
 * when they joined at least 28 days before, and nothing otherwise, as for a
 * starter invited a few days early. Null when it is not asked.
 */
export function priorDaysQuestion(
	joinedOn: Day | null,
	hasContracts: boolean,
	startsOn: Day,
): PriorDays | null {
	if (hasContracts || joinedOn === null || joinedOn >= startsOn) return null;
	return addDays(joinedOn, PRIOR_DAYS_SUGGESTED_FROM) <= startsOn ? "allowance" : "nothing";
}

/** The one of `contracts` that a contract from `startsOn` to `endsOn` would share a day with, if any; `except` is left out. */
export function overlapOf<C extends Pick<Contract, "id" | "startsOn" | "endsOn">>(
	contracts: readonly C[],
	span: { startsOn: Day; endsOn: Day | null },
	except?: string,
): C | undefined {
	return contracts.find((c) => c.id !== except && overlaps(c, span));
}

/** A person's contracts as the schedules read them: their runs of days and whether each is a contractor's. */
export function spansOf(contracts: readonly Pick<Contract, "kind" | "startsOn" | "endsOn">[]) {
	return contracts.map(
		(c): ContractSpan => ({
			startsOn: c.startsOn,
			endsOn: c.endsOn,
			contractor: c.kind === "contractor",
		}),
	);
}

// Who owns a person's schedule.

/** A person assignment a contract writes: from a day, the schedule (or none), and the version it came from. */
export interface ContractAssignment {
	from: Day;
	scheduleId: string | null;
	sourceId: string;
}

/**
 * The person assignments `contracts` give from `today` on (TS-098a). A
 * version with a schedule gives it from the later of its day and today; one
 * with none after one with a schedule takes the contract's away, and so does
 * the day after a contract that owned the hours ends, so the person falls back
 * to their team's, role's or organisation's. A version with none, after none,
 * writes nothing, so a person's own hours stay. Days before today are never
 * written: they keep the schedule they had.
 */
export function contractAssignments(
	contracts: readonly Contract[],
	today: Day,
): ContractAssignment[] {
	const byDay = new Map<Day, ContractAssignment>();
	const put = (assignment: ContractAssignment) => {
		if (assignment.from < today) return;
		byDay.set(assignment.from, assignment);
	};
	const ordered = [...contracts].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
	for (const contract of ordered) {
		let owned = false;
		contract.versions.forEach((version, index) => {
			const next = contract.versions[index + 1];
			const last = next ? addDays(next.effectiveFrom, -1) : (contract.endsOn ?? END_OF_TIME);
			const end = contract.endsOn && contract.endsOn < last ? contract.endsOn : last;
			if (end < today || version.effectiveFrom > end) {
				owned = version.scheduleId !== null;
				return;
			}
			const from = version.effectiveFrom > today ? version.effectiveFrom : today;
			if (version.scheduleId !== null) {
				put({ from, scheduleId: version.scheduleId, sourceId: version.id });
				owned = true;
			} else if (owned) {
				put({ from, scheduleId: null, sourceId: version.id });
				owned = false;
			}
		});
		const lastVersion = contract.versions.at(-1);
		if (contract.endsOn && owned && lastVersion) {
			put({ from: addDays(contract.endsOn, 1), scheduleId: null, sourceId: lastVersion.id });
		}
	}
	return [...byDay.values()].sort((a, b) => (a.from < b.from ? -1 : 1));
}

/** Whether a contract of `contracts` gives the person's hours on `day`: it covers the day, and its terms that day name a schedule. */
export function contractOwnsHours(contracts: readonly Contract[], day: Day): boolean {
	const contract = spanOn(contracts, day);
	return contract !== undefined && versionOn(contract, day).scheduleId !== null;
}

/**
 * The multipliers a version keeps: none while overtime is not paid or
 * banked; the overtime multiplier, plain time unless chosen, while it is.
 */
export function multipliersOf(
	fields: Pick<TermsFields, "overtimePay" | "overtimeMultiplier" | "restDayMultiplier">,
) {
	if (fields.overtimePay === "unpaid") {
		return { overtimeMultiplierBp: null, restDayMultiplierBp: null };
	}
	return {
		overtimeMultiplierBp: fields.overtimeMultiplier ?? 10000,
		restDayMultiplierBp: fields.restDayMultiplier ?? null,
	};
}

// In words.

/** A multiplier in words, lower case for a sentence: "time and a half". */
export function multiplierWords(bp: number): string {
	const label = MULTIPLIER_LABELS[bp as Multiplier];
	return label ? label.toLowerCase() : `${bp / BASIS_POINTS}×`;
}

/** Pay in words: "£42,000.00 a year". */
export function payWords(terms: Pick<ContractTerms, "payMinor" | "currency" | "payBasis">): string {
	return `${formatMoney(terms.payMinor, terms.currency, LOCALE)} ${PAY_BASIS_WORDS[terms.payBasis]}`;
}

/** The kind and run of days in a sentence: "Permanent, from Monday 2 February 2026." */
export function spanSentence(contract: Pick<Contract, "kind" | "startsOn" | "endsOn">): string {
	const kind = KIND_LABELS[contract.kind];
	const from = formatDayWithYear(contract.startsOn);
	return contract.endsOn
		? `${kind}, from ${from} to ${formatDayWithYear(contract.endsOn)}.`
		: `${kind}, from ${from}.`;
}

/** What recorded overtime earns, in a sentence. */
export function overtimeSentence(
	terms: Pick<ContractTerms, "overtimePay" | "overtimeMultiplierBp" | "restDayMultiplierBp">,
	seesPay: boolean,
): string {
	if (terms.overtimePay === "unpaid") return "Overtime is recorded and not paid.";
	const rate =
		seesPay && terms.overtimeMultiplierBp
			? ` at ${multiplierWords(terms.overtimeMultiplierBp)}`
			: "";
	const restDay =
		seesPay && terms.restDayMultiplierBp
			? `; on days off and public holidays, ${multiplierWords(terms.restDayMultiplierBp)}`
			: "";
	return terms.overtimePay === "toil"
		? `Overtime becomes time off in lieu${rate}${restDay}.`
		: `Overtime is paid${rate}${restDay}.`;
}

/**
 * The annual leave in a sentence, and what carries over. Public holidays are
 * on top of it, or come out of it where the organisation says so (TS-098b).
 */
export function leaveSentence(
	terms: Pick<ContractTerms, "leaveDays" | "carryOverDays" | "carryOverExpiresAfterDays">,
	holidaysFromAllowance: boolean,
): string {
	const { leaveDays, carryOverDays, carryOverExpiresAfterDays } = terms;
	const leave =
		leaveDays === null
			? "Annual leave: the allowance of the kind of leave."
			: `Annual leave: ${leaveDays} ${leaveDays === 1 ? "day" : "days"} a year for a full week, ${holidaysFromAllowance ? "public holidays included" : "plus public holidays"}.`;
	if (carryOverDays === 0) return leave;
	const lasting =
		carryOverExpiresAfterDays === null
			? "for the next leave year"
			: `for ${carryOverExpiresAfterDays} ${carryOverExpiresAfterDays === 1 ? "day" : "days"} of the next leave year`;
	return `${leave} Up to ${carryOverDays} ${carryOverDays === 1 ? "day" : "days"} left at a year's end carry over, ${lasting}.`;
}
