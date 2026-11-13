import { describe, expect, it } from "vitest";

import {
	balance,
	dayStatus,
	expectedMinutes,
	halfDaysTaken,
	type LeaveRequestLike,
} from "~/leave/days";
import {
	dayLimit,
	earliestNoticed,
	isShortNotice,
	mayWrite,
	type RulesCalendar,
	rulesOn,
} from "~/leave/rules";
import { readSchedule } from "~/schedules/forms";
import {
	type Assignment,
	dayOfMinutes,
	hoursLabel,
	isWorkedDay,
	LONG_WEEK,
	ORGANISATION_RULES,
	type PersonPlace,
	parseClock,
	resolve,
	type Schedule,
	type ScheduleBook,
	type ScheduleRules,
	type ScheduleWeek,
	SINCE_EVER,
	STANDARD_WEEK,
	scheduleView,
	sourceLabel,
	timetableOf,
	versionOn,
	weekLabel,
	weekly,
	weekOfMinutes,
	weekTotal,
	workedMinutes,
} from "~/schedules/schedules";
import { addDays, bounds, type Day, daysFrom } from "~/time/calendar";

// Work schedules (TS-097) without the database: what a day expects, which
// schedule a person has on a day and why, and how leave, overtime and notice
// read it.

const MONDAY = "2026-11-09";
const WEDNESDAY = "2026-11-11";
const SATURDAY = "2026-11-14";

let made = 0;
function schedule(
	name: string,
	...versions: [Day, ScheduleWeek, Partial<ScheduleRules>?][]
): Schedule {
	return {
		id: `s-${name}`,
		name,
		archived: false,
		versions: versions.map(([effectiveFrom, week, rules]) => ({
			effectiveFrom,
			week,
			...ORGANISATION_RULES,
			...rules,
		})),
	};
}

function assignment(
	targetKind: Assignment["targetKind"],
	targetId: string,
	scheduleId: string | null,
	effectiveFrom: Day = SINCE_EVER,
): Assignment {
	made += 1;
	return {
		id: `a-${made}`,
		targetKind,
		targetId,
		scheduleId,
		effectiveFrom,
		sourceKind: "manual",
		sourceId: null,
		createdAt: made,
	};
}

function book(schedules: Schedule[], assignments: Assignment[]): ScheduleBook {
	return { schedules: new Map(schedules.map((s) => [s.id, s])), assignments };
}

const STANDARD = schedule("Standard", [SINCE_EVER, STANDARD_WEEK]);
const LONG = schedule("Long", [SINCE_EVER, LONG_WEEK]);
const SHORT = schedule("Short", [SINCE_EVER, weekOfMinutes([300, 300, 300, 0, 0, 0, 0])]);
const ORG = assignment("organisation", "", STANDARD.id);

const ada: PersonPlace = {
	userId: "ada",
	role: "member",
	contractor: false,
	manager: false,
	teams: [
		{ id: "design", name: "Design" },
		{ id: "build", name: "Build" },
	],
};

