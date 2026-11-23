import { halfDaysLabel } from "~/leave/kinds";
import { formatDuration } from "~/time/format";

import type { Grouping } from "./choices";
import { hoursAndMinutes, overtimeLabel } from "./format";
import type { PersonLine, ReportRequest } from "./reports.server";
import { sumsOf } from "./sums.server";

/**
 * The people of a Time report (TS-113, D8): the page draws its groups first,
 * and a group's people, or the People section of a report of more than
 * `PEOPLE_SHOWN` people, are read when they are opened
 * (`routes/app/reports.people.ts`), so the page's size does not grow with the
 * organisation.
 */

/** The most people the People section draws with the page; more are read when it is opened. */
export const PEOPLE_SHOWN = 50;

/** A person's worked time beside the time expected of them and their leave (TS-061), as the page shows it. */
export interface PersonView {
	id: string;
	name: string;
	address: string | null;
	worked: string;
	/** Their time split into regular and overtime; none says nothing. */
	overtime: string | null;
	expected: string;
	leave: string;
	/** Requests for leave starting in the range made at short notice (TS-090); none says nothing. */
	shortNotice: string | null;
}

export function personView(line: PersonLine): PersonView {
	return {
		id: line.id,
		name: line.name,
		address: line.address,
		worked: hoursAndMinutes(line.worked),
		overtime: overtimeLabel(line.worked / 60, line.overtime / 60),
		expected: formatDuration(line.expectedMinutes * 60),
		leave:
			line.leaveHalfDays === 0
				? "No leave"
				: `${formatDuration(line.leaveMinutes * 60)} leave (${halfDaysLabel(line.leaveHalfDays)})`,
		shortNotice: line.shortNotice === 0 ? null : `Short-notice requests: ${line.shortNotice}`,
	};
}

/** One person's time in a group of a report. */
export interface GroupPerson {
	id: string;
	name: string;
	duration: string;
	/** Of their time, the overtime (TS-095); none says nothing. */
	overtime: string | null;
}

/**
 * Who tracked time in the group `key` of `report` grouped by `grouping` (a
 * project's id, a client's id or "" for no client, or a day), each with their
 * time in it, by name. One statement of sums, as the report's own.
 */
export async function groupPeopleOf(
	report: ReportRequest,
	grouping: Grouping,
	key: string,
): Promise<GroupPerson[]> {
	const sums = await sumsOf(report, grouping === "day" ? { byDay: "day-and-person" } : {});
	const pieces =
		grouping === "day"
			? sums.days.filter((sum) => sum.day === key)
			: sums.sums.filter((sum) =>
					grouping === "project" ? sum.entry.projectId === key : (sum.entry.clientId ?? "") === key,
				);
	const time = new Map<string, { minutes: number; overtimeMinutes: number }>();
	for (const { entry, minutes } of pieces) {
		const theirs = time.get(entry.userId) ?? { minutes: 0, overtimeMinutes: 0 };
		theirs.minutes += minutes;
		if (entry.overtime) theirs.overtimeMinutes += minutes;
		time.set(entry.userId, theirs);
	}
	const names = new Map(report.choices.map((person) => [person.id, person.name]));
	return [...time]
		.filter(([, { minutes }]) => minutes > 0)
		.map(([id, { minutes, overtimeMinutes }]) => ({
			id,
			name: names.get(id) ?? "",
			duration: hoursAndMinutes(minutes * 60),
			overtime: overtimeLabel(minutes, overtimeMinutes),
		}))
		.sort((a, b) => a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : 1));
}
