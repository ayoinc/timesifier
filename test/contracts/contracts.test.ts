import { describe, expect, it } from "vitest";

import {
	type Contract,
	type ContractTerms,
	type ContractVersion,
	contractAssignments,
	contractOwnsHours,
	leaveSentence,
	multipliersOf,
	overlapOf,
	overtimeSentence,
	spansOf,
} from "~/contracts/contracts";
import { contractorOn, covers, END_OF_TIME, overlaps, spanOn } from "~/contracts/spans";
import { contractsView } from "~/contracts/view";
import { BELOW_STATUTORY, belowStatutoryFloor, holidayMinutesOn } from "~/leave/entitlement";
import {
	ORGANISATION_RULES,
	type ScheduleBook,
	type ScheduleWeek,
	SINCE_EVER,
	STANDARD_WEEK,
	versionOn,
	weekOfMinutes,
} from "~/schedules/schedules";
import { addDays, type Day, daysFrom } from "~/time/calendar";

// Contracts as rules (TS-098a, research/contracts-model.md sections 1 and 2):
// when two share a day, which version holds on a day, the schedule a contract
// gives from today on, and who is a contractor on a day. Nothing here reads
// the database; test/pages/contracts.test.ts holds the server and the page.

/** A seeded generator (mulberry32), so a failing case can be run again. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const FIRST: Day = "2026-01-01";
/** The days the random spans fall in, and one either side of them. */
const WINDOW = daysFrom(addDays(FIRST, -1), addDays(FIRST, 61));

/** A run of days within the window: open a quarter of the time. */
function randomSpan(next: () => number) {
	const startsOn = addDays(FIRST, Math.floor(next() * 60));
	const endsOn = next() < 0.25 ? null : addDays(startsOn, Math.floor(next() * 20));
	return { startsOn, endsOn };
}

const TERMS: ContractTerms = {
	jobTitle: "Consultant",
	scheduleId: null,
	payBasis: "yearly",
	payMinor: 4_200_000,
	currency: "GBP",
	overtimePay: "unpaid",
	overtimeMultiplierBp: null,
	restDayMultiplierBp: null,
	leaveDays: 25,
	carryOverDays: 0,
	carryOverExpiresAfterDays: null,
};

function contract(
	more: Partial<Omit<Contract, "versions">> & { versions?: Partial<ContractVersion>[] } = {},
): Contract {
	const startsOn = more.startsOn ?? "2026-02-02";
	const versions = (more.versions ?? [{}]).map((v, index) => ({
		...TERMS,
		id: `v${index}`,
		effectiveFrom: index === 0 ? startsOn : (v.effectiveFrom ?? startsOn),
		...v,
	}));
	return {
		id: "c1",
		userId: "bea",
		kind: "permanent",
		startsOn,
		endsOn: null,
		endReason: null,
		worksNumber: null,
		priorDaysAtAllowance: false,
		...more,
		versions,
	};
}

describe("two contracts' days", () => {
	it("overlap exactly when some day is in both: a property over random pairs of spans", () => {
		const next = random(98_1);
		for (let run = 0; run < 2_000; run += 1) {
			const a = randomSpan(next);
			const b = randomSpan(next);
			// Two spans that share a day share the later of their first days, which is in the window.
			const shared = WINDOW.some((day) => covers(a, day) && covers(b, day));
			expect(overlaps(a, b), JSON.stringify({ a, b })).toBe(shared);
			expect(overlaps(b, a)).toBe(shared);
			// overlapOf finds the same one, and never the contract being changed.
			const found = overlapOf([{ id: "a", ...a }], b);
			expect(found?.id).toBe(shared ? "a" : undefined);
			expect(overlapOf([{ id: "a", ...a }], b, "a")).toBeUndefined();
		}
	});

	it("touch without overlapping when one ends the day before the other starts", () => {
		const ended = { startsOn: "2026-02-02", endsOn: "2026-03-31" };
		expect(overlaps(ended, { startsOn: "2026-04-01", endsOn: null })).toBe(false);
		expect(overlaps(ended, { startsOn: "2026-03-31", endsOn: null })).toBe(true);
		expect(overlaps({ startsOn: "2026-02-02", endsOn: null }, ended)).toBe(true);
		expect(covers({ startsOn: "2026-02-02", endsOn: null }, END_OF_TIME)).toBe(true);
	});
});

