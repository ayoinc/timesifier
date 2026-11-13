import { describe, expect, it } from "vitest";

import type { RateRow } from "~/rates/rates";
import {
	marginOf,
	type ProfitExpense,
	type ProfitProject,
	profitability,
	spreadFee,
} from "~/reports/profitability";
import type { Row } from "~/reports/report";

// Profitability (TS-071, B6) against the rules of Harvest's own help article,
// "Profitability report" (docs/research/harvest-b2b.md, [profit]):
// - Time & Materials: revenue = billable hours × billable rates + billable
//   expenses; cost = time tracked × cost rates + every expense.
// - Fixed fee: revenue = fee ÷ the days from start to end × those days in the
//   range viewed; cost as above.
// - Non-billable: cost only.
// The fixtures are the article's arithmetic with round numbers, in pence.

const RANGE = { first: "2026-10-05", last: "2026-10-11" };
const ADA = "ada";
const LINUS = "linus";

function project(id: string, fields: Partial<ProfitProject> = {}): ProfitProject {
	return {
		id,
		name: id,
		client: null,
		billingType: "hourly",
		rateMode: "project",
		currency: "GBP",
		feeMinor: null,
		startsOn: null,
		endsOn: null,
		...fields,
	};
}

function rate(fields: Partial<RateRow> & Pick<RateRow, "kind" | "amountMinor">): RateRow {
	return {
		userId: null,
		projectId: null,
		taskId: null,
		currency: "GBP",
		effectiveFrom: "2026-01-01",
		...fields,
	};
}

let next = 0;
function row(
	userId: string,
	projectId: string,
	day: string,
	minutes: number,
	billable = true,
): Row {
	next += 1;
	const start = Date.parse(`${day}T09:00:00Z`);
	return {
		entry: {
			id: `e${next}`,
			userId,
			person: userId,
			projectId,
			project: projectId,
			clientId: null,
			client: null,
			day,
			description: null,
			startedAt: start,
			endedAt: start + minutes * 60_000,
			taskId: null,
			task: null,
			billable,
			overtime: false,
		},
		day,
		start,
		end: start + minutes * 60_000,
		running: false,
		minutes,
	};
}

const COST_RATES = [
	rate({ kind: "cost", userId: ADA, amountMinor: 40_00 }),
	rate({ kind: "cost", userId: LINUS, amountMinor: 30_00 }),
];

function run(
	projects: ProfitProject[],
	rows: Row[],
	{
		expenses = [] as ProfitExpense[],
		billableRates = [] as RateRow[],
		costRates = COST_RATES,
	} = {},
) {
	return profitability({
		projects: new Map(projects.map((p) => [p.id, p])),
		billableRates,
		costRates,
		currency: "GBP",
		range: RANGE,
		rows,
		expenses,
	});
}

describe("Time & Materials: revenue is billable hours × rate plus billable expenses", () => {
	it("prices billable time, costs all time, and adds every expense to cost", () => {
		const site = project("site");
		const { lines, totals } = run(
			[site],
			[
				// 3 billable hours of Ada's and 1 non-billable hour of Linus's.
				row(ADA, "site", "2026-10-05", 180),
				row(LINUS, "site", "2026-10-06", 60, false),
			],
			{
				billableRates: [rate({ kind: "billable", projectId: "site", amountMinor: 100_00 })],
				expenses: [
					{ projectId: "site", amountMinor: 50_00, currency: "GBP", billable: true },
					{ projectId: "site", amountMinor: 20_00, currency: "GBP", billable: false },
				],
			},
		);
		// Revenue: 3 h × £100 + £50 billable expense = £350.
		// Cost: 3 h × £40 + 1 h × £30 + £50 + £20 = £220.
		expect(lines).toEqual([
			expect.objectContaining({
				projectId: "site",
				revenueMinor: 350_00,
				costMinor: 220_00,
				profitMinor: 130_00,
			}),
		]);
		expect(totals).toEqual(
			expect.objectContaining({ revenueMinor: 350_00, costMinor: 220_00, profitMinor: 130_00 }),
		);
		expect(totals.margin).toBeCloseTo(130 / 350);
	});

	it("counts time with no billable rate as no revenue, and says how much", () => {
		const { lines } = run([project("site")], [row(ADA, "site", "2026-10-05", 90)]);
		expect(lines[0]).toEqual(
			expect.objectContaining({ revenueMinor: 0, costMinor: 60_00, missingRateSeconds: 90 * 60 }),
		);
	});

	it("counts time with no cost rate as costing nothing, and says how much", () => {
		const { lines } = run([project("site")], [row("grace", "site", "2026-10-05", 60)], {
			billableRates: [rate({ kind: "billable", projectId: "site", amountMinor: 100_00 })],
		});
		expect(lines[0]).toEqual(
			expect.objectContaining({ revenueMinor: 100_00, costMinor: 0, missingCostSeconds: 3600 }),
		);
	});

	it("uses the cost rate in force on the day of the time", () => {
		const { lines } = run(
			[project("site")],
			[row(ADA, "site", "2026-10-05", 60), row(ADA, "site", "2026-10-08", 60)],
			{
				costRates: [
					rate({ kind: "cost", userId: ADA, amountMinor: 40_00 }),
					rate({ kind: "cost", userId: ADA, amountMinor: 60_00, effectiveFrom: "2026-10-07" }),
				],
			},
		);
		expect(lines[0]?.costMinor).toBe(100_00);
	});
});