describe("a schedule's day", () => {
	it("expects its finish less its start less its break", () => {
		expect(workedMinutes({ start: 540, finish: 1050, breakMinutes: 60 })).toBe(450);
		expect(workedMinutes(null)).toBe(0);
		expect(weekTotal(STANDARD_WEEK)).toBe(37.5 * 60);
		expect(weekTotal(LONG_WEEK)).toBe(40 * 60);
	});

	it("puts Standard and Long in words", () => {
		expect(weekLabel(STANDARD_WEEK)).toBe("Monday to Friday, 09:00–17:30 · 37:30 a week");
		expect(weekLabel(LONG_WEEK)).toBe("Monday to Friday, 09:00–18:00 · 40:00 a week");
		expect(weekLabel(weekOfMinutes([480, 450, 0, 0, 0, 0, 0]))).toBe("15:30 a week");
	});

	it("reads clock times, and refuses what is none", () => {
		expect(parseClock("9:00")).toBe(540);
		expect(parseClock("17:30")).toBe(1050);
		expect(parseClock("24:00")).toBe(1440);
		for (const text of ["", "9", "9:60", "25:00", "nine"])
			expect(parseClock(text), text).toBeNull();
	});

	it("keeps a migrated week's minutes exactly, from 09:00, with an hour's break past six hours (a property)", () => {
		for (let minutes = 0; minutes <= 1440; minutes += 1) {
			const day = dayOfMinutes(minutes);
			if (minutes === 0) {
				expect(day).toBeNull();
				continue;
			}
			expect(day, `${minutes}`).not.toBeNull();
			if (!day) continue;
			expect(isWorkedDay(day), `${minutes}`).toBe(true);
			expect(workedMinutes(day), `${minutes}`).toBe(minutes);
			expect(day.finish).toBeLessThanOrEqual(1440);
		}
		expect(dayOfMinutes(450)).toEqual({ start: 540, finish: 1050, breakMinutes: 60 });
		expect(dayOfMinutes(240)).toEqual({ start: 540, finish: 780, breakMinutes: 0 });
	});

	it("expects the same minutes on a day the clocks change, whatever the day's length", () => {
		const everyDay = weekly(weekOfMinutes([450, 450, 450, 450, 450, 450, 450]));
		for (const day of ["2026-03-29", "2026-10-25", "2026-11-01"]) {
			const { from, to } = bounds(day, day, "Europe/London");
			const length = (to - from) / 60_000;
			expect([1380, 1440, 1500]).toContain(length);
			expect(everyDay(day).minutes, day).toBe(450);
			expect(hoursLabel(everyDay(day).worked ?? { start: 0, finish: 0, breakMinutes: 0 })).toBe(
				"09:00–17:30",
			);
		}
	});
});