describe("a contract's versions", () => {
	it("a version from a later day changes no day before it: a property", () => {
		const next = random(98_2);
		const today: Day = "2026-01-20";
		for (let run = 0; run < 500; run += 1) {
			const { startsOn, endsOn } = randomSpan(next);
			const days = endsOn ? daysFrom(startsOn, endsOn) : daysFrom(startsOn, addDays(startsOn, 40));
			// Up to three versions on distinct days of the contract, each with or without a schedule.
			const froms = [...new Set([startsOn, ...days.filter(() => next() < 0.1).slice(0, 2)])].sort();
			const before = contract({
				startsOn,
				endsOn,
				versions: froms.map((effectiveFrom, i) => ({
					effectiveFrom,
					payMinor: 1000 * (i + 1),
					scheduleId: next() < 0.5 ? `s${i}` : null,
				})),
			});
			const from = days[Math.floor(next() * days.length)] ?? startsOn;
			const changed: ContractVersion = {
				...TERMS,
				id: "new",
				effectiveFrom: from,
				payMinor: 99,
				scheduleId: next() < 0.5 ? "later" : null,
			};
			const after: Contract = {
				...before,
				versions: [...before.versions.filter((v) => v.effectiveFrom !== from), changed].sort(
					(x, y) => (x.effectiveFrom < y.effectiveFrom ? -1 : 1),
				),
			};
			const label = JSON.stringify({ froms, from, startsOn, endsOn });
			for (const day of days.filter((d) => d < from)) {
				expect(versionOn(after, day), `${label} ${day}`).toEqual(versionOn(before, day));
				expect(contractOwnsHours([after], day)).toBe(contractOwnsHours([before], day));
			}
			expect(versionOn(after, from)).toBe(changed);
			// The schedules it gives before that day are the same, as are its days.
			const earlier = (c: Contract) => contractAssignments([c], today).filter((a) => a.from < from);
			expect(earlier(after), label).toEqual(earlier(before));
		}
	});

	it("the one that holds on a day is the latest from it or before", () => {
		const c = contract({
			versions: [{}, { effectiveFrom: "2026-04-06", payMinor: 4_400_000 }],
		});
		expect(versionOn(c, "2026-04-05").payMinor).toBe(4_200_000);
		expect(versionOn(c, "2026-04-06").payMinor).toBe(4_400_000);
		expect(versionOn(c, "2027-01-01").payMinor).toBe(4_400_000);
	});
});

describe("the schedule a contract gives", () => {
	const today: Day = "2026-03-02";

	it("is a person assignment from the later of its day and today", () => {
		expect(contractAssignments([contract({ versions: [{ scheduleId: "part" }] })], today)).toEqual([
			{ from: today, scheduleId: "part", sourceId: "v0" },
		]);
		expect(
			contractAssignments(
				[contract({ startsOn: "2026-04-01", versions: [{ scheduleId: "part" }] })],
				today,
			),
		).toEqual([{ from: "2026-04-01", scheduleId: "part", sourceId: "v0" }]);
	});

	it("is taken away the day after the contract ends, so the person falls back", () => {
		const ended = contract({ endsOn: "2026-03-31", versions: [{ scheduleId: "part" }] });
		expect(contractAssignments([ended], today)).toEqual([
			{ from: today, scheduleId: "part", sourceId: "v0" },
			{ from: "2026-04-01", scheduleId: null, sourceId: "v0" },
		]);
		// Ended before today: nothing is written, as days gone keep theirs.
		expect(contractAssignments([{ ...ended, endsOn: "2026-02-28" }], today)).toEqual([]);
	});

	it("is taken away by a version with none after one with a schedule, and a version with none after none writes nothing", () => {
		const c = contract({
			versions: [
				{ scheduleId: "part" },
				{ effectiveFrom: "2026-05-01", scheduleId: null },
				{ effectiveFrom: "2026-06-01", scheduleId: null },
			],
		});
		expect(contractAssignments([c], today)).toEqual([
			{ from: today, scheduleId: "part", sourceId: "v0" },
			{ from: "2026-05-01", scheduleId: null, sourceId: "v1" },
		]);
		expect(contractAssignments([contract()], today)).toEqual([]);
	});

	it("owns the hours only on a day a contract covers whose terms name a schedule", () => {
		const c = contract({
			endsOn: "2026-12-31",
			versions: [{}, { effectiveFrom: "2026-06-01", scheduleId: "part" }],
		});
		expect(contractOwnsHours([c], "2026-05-31")).toBe(false);
		expect(contractOwnsHours([c], "2026-06-01")).toBe(true);
		expect(contractOwnsHours([c], "2027-01-01")).toBe(false);
		expect(contractOwnsHours([], "2026-06-01")).toBe(false);
	});
});

