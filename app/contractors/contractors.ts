import { type Money, minorDigits, roundHalfUp, totalsByCurrency } from "~/money/money";
import type { Role } from "~/organisations/roles";
import { type RateRow, resolveRate } from "~/rates/rates";
import type { ReportDays } from "~/reports/query";
import type { Day } from "~/time/calendar";

/**
 * Contractors (TS-079, B15): whether a member is an employee or a contractor,
 * and what each contractor tracked in a range of days and what it cost. Hours
 * are not rounded: a length is whole seconds, as Reports counts them. Cost is
 * the hours at the person's cost rate in force on the entry's day, the one
 * stored with it (`resolveRate`, kind `cost`); amounts are added exactly and
 * rounded half up once, to the person's total in each currency. Amounts in
 * different currencies are never added together. Time with no cost rate costs
 * nothing and is counted apart, so the page can say which rate is missing.
 *
 * Nothing here reads the database: `contractors.server.ts` does, and adds the
 * entries up there (`ContractorTime`).
 */

/**
 * Whether `actor` may mark a member holding `target` as an employee or a
 * contractor. An owner marks anyone, themselves included; an admin marks the
 * people whose role they may change, which is neither an owner nor themselves.
 * The flag grants nothing (docs/security.md, "Roles").
 */
export function mayMarkContractor(actor: Role, target: Role, isSelf: boolean): boolean {
	if (actor === "owner") return true;
	return actor === "admin" && !isSelf && target !== "owner";
}

/**
 * Time as the report reads it: the entries of one person on one project, task
 * and stored day, regular or overtime, added up in whole seconds. Every entry
 * of it is priced at the same rate, so pricing it once is pricing each entry.
 */
export interface ContractorTime {
	userId: string;
	projectId: string;
	taskId: string | null;
	/** The day its entries belong to, stored when they were tracked (TS-111). */
	day: Day;
	/** Whether it is overtime, kept apart from regular time so a rate for overtime is one factor. */
	overtime: boolean;
	/**
	 * Each entry's length in whole seconds, from the second its start is in to
	 * the second its end is in, as Reports counts it, a running entry to the
	 * time of the request; added up.
	 */
	seconds: number;
}

/** A person the report lists: a contractor now, or one who left the organisation as one. */
export interface Contractor {
	id: string;
	name: string;
	/** Whether they are no longer a member. */
	left: boolean;
}

/** A person's time at the cost rates of one currency, and what it cost. */
export interface CostLine {
	currency: string;
	seconds: number;
	/** Rounded half up once, from the exact sum of every entry's cost. */
	amountMinor: number;
}

/** One contractor's line: their time in the range, its cost, and the time no cost rate prices. */
export interface ContractorLine {
	id: string;
	name: string;
	left: boolean;
	seconds: number;
	/** Seconds with no cost rate in force: they cost 0 and are shown as a missing rate. */
	missingSeconds: number;
	/** By currency, ordered by code. */
	costs: CostLine[];
}

const SECONDS_AN_HOUR = 3600;

/**
 * Each contractor who has time on one of `days`, with that time and its cost,
 * ordered by name. An entry belongs whole to its stored day, the day it
 * started on in the person's zone when it was tracked.
 */
export function contractorLines(
	contractors: readonly Contractor[],
	time: readonly ContractorTime[],
	rates: readonly RateRow[],
	days: ReportDays,
): ContractorLine[] {
	const people = new Map(contractors.map((person) => [person.id, person]));
	type Tally = {
		seconds: number;
		missingSeconds: number;
		/** By currency: the seconds, and the exact cost in minor units times 3600. */
		priced: Map<string, { seconds: number; exact: number }>;
	};
	const tallies = new Map<string, Tally>();

	for (const part of time) {
		const person = people.get(part.userId);
		if (!person) continue;
		const { day, seconds } = part;
		if (day < days.first || day > days.last) continue;

		const tally = tallies.get(person.id) ?? { seconds: 0, missingSeconds: 0, priced: new Map() };
		tallies.set(person.id, tally);
		tally.seconds += seconds;
		const rate = resolveRate(rates, {
			kind: "cost",
			userId: part.userId,
			projectId: part.projectId,
			taskId: part.taskId,
			on: day,
		});
		if (!rate) {
			tally.missingSeconds += seconds;
			continue;
		}
		const priced = tally.priced.get(rate.currency) ?? { seconds: 0, exact: 0 };
		priced.seconds += seconds;
		priced.exact += seconds * rate.amountMinor;
		tally.priced.set(rate.currency, priced);
	}

	return [...tallies]
		.map(([id, tally]) => {
			const person = people.get(id) as Contractor;
			return {
				id,
				name: person.name,
				left: person.left,
				seconds: tally.seconds,
				missingSeconds: tally.missingSeconds,
				costs: [...tally.priced]
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([currency, { seconds, exact }]) => ({
						currency,
						seconds,
						amountMinor: roundHalfUp(exact, SECONDS_AN_HOUR),
					})),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : 1));
}

/** What the lines add up to: their time, the time without a rate, and one total per currency. */
export interface ContractorTotals {
	seconds: number;
	missingSeconds: number;
	costs: Money[];
}

/** The totals of `lines`: each currency's amounts added as the rows show them, never across currencies. */
export function contractorTotals(lines: readonly ContractorLine[]): ContractorTotals {
	return {
		seconds: lines.reduce((sum, line) => sum + line.seconds, 0),
		missingSeconds: lines.reduce((sum, line) => sum + line.missingSeconds, 0),
		costs: totalsByCurrency(
			lines.flatMap((line) =>
				line.costs.map(({ currency, amountMinor }) => ({ currency, amountMinor })),
			),
		),
	};
}

/**
 * The columns of the export. A contractor has a row for each currency their
 * time was priced in, and a row with `rate_missing` "yes" and no currency for
 * the time no rate prices, so `seconds` adds up to their time.
 */
export const CONTRACTOR_CSV_COLUMNS = [
	"person",
	"left_organisation",
	"rate_missing",
	"seconds",
	"hours",
	"currency",
	"cost",
] as const;

/** `seconds` as hours to six decimal places, rounded half up once: 5400 is "1.500000". */
export function decimalHours(seconds: number): string {
	const millionths = roundHalfUp(seconds * 1_000_000, SECONDS_AN_HOUR);
	return `${Math.floor(millionths / 1_000_000)}.${String(millionths % 1_000_000).padStart(6, "0")}`;
}

/** `minor` units of `currency` as a plain decimal with the currency's own places: 12345 GBP is "123.45". */
export function decimalAmount(minor: number, currency: string): string {
	const digits = minorDigits(currency);
	const sign = minor < 0 ? "-" : "";
	const whole = String(Math.abs(minor));
	if (digits === 0) return `${sign}${whole}`;
	const padded = whole.padStart(digits + 1, "0");
	return `${sign}${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

/** The rows of one contractor's line, in the order of `CONTRACTOR_CSV_COLUMNS`. */
export function contractorCsvRows(line: ContractorLine): string[][] {
	const left = line.left ? "yes" : "no";
	const rows = line.costs.map((cost) => [
		line.name,
		left,
		"no",
		String(cost.seconds),
		decimalHours(cost.seconds),
		cost.currency,
		decimalAmount(cost.amountMinor, cost.currency),
	]);
	if (line.missingSeconds > 0 || rows.length === 0) {
		rows.push([
			line.name,
			left,
			line.missingSeconds > 0 ? "yes" : "no",
			String(line.missingSeconds),
			decimalHours(line.missingSeconds),
			"",
			"",
		]);
	}
	return rows;
}
