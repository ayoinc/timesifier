import * as z from "zod";

import { periodAfter, periodContaining } from "~/periods/periods";
import { addDays, Day } from "~/time/calendar";

import { EVERYONE, GROUPS, type Grouping, RANGES, type Range } from "./choices";

/**
 * What a report is asked for (TS-014a): a range of days, how its time is
 * grouped, and, where the person may choose, whose time. It travels in the
 * address, so a report is a link, and the export (TS-014b) reads the same
 * address and so holds the same rows.
 */

/** The longest custom range, in days: a year, and the leap day of one. */
export const LONGEST_RANGE_DAYS = 366;

/** A field left empty by the form is a field not given. */
const blankIsAbsent = (value: unknown) => (value === "" ? undefined : value);

const ReportQuery = z
	.object({
		range: z.preprocess(blankIsAbsent, z.enum(RANGES).default("this-week")),
		from: z.preprocess(blankIsAbsent, Day.optional()),
		to: z.preprocess(blankIsAbsent, Day.optional()),
		group: z.preprocess(blankIsAbsent, z.enum(GROUPS).default("project")),
		person: z.preprocess(
			(value) => (value === EVERYONE ? undefined : blankIsAbsent(value)),
			z.string().max(64).optional(),
		),
	})
	.superRefine((query, context) => {
		if (query.range !== "custom") return;
		if (query.from === undefined || query.to === undefined) {
			context.addIssue({ code: "custom", message: "A custom range needs a first and a last day." });
			return;
		}
		const span = daysBetween(query.from, query.to);
		if (span < 0) {
			context.addIssue({ code: "custom", message: "The last day is before the first." });
		} else if (span >= LONGEST_RANGE_DAYS) {
			context.addIssue({
				code: "custom",
				message: `A range is at most ${LONGEST_RANGE_DAYS} days.`,
			});
		}
	});

export type ReportQuery = z.output<typeof ReportQuery>;

/**
 * The report an address asks for, or null when it asks for none that can be
 * made: a range or a grouping that is not one of these, a day that is not a
 * date, or a custom range without both its days, backwards or longer than a
 * year. A value the address leaves out takes its default: this week, by project,
 * everyone the viewer may see. The page answers null with 400.
 */
export function parseReportQuery(params: URLSearchParams): ReportQuery | null {
	const result = ReportQuery.safeParse(Object.fromEntries(params));
	return result.success ? result.data : null;
}

/** The days a report covers, both included. */
export interface ReportDays {
	first: Day;
	last: Day;
}

/**
 * The days of `query`'s range, with `today` the local date in the
 * organisation's zone. A week starts on the organisation's `week_starts_on`, as
 * its timesheet periods do; a month is the calendar month. `week` and `month`
 * hold the day in `from`, or today when there is none.
 */
export function rangeDays(query: ReportQuery, today: Day, weekStartsOn: number): ReportDays {
	switch (query.range) {
		case "this-week":
		case "last-week": {
			const week = periodContaining(today, weekStartsOn);
			const { startsOn, endsOn } = query.range === "this-week" ? week : periodAfter(week, -1);
			return { first: startsOn, last: endsOn };
		}
		case "week": {
			const { startsOn, endsOn } = periodContaining(query.from ?? today, weekStartsOn);
			return { first: startsOn, last: endsOn };
		}
		case "this-month":
			return monthOf(today);
		case "month":
			return monthOf(query.from ?? today);
		case "custom":
			if (query.from === undefined || query.to === undefined) {
				throw new Error("A custom range is parsed with both its days.");
			}
			return { first: query.from, last: query.to };
	}
}

/** The calendar month `day` falls in. */
function monthOf(day: Day): ReportDays {
	const first = `${day.slice(0, 7)}-01`;
	// Day 0 of the next month is the last day of this one.
	const length = new Date(
		Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0),
	).getUTCDate();
	return { first, last: addDays(first, length - 1) };
}

/** Which way Previous and Next step a range. */
export type Step = -1 | 1;

/** A range Previous or Next lead to: a week or a month by its days, or a custom range. */
export interface SteppedRange {
	range: "week" | "month" | "custom";
	days: ReportDays;
}

/**
 * The range one step before or after `days`, a range of the kind `range` is,
 * by its own length (TS-059): a week by a week, a month by a calendar month
 * whatever its number of days, a custom range by its number of days. A week or
 * a month is named by its first day, so the step is a link of its own.
 */
export function steppedRange(range: Range, days: ReportDays, step: Step): SteppedRange {
	switch (range) {
		case "this-week":
		case "last-week":
		case "week":
			return {
				range: "week",
				days: { first: addDays(days.first, 7 * step), last: addDays(days.last, 7 * step) },
			};
		case "this-month":
		case "month": {
			// Month 0 of a year is its January; a month past December is the next year's.
			const month = new Date(
				Date.UTC(Number(days.first.slice(0, 4)), Number(days.first.slice(5, 7)) - 1 + step, 1),
			);
			return { range: "month", days: monthOf(month.toISOString().slice(0, 10)) };
		}
		case "custom": {
			const length = (daysBetween(days.first, days.last) + 1) * step;
			return {
				range: "custom",
				days: { first: addDays(days.first, length), last: addDays(days.last, length) },
			};
		}
	}
}

/**
 * The address of a report, written out in full: the range, with its days where
 * they are not today's (a custom range both, a week or a month its first), the
 * grouping and the person. The page's Previous and Next and its export are
 * written by it, so each holds the report it names.
 */
export function reportSearch(report: {
	range: Range;
	days: ReportDays;
	group: Grouping;
	person?: string;
}): URLSearchParams {
	const search = new URLSearchParams({ range: report.range });
	if (report.range === "custom") {
		search.set("from", report.days.first);
		search.set("to", report.days.last);
	} else if (report.range === "week" || report.range === "month") {
		search.set("from", report.days.first);
	}
	search.set("group", report.group);
	if (report.person !== undefined) search.set("person", report.person);
	return search;
}

/** How many days `last` is after `first`: 0 for the same day, negative when it is before. */
function daysBetween(first: Day, last: Day): number {
	return (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000;
}