describe("who is a contractor on a day", () => {
	it("is the kind of the contract that covers it, and the mark on the membership on a day none does", () => {
		const spans = spansOf([
			contract({ kind: "contractor", startsOn: "2026-01-01", endsOn: "2026-03-31" }),
			contract({ kind: "permanent", startsOn: "2026-04-01" }),
		]);
		expect(contractorOn(spans, false, "2026-02-01")).toBe(true);
		expect(contractorOn(spans, true, "2026-04-01")).toBe(false);
		expect(contractorOn(spans, true, "2025-12-31")).toBe(true);
		expect(contractorOn(spans, false, "2025-12-31")).toBe(false);
		expect(contractorOn(undefined, true, "2026-02-01")).toBe(true);
		expect(spanOn(spans, "2026-04-01")?.contractor).toBe(false);
	});
});

describe("a contract in words", () => {
	const book: ScheduleBook = {
		schedules: new Map([
			[
				"standard",
				{
					id: "standard",
					name: "Standard",
					archived: false,
					versions: [{ effectiveFrom: SINCE_EVER, week: STANDARD_WEEK, ...ORGANISATION_RULES }],
				},
			],
			[
				"part",
				{
					id: "part",
					name: "Three days",
					archived: false,
					versions: [
						{
							effectiveFrom: SINCE_EVER,
							week: [...STANDARD_WEEK.slice(0, 3), null, null, null, null],
							...ORGANISATION_RULES,
						},
					],
				},
			],
		]),
		assignments: [
			{
				id: "a",
				scheduleId: "standard",
				targetKind: "organisation",
				targetId: "",
				effectiveFrom: SINCE_EVER,
				sourceKind: "manual",
				sourceId: null,
				createdAt: 0,
			},
		],
	};
	const paid = contract({
		worksNumber: "W-7",
		versions: [
			{
				scheduleId: "part",
				overtimePay: "paid",
				...multipliersOf({
					overtimePay: "paid",
					overtimeMultiplier: 15000,
					restDayMultiplier: 20000,
				}),
			},
			{
				effectiveFrom: "2026-04-06",
				scheduleId: "part",
				payMinor: 4_400_000,
				overtimePay: "paid",
				overtimeMultiplierBp: 15000,
			},
		],
	});

	it("says the pay, the multipliers and the works number to those who see pay", () => {
		const view = contractsView([paid], book, "2026-03-02", true, false);
		expect(view.current?.heading).toBe("Permanent, part time, from Monday 2 February 2026.");
		expect(view.current?.lines).toEqual([
			"Consultant.",
			"Works 22:30 a week on Three days.",
			"Overtime is paid at time and a half; on days off and public holidays, double time.",
			"Annual leave: 25 days a year for a full week, plus public holidays.",
			"Paid £42,000.00 a year.",
			"Works number W-7.",
		]);
		expect(view.current?.changes).toEqual([
			"From Monday 6 April 2026: £44,000.00 a year; days off at the overtime rate.",
		]);
	});

	it("leaves out every amount, multiplier and works number, and a change only of pay, for a manager", () => {
		const view = contractsView([paid], book, "2026-03-02", false, false);
		const words = JSON.stringify(view.current);
		expect(words).not.toMatch(/£|44,000|42,000|time and a half|double time|W-7/);
		expect(view.current?.lines).toContain("Overtime is paid.");
		// Its second version changed pay and multipliers alone.
		expect(view.current?.changes).toEqual([]);
	});

	it("says overtime and leave in a sentence", () => {
		expect(overtimeSentence(TERMS, true)).toBe("Overtime is recorded and not paid.");
		expect(
			overtimeSentence(
				{ overtimePay: "toil", overtimeMultiplierBp: 15000, restDayMultiplierBp: null },
				true,
			),
		).toBe("Overtime becomes time off in lieu at time and a half.");
		const terms = { leaveDays: 1, carryOverDays: 0, carryOverExpiresAfterDays: null };
		expect(leaveSentence({ ...terms, leaveDays: null }, false)).toBe(
			"Annual leave: the allowance of the kind of leave.",
		);
		expect(leaveSentence(terms, false)).toBe(
			"Annual leave: 1 day a year for a full week, plus public holidays.",
		);
		// Where public holidays come out of annual leave (TS-098b), and what carries over.
		expect(leaveSentence({ ...terms, leaveDays: 25 }, true)).toBe(
			"Annual leave: 25 days a year for a full week, public holidays included.",
		);
		expect(
			leaveSentence({ leaveDays: 25, carryOverDays: 5, carryOverExpiresAfterDays: 90 }, false),
		).toBe(
			"Annual leave: 25 days a year for a full week, plus public holidays. Up to 5 days left at a year's end carry over, for 90 days of the next leave year.",
		);
		expect(multipliersOf({ overtimePay: "unpaid", overtimeMultiplier: 15000 })).toEqual({
			overtimeMultiplierBp: null,
			restDayMultiplierBp: null,
		});
		expect(multipliersOf({ overtimePay: "toil" })).toEqual({
			overtimeMultiplierBp: 10000,
			restDayMultiplierBp: null,
		});
	});
});

