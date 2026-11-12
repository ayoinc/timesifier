import * as z from "zod";

import {
	LONGEST_OVERTIME_CAP_MINUTES,
	NonWorkingRule,
	OVERTIME_RULE_LABELS,
	OvertimeRule,
} from "~/leave/rules";
import { RECORD_NAME_PROBLEM, recordName } from "~/lib/names";
import type { Day } from "~/time/calendar";

import {
	assignmentOn,
	isWorkedDay,
	LAST_MINUTE,
	parseClock,
	type ScheduleBook,
	type ScheduleRules,
	type ScheduleWeek,
	versionOn,
	WEEKDAY_LABELS,
	type WorkedDay,
	weekLabel,
} from "./schedules";

// What the work schedule forms send and how the server reads them (TS-097),
// shared by the pages that send them and the actions that read them. A form
// sends text; what is wrong with it comes back as one sentence, so the sheet
// says it where the person is looking.

/**
 * An overtime cap as typed (TS-095): hours as `2`, `1.5` or `1:30`, at most a
 * week; empty, or none, is no cap. The result is whole minutes, or null.
 */
export const CapHours = z
	.string()
	.trim()
	.max(8)
	.transform((text, context) => {
		if (text === "") return null;
		const minutes = capMinutes(text);
		if (minutes === undefined) {
			context.addIssue({ code: "custom", message: CAP_PROBLEM });
			return z.NEVER;
		}
		return minutes;
	});

const CAP_PROBLEM = `Type hours as 2 or 1:30, at most ${LONGEST_OVERTIME_CAP_MINUTES / 60}.`;

/** A cap's minutes from its text: null for none, undefined for text that is no cap. */
function capMinutes(text: string): number | null | undefined {
	if (text.trim() === "") return null;
	const clock = /^(\d{1,3}):([0-5]\d)$/.exec(text.trim());
	const decimal = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
	let minutes: number | null = null;
	if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
	else if (decimal) minutes = Math.round(Number(`${decimal[1]}.${decimal[2] ?? "0"}`) * 60);
	if (minutes === null || minutes > LONGEST_OVERTIME_CAP_MINUTES) return undefined;
	return minutes === 0 ? null : minutes;
}

/** "Use the organisation's rule": the value of a rule's choice that sets none of the schedule's own. */
export const ORGANISATION_CHOICE = "organisation";

/** The overtime choices of a schedule: the organisation's, or one of its own. */
export const OVERTIME_CHOICES = [
	{ id: ORGANISATION_CHOICE, label: "The organisation's rule" },
	...OvertimeRule.options.map((rule) => ({ id: rule, label: OVERTIME_RULE_LABELS[rule] })),
];

const Text = z.string().max(16).optional().default("");

/** One weekday's fields: whether it is worked, its start and finish as clock times, and the break in minutes. */
const dayFields = Object.fromEntries(
	[1, 2, 3, 4, 5, 6, 7].flatMap((n) => [
		[`worked${n}`, z.string().max(4).optional()],
		[`start${n}`, Text],
		[`finish${n}`, Text],
		[`break${n}`, Text],
	]),
) as Record<string, z.ZodType<string | undefined>>;

/** The fields of a schedule as its sheet sends them, all text: `readSchedule` holds them to the rules. */
export const ScheduleFields = z.object({
	name: z.string().max(200),
	overtime: z.string().max(16).optional().default(ORGANISATION_CHOICE),
	overtimeDayCap: Text,
	overtimeWeekCap: Text,
	weekend: z.string().max(16).optional().default(ORGANISATION_CHOICE),
	...dayFields,
});
export type ScheduleFields = z.infer<typeof ScheduleFields>;

/** A schedule as read from its fields, or the one sentence that says what is wrong. */
export type ReadSchedule =
	| { ok: true; name: string; week: ScheduleWeek; rules: ScheduleRules }
	| { ok: false; problem: string };

/** The longest unpaid break a day may have, in minutes. */
export const LONGEST_BREAK_MINUTES = 12 * 60;

/** Reads a schedule's fields: a name, at least one day worked, each with a start before its finish and a break shorter than the time between. */
export function readSchedule(fields: Record<string, string | undefined>): ReadSchedule {
	const name = recordName(fields.name ?? "");
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const week: (WorkedDay | null)[] = [];
	for (const [index, label] of WEEKDAY_LABELS.entries()) {
		const n = index + 1;
		if (fields[`worked${n}`] !== "on") {
			week.push(null);
			continue;
		}
		const start = parseClock(fields[`start${n}`] ?? "");
		const finish = parseClock(fields[`finish${n}`] ?? "");
		if (start === null || finish === null) {
			return {
				ok: false,
				problem: `Type ${label}'s start and finish as times, such as 09:00 and 17:30.`,
			};
		}
		if (finish <= start || start >= LAST_MINUTE) {
			return { ok: false, problem: `${label} finishes before it starts. A day ends by midnight.` };
		}
		const breakText = (fields[`break${n}`] ?? "").trim();
		const breakMinutes = breakText === "" ? 0 : Number(breakText);
		if (!/^\d{0,3}$/.test(breakText) || breakMinutes > LONGEST_BREAK_MINUTES) {
			return { ok: false, problem: `Type ${label}'s break in whole minutes, such as 30.` };
		}
		const day = { start, finish, breakMinutes };
		if (!isWorkedDay(day)) {
			return { ok: false, problem: `${label}'s break is as long as the day. Shorten it.` };
		}
		week.push(day);
	}
	if (!week.some((day) => day !== null)) {
		return { ok: false, problem: "Choose at least one day worked." };
	}

	let overtime: ScheduleRules["overtime"] = null;
	if (fields.overtime !== ORGANISATION_CHOICE) {
		const policy = OvertimeRule.safeParse(fields.overtime);
		if (!policy.success) return { ok: false, problem: "Choose an overtime rule." };
		const dayCap = capMinutes(fields.overtimeDayCap ?? "");
		const weekCap = capMinutes(fields.overtimeWeekCap ?? "");
		if (dayCap === undefined || weekCap === undefined) return { ok: false, problem: CAP_PROBLEM };
		overtime = { policy: policy.data, dayCap, weekCap };
	}
	let weekend: ScheduleRules["weekend"] = null;
	if (fields.weekend !== ORGANISATION_CHOICE) {
		const rule = NonWorkingRule.safeParse(fields.weekend);
		if (!rule.success) return { ok: false, problem: "Choose a rule for days not worked." };
		weekend = rule.data;
	}
	return { ok: true, name, week, rules: { overtime, weekend } };
}

/** The organisation's default schedule on `today`, as Workspace settings sums it up. */
export function defaultScheduleSummary(book: ScheduleBook, today: Day, path: string) {
	const found = assignmentOn(book.assignments, "organisation", "", today);
	const schedule = found?.scheduleId ? book.schedules.get(found.scheduleId) : undefined;
	if (!schedule) return { name: "Standard", weekLabel: "Not set", path };
	return { name: schedule.name, weekLabel: weekLabel(versionOn(schedule, today).week), path };
}