describe("which schedule a person has", () => {
	it("is the organisation's default, with nothing else", () => {
		const found = resolve(book([STANDARD], [ORG]), ada, MONDAY);
		expect(found.schedule.name).toBe("Standard");
		expect(found.source).toEqual({ level: "organisation" });
		expect(sourceLabel(found.source)).toBe("The organisation's default");
	});

	it("is the most specific: person over team over role over organisation", () => {
		const all = [STANDARD, LONG, SHORT, schedule("Role", [SINCE_EVER, STANDARD_WEEK])];
		const role = assignment("role", "member", "s-Role");
		const team = assignment("team", "design", LONG.id);
		const own = assignment("person", "ada", SHORT.id);
		expect(resolve(book(all, [ORG, role]), ada, MONDAY).schedule.name).toBe("Role");
		expect(resolve(book(all, [ORG, role, team]), ada, MONDAY).schedule.name).toBe("Long");
		const mine = resolve(book(all, [ORG, role, team, own]), ada, MONDAY);
		expect(mine.schedule.name).toBe("Short");
		expect(sourceLabel(mine.source, true)).toBe("Assigned to you");
	});

	it("reads contractor, then manager, then the role", () => {
		const all = [STANDARD, LONG, SHORT];
		const assignments = [
			ORG,
			assignment("role", "member", STANDARD.id),
			assignment("role", "manager", LONG.id),
			assignment("role", "contractor", SHORT.id),
		];
		const place = { ...ada, teams: [] };
		expect(resolve(book(all, assignments), place, MONDAY).source).toEqual({
			level: "role",
			role: "member",
		});
		expect(resolve(book(all, assignments), { ...place, manager: true }, MONDAY).schedule.name).toBe(
			"Long",
		);
		expect(
			resolve(book(all, assignments), { ...place, manager: true, contractor: true }, MONDAY)
				.schedule.name,
		).toBe("Short");
	});

	it("of two teams, is the one with more weekly hours, then the team named first, and says why", () => {
		const both = [
			ORG,
			assignment("team", "design", STANDARD.id),
			assignment("team", "build", LONG.id),
		];
		const found = resolve(book([STANDARD, LONG], both), ada, MONDAY);
		expect(found.schedule.name).toBe("Long");
		expect(sourceLabel(found.source)).toBe(
			"From the team Build: of their teams with a schedule, it has the most weekly hours (also Design (Standard))",
		);
		const same = [
			ORG,
			assignment("team", "design", STANDARD.id),
			assignment("team", "build", STANDARD.id),
		];
		const tie = resolve(book([STANDARD], same), ada, MONDAY);
		expect(tie.source).toMatchObject({ level: "team", teamName: "Build" });
	});

	it("follows the dates: an assignment holds from its day, and taking one away gives the next level", () => {
		const assignments = [
			ORG,
			assignment("person", "ada", LONG.id, "2026-11-11"),
			assignment("person", "ada", null, "2026-11-13"),
		];
		const shelf = book([STANDARD, LONG], assignments);
		expect(resolve(shelf, ada, "2026-11-10").schedule.name).toBe("Standard");
		expect(resolve(shelf, ada, WEDNESDAY).schedule.name).toBe("Long");
		expect(resolve(shelf, ada, "2026-11-12").source).toEqual({ level: "person" });
		expect(resolve(shelf, ada, "2026-11-13").schedule.name).toBe("Standard");
	});

	it("keeps the version in force on each day: a past day is what it was", () => {
		const changing = schedule(
			"Changing",
			[SINCE_EVER, STANDARD_WEEK],
			["2026-11-11", LONG_WEEK, { overtime: { policy: "allowed", dayCap: 60, weekCap: null } }],
		);
		expect(versionOn(changing, "2026-11-10").week).toBe(STANDARD_WEEK);
		expect(versionOn(changing, WEDNESDAY).week).toBe(LONG_WEEK);
		const times = timetableOf(book([changing], [assignment("organisation", "", changing.id)]), ada);
		expect(times("2026-11-10").minutes).toBe(450);
		expect(times(WEDNESDAY).minutes).toBe(480);
		expect(times(WEDNESDAY).rules.overtime).toEqual({
			policy: "allowed",
			dayCap: 60,
			weekCap: null,
		});
		expect(times("2026-11-10").rules.overtime).toBeNull();
	});

	it("tells My account of the next change", () => {
		const assignments = [ORG, assignment("person", "ada", LONG.id, "2026-12-01")];
		const view = scheduleView(book([STANDARD, LONG], assignments), ada, MONDAY, true);
		expect(view).toMatchObject({
			name: "Standard",
			reason: "The organisation's default",
			level: "organisation",
			next: { from: "2026-12-01", name: "Long" },
		});
		expect(view.days[0]).toEqual({ name: "Monday", hours: "09:00–17:30, 1:00 break · 7:30" });
		expect(view.days[6]).toEqual({ name: "Sunday", hours: "Not a working day" });
	});
});