describe("Fixed fee: the fee spread evenly over the project's days", () => {
	// £3,000 over the 30 days of 1 to 30 October: £100 a day.
	const fixed = project("launch", {
		billingType: "fixed_fee",
		feeMinor: 3000_00,
		startsOn: "2026-10-01",
		endsOn: "2026-10-30",
	});

	it("earns the range's share of the fee, whatever time was tracked", () => {
		expect(spreadFee(fixed, RANGE)).toBe(700_00);
		const { lines } = run([fixed], [row(ADA, "launch", "2026-10-05", 120)]);
		// Revenue: 7 days × £100 = £700. Cost: 2 h × £40 = £80.
		expect(lines[0]).toEqual(
			expect.objectContaining({ revenueMinor: 700_00, costMinor: 80_00, profitMinor: 620_00 }),
		);
	});

	it("earns only the days of the range inside the project's dates", () => {
		expect(spreadFee(fixed, { first: "2026-10-26", last: "2026-11-08" })).toBe(500_00);
		expect(spreadFee(fixed, { first: "2026-11-02", last: "2026-11-08" })).toBe(0);
	});

	it("shows a fee earned in a range with no time tracked", () => {
		const { lines } = run([fixed], []);
		expect(lines[0]).toEqual(expect.objectContaining({ revenueMinor: 700_00, costMinor: 0 }));
	});

	it("knows no revenue without the fee or the dates", () => {
		expect(spreadFee({ ...fixed, endsOn: null }, RANGE)).toBeNull();
		expect(spreadFee({ ...fixed, feeMinor: null }, RANGE)).toBeNull();
		const { lines } = run([{ ...fixed, startsOn: null }], [row(ADA, "launch", "2026-10-05", 60)]);
		expect(lines[0]).toEqual(
			expect.objectContaining({ revenueMinor: null, profitMinor: null, missingFeeOrDates: true }),
		);
	});
});

describe("Non-billable: cost only", () => {
	it("has no revenue, and its billable expenses are cost", () => {
		const internal = project("internal", { billingType: "non_billable" });
		const { lines } = run([internal], [row(LINUS, "internal", "2026-10-05", 120)], {
			billableRates: [rate({ kind: "billable", projectId: "internal", amountMinor: 100_00 })],
			expenses: [{ projectId: "internal", amountMinor: 10_00, currency: "GBP", billable: true }],
		});
		expect(lines[0]).toEqual(
			expect.objectContaining({ revenueMinor: 0, costMinor: 70_00, profitMinor: -70_00 }),
		);
	});
});

describe("margin", () => {
	it("is profit over revenue, and unknown without revenue", () => {
		expect(marginOf(130_00, 350_00)).toBeCloseTo(0.3714, 4);
		expect(marginOf(-70_00, 0)).toBeNull();
		expect(marginOf(null, 100)).toBeNull();
	});
});
