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
import {
	ORGANISATION_RULES,
	type ScheduleBook,
	SINCE_EVER,
	STANDARD_WEEK,
	versionOn,
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
		const view = contractsView([paid], book, "2026-03-02", true);
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
		const view = contractsView([paid], book, "2026-03-02", false);
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
		expect(leaveSentence(null)).toBe("Annual leave: the allowance of the kind of leave.");
		expect(leaveSentence(1)).toBe(
			"Annual leave: 1 day a year for a full week, plus public holidays.",
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