/** A seeded random number from 0 to 1 (mulberry32). */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("a property of every book of schedules", () => {
	const ROLES = ["owner", "admin", "finance", "member"] as const;
	for (let seed = 1; seed <= 150; seed++) {
		it(`holds for book ${seed}`, () => {
			const next = random(seed);
			const int = (n: number) => Math.floor(next() * n);
			const origin = "2026-01-05";
			const schedules = Array.from({ length: 1 + int(4) }, (_, i) =>
				schedule(
					`S${i}`,
					[
						SINCE_EVER,
						weekOfMinutes(Array.from({ length: 7 }, () => (int(3) === 0 ? 0 : 60 * (1 + int(10))))),
					],
					...Array.from({ length: int(3) }, (_, v): [Day, ScheduleWeek] => [
						addDays(origin, 30 * (v + 1) + int(20)),
						weekOfMinutes(Array.from({ length: 7 }, () => 30 * int(20))),
					]).sort((a, b) => a[0].localeCompare(b[0])),
				),
			);
			const pick = () => schedules[int(schedules.length)]?.id ?? null;
			const targets: [Assignment["targetKind"], string][] = [
				["person", "ada"],
				["team", "design"],
				["team", "build"],
				["role", ROLES[int(4)] ?? "member"],
				["role", "manager"],
			];
			const assignments = [assignment("organisation", "", pick())];
			for (let i = int(8); i > 0; i--) {
				const [kind, id] = targets[int(targets.length)] ?? ["person", "ada"];
				assignments.push(
					assignment(kind, id, int(4) === 0 ? null : pick(), addDays(origin, int(200))),
				);
			}
			const place: PersonPlace = { ...ada, role: ROLES[int(4)] ?? "member", manager: int(2) === 0 };
			const shelf = book(schedules, assignments);
			const times = timetableOf(shelf, place);

			for (const day of daysFrom(origin, addDays(origin, 220))) {
				const found = resolve(shelf, place, day);
				// The schedule found is one of the organisation's, its version in force that day.
				expect(shelf.schedules.get(found.schedule.id)).toBe(found.schedule);
				expect(
					found.version.effectiveFrom <= day || found.version === found.schedule.versions[0],
				).toBe(true);
				// A person's own assignment in force always wins.
				const own = assignments
					.filter((a) => a.targetKind === "person" && a.effectiveFrom <= day)
					.sort(
						(a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.createdAt - b.createdAt,
					)
					.at(-1);
				if (own?.scheduleId) expect(found.schedule.id).toBe(own.scheduleId);
				else expect(found.source.level).not.toBe("person");
				// The timetable says what the version says.
				expect(times(day).minutes).toBe(
					workedMinutes(found.version.week[(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7]),
				);
			}

			// Adding an assignment from a later day changes nothing before it.
			const from = addDays(origin, 100 + int(100));
			const later = book(schedules, [...assignments, assignment("person", "ada", pick(), from)]);
			const laterTimes = timetableOf(later, place);
			for (const day of daysFrom(origin, addDays(from, -1))) {
				expect(laterTimes(day).minutes, day).toBe(times(day).minutes);
			}
		});
	}
});

describe("leave, overtime and notice on a person's schedule", () => {
	const threeDays = weekly(weekOfMinutes([480, 480, 480, 0, 0, 0, 0]));
	const request = (startsOn: Day, endsOn: Day, half = false): LeaveRequestLike => ({
		userId: "ada",
		kindKey: "annual",
		kindName: "Annual leave",
		status: "approved",
		startsOn,
		endsOn,
		startsHalf: half,
		endsHalf: false,
	});

	it("counts leave on the days the person works, and a half day as half that day's hours", () => {
		const calendar = { timetable: threeDays, holidays: new Map<Day, string>(), leave: [] };
		// A whole week off takes the three days the schedule works.
		expect(halfDaysTaken(request(MONDAY, "2026-11-15"), calendar)).toBe(6);
		const half = { ...calendar, leave: [request(MONDAY, MONDAY, true)] };
		expect(dayStatus(half, MONDAY).expectedMinutes).toBe(240);
		const long = weekly(LONG_WEEK);
		expect(
			dayStatus(
				{ timetable: long, holidays: new Map(), leave: [request(MONDAY, MONDAY, true)] },
				MONDAY,
			).expectedMinutes,
		).toBe(240);
		expect(
			expectedMinutes(
				{ timetable: long, holidays: new Map(), leave: [] },
				daysFrom(MONDAY, "2026-11-15"),
			),
		).toBe(2400);
	});

	it("takes a balance in the person's working days", () => {
		const calendar = { timetable: threeDays, holidays: new Map<Day, string>() };
		const { approved, left } = balance(50, [request(MONDAY, "2026-11-22")], 2026, calendar);
		expect(approved).toBe(12);
		expect(left).toBe(38);
	});

	it("counts notice in calendar days, whatever the schedule", () => {
		const kind = { key: "annual" as const, noticeDays: 14 };
		expect(earliestNoticed(kind, MONDAY)).toBe(addDays(MONDAY, 14));
		expect(isShortNotice(kind, MONDAY, addDays(MONDAY, 13))).toBe(true);
	});

	const rulesCalendar = (timetable = weekly(STANDARD_WEEK)): RulesCalendar => ({
		timetable,
		holidays: new Map(),
		leave: [],
		rules: {
			overtime: "none",
			weekend: "overtime",
			overtimeDayCap: null,
			overtimeWeekCap: null,
			weekStartsOn: 1,
		},
		work: [],
	});

	it("takes the schedule's own overtime rule and caps, else the organisation's", () => {
		const organisation = rulesCalendar();
		expect(dayLimit(organisation, MONDAY).noOvertime).toBeTruthy();
		const own = rulesCalendar(
			weekly(STANDARD_WEEK, {
				overtime: { policy: "allowed", dayCap: 60, weekCap: 120 },
				weekend: "none",
			}),
		);
		expect(rulesOn(own, MONDAY)).toMatchObject({
			overtime: "allowed",
			overtimeDayCap: 60,
			overtimeWeekCap: 120,
			weekend: "none",
		});
		const limit = dayLimit(own, MONDAY);
		expect(limit.noOvertime).toBeFalsy();
		expect(limit.overtimeMinutes).toBe(60);
		// A day the schedule does not work: its own rule allows nothing there.
		expect(dayLimit(own, SATURDAY).closed).toBeTruthy();
		expect(dayLimit(organisation, SATURDAY).closed).toBeFalsy();
	});

	it("lets a day's total, not its clock times, meet the ceiling", () => {
		const own = rulesCalendar(weekly(STANDARD_WEEK));
		const limit = dayLimit(own, MONDAY);
		const fresh = {
			beforeMs: 0,
			othersMs: 0,
			weekOvertimeBefore: 0,
			weekOvertimeAfter: 0,
			overtime: false,
		};
		// 7:30 at any time of day is within the day; 7:31 is not.
		expect(mayWrite(limit, own.rules, { ...fresh, afterMs: 450 * 60_000 }).ok).toBe(true);
		expect(mayWrite(limit, own.rules, { ...fresh, afterMs: 451 * 60_000 }).ok).toBe(false);
	});
});

describe("a schedule's form", () => {
	const DAYS = Object.fromEntries(
		[1, 2, 3, 4, 5].flatMap((n) => [
			[`worked${n}`, "on"],
			[`start${n}`, "09:00"],
			[`finish${n}`, "17:30"],
			[`break${n}`, "60"],
		]),
	);

	it("reads Standard", () => {
		const read = readSchedule({
			name: " Standard ",
			overtime: "organisation",
			weekend: "organisation",
			...DAYS,
		});
		expect(read).toEqual({
			ok: true,
			name: "Standard",
			week: STANDARD_WEEK,
			rules: ORGANISATION_RULES,
		});
	});

	it("reads its own rules", () => {
		const read = readSchedule({
			name: "Nights",
			overtime: "allowed",
			overtimeDayCap: "1:30",
			overtimeWeekCap: "",
			weekend: "none",
			...DAYS,
		});
		expect(read).toMatchObject({
			ok: true,
			rules: { overtime: { policy: "allowed", dayCap: 90, weekCap: null }, weekend: "none" },
		});
	});

	it.each([
		[{ name: "" }, "Enter a name"],
		[
			{
				worked1: undefined,
				worked2: undefined,
				worked3: undefined,
				worked4: undefined,
				worked5: undefined,
			},
			"at least one day",
		],
		[{ finish1: "08:00" }, "Monday finishes before it starts"],
		[{ start2: "nine" }, "Tuesday's start and finish"],
		[{ break3: "600" }, "Wednesday's break is as long as the day"],
		[{ break4: "-5" }, "Thursday's break in whole minutes"],
		[{ overtime: "sometimes" }, "Choose an overtime rule"],
		[{ overtime: "allowed", overtimeDayCap: "lots" }, "Type hours as 2 or 1:30"],
	])("refuses %o", (change, problem) => {
		const read = readSchedule({
			name: "Nights",
			overtime: "organisation",
			weekend: "organisation",
			...DAYS,
			...change,
		});
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.problem).toContain(problem);
	});
});