// The statutory floor (TS-098b, research/contracts-model.md section 3), from
// gov.uk, Holiday entitlement (https://www.gov.uk/holiday-entitlement-rights):
// "Almost all people classed as workers are legally entitled to 5.6 weeks'
// paid holiday a year"; "Statutory paid holiday entitlement is limited to 28
// days. For example, staff working 6 days a week are only entitled to 28
// days' paid holiday."; "An employer can choose to include bank holidays as
// part of a worker's statutory annual leave."
describe("statutory floor", () => {
	const FIVE = weekOfMinutes([450, 450, 450, 450, 450, 0, 0]);
	const THREE = weekOfMinutes([450, 450, 450, 0, 0, 0, 0]);
	const SIX = weekOfMinutes([450, 450, 450, 450, 450, 450, 0]);
	/** England and Wales's eight bank holidays of 2026, each on a weekday. */
	const BANK_HOLIDAYS: Day[] = [
		"2026-01-01",
		"2026-04-03",
		"2026-04-06",
		"2026-05-04",
		"2026-05-25",
		"2026-08-31",
		"2026-12-25",
		"2026-12-28",
	];
	const below = (leaveDays: number, week: ScheduleWeek, holidaysFromAllowance: boolean) =>
		belowStatutoryFloor({
			leaveDays,
			week,
			holidayMinutes: holidayMinutesOn(week, BANK_HOLIDAYS),
			holidaysFromAllowance,
		});

	it("warns below 5.6 weeks, counting public holidays where they are on top", () => {
		// 20 days and the 8 bank holidays on top are 28 days: 5.6 weeks of five days.
		expect(below(20, FIVE, false)).toBe(false);
		expect(below(19, FIVE, false)).toBe(true);
		// Where public holidays come out of annual leave, the 28 days are all in it.
		expect(below(20, FIVE, true)).toBe(true);
		expect(below(28, FIVE, true)).toBe(false);
	});

	it("pro rata on a part-time week: 5.6 weeks of three days is 16.8 days", () => {
		// gov.uk: "if they work 3 days a week, they must get at least 16.8 days' leave a year (3 × 5.6)".
		// 28 a year for a full week is 16.8 of hers; 27 is 16.2.
		expect(below(28, THREE, true)).toBe(false);
		expect(below(27, THREE, true)).toBe(true);
		// The five bank holidays on her Mondays count on top: 20 ÷ 5 × 22:30 is
		// 90 hours, and 37:30 of holidays make 127:30, over 5.6 × 22:30 = 126.
		expect(holidayMinutesOn(THREE, BANK_HOLIDAYS)).toBe(5 * 450);
		expect(below(20, THREE, false)).toBe(false);
		expect(below(19, THREE, false)).toBe(true);
	});

	it("caps the floor at 28 days on a six-day week", () => {
		// 5.6 weeks of six days is 33.6 days; the floor is 28 of them, 210 hours.
		// 24 a year for a full week is 24 ÷ 5 × 45:00 = 216 hours; 23 is 207.
		expect(below(24, SIX, true)).toBe(false);
		expect(below(23, SIX, true)).toBe(true);
	});

	it("says so in a sentence citing gov.uk, and never for a week with no working day", () => {
		expect(BELOW_STATUTORY).toBe(
			"This is less than the 5.6 weeks' paid holiday UK law gives (gov.uk, Holiday entitlement).",
		);
		expect(below(0, weekOfMinutes([0, 0, 0, 0, 0, 0, 0]), true)).toBe(false);
	});
});
