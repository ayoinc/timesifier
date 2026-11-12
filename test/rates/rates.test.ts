import { describe, expect, it } from "vitest";
import {
	RATE_PRECEDENCE,
	type RateKind,
	type RateLevel,
	type RateQuery,
	type RateRow,
	rateLevel,
	resolveRate,
} from "~/rates/rates";
import { addDays } from "~/time/calendar";

// Hourly rates (TS-064, B5, B6): the most particular rate in force on the
// entry's own day wins, and a later rate never re-prices earlier work.

/** A small, seeded generator (mulberry32), so a failing case can be run again. */
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

function rate(fields: Partial<RateRow>): RateRow {
	return {
		kind: "billable",
		userId: null,
		projectId: null,
		taskId: null,
		amountMinor: 10_000,
		currency: "GBP",
		effectiveFrom: "2026-01-01",
		...fields,
	};
}

const work: RateQuery = {
	kind: "billable",
	userId: "ada",
	projectId: "apollo",
	taskId: "design",
	on: "2026-06-15",
};

describe("a rate's level", () => {
	it("follows from the ids it has set", () => {
		expect(rateLevel(rate({}))).toBe("organisation");
		expect(rateLevel(rate({ userId: "ada" }))).toBe("person");
		expect(rateLevel(rate({ projectId: "apollo" }))).toBe("project");
		expect(rateLevel(rate({ projectId: "apollo", userId: "ada" }))).toBe("project-person");
		expect(rateLevel(rate({ taskId: "design" }))).toBe("task");
		expect(rateLevel(rate({ projectId: "apollo", taskId: "design" }))).toBe("project-task");
	});

	it("does not exist for a person and a task at once", () => {
		expect(() => rateLevel(rate({ userId: "ada", taskId: "design" }))).toThrow(RangeError);
	});
});

describe("the rate in force", () => {
	const levels: RateRow[] = [
		rate({ amountMinor: 1 }),
		rate({ userId: "ada", amountMinor: 2 }),
		rate({ projectId: "apollo", amountMinor: 3 }),
		rate({ projectId: "apollo", userId: "ada", amountMinor: 4 }),
		rate({ taskId: "design", amountMinor: 5 }),
		rate({ projectId: "apollo", taskId: "design", amountMinor: 6 }),
	];

	it("is the most particular: project and task, task, project and person, project, person, organisation", () => {
		const remaining = [...levels];
		for (const expected of [6, 5, 4, 3, 2, 1]) {
			expect(resolveRate(remaining, work)?.amountMinor).toBe(expected);
			remaining.splice(
				remaining.findIndex((row) => row.amountMinor === expected),
				1,
			);
		}
		expect(resolveRate(remaining, work)).toBeNull();
		expect(RATE_PRECEDENCE).toEqual([
			"project-task",
			"task",
			"project-person",
			"project",
			"person",
			"organisation",
		]);
	});

	it("is not another project's, task's or person's", () => {
		const others = [
			rate({ userId: "bob", amountMinor: 2 }),
			rate({ projectId: "gemini", amountMinor: 3 }),
			rate({ projectId: "gemini", userId: "ada", amountMinor: 4 }),
			rate({ projectId: "apollo", userId: "bob", amountMinor: 4 }),
			rate({ taskId: "build", amountMinor: 5 }),
			rate({ projectId: "apollo", taskId: "build", amountMinor: 6 }),
			rate({ projectId: "gemini", taskId: "design", amountMinor: 6 }),
		];
		expect(resolveRate(others, work)).toBeNull();
		expect(resolveRate([...others, levels[0] as RateRow], work)?.amountMinor).toBe(1);
	});

	it("skips the levels whose ids the work lacks", () => {
		const query = { ...work, taskId: null };
		expect(resolveRate(levels, query)?.amountMinor).toBe(4);
		expect(resolveRate(levels, { ...query, userId: null })?.amountMinor).toBe(3);
		expect(resolveRate(levels, { ...query, userId: null, projectId: null })?.amountMinor).toBe(1);
	});

	it("is of the kind asked for", () => {
		const rows = [rate({ amountMinor: 1 }), rate({ kind: "cost", userId: "ada", amountMinor: 7 })];
		expect(resolveRate(rows, { ...work, kind: "cost" })?.amountMinor).toBe(7);
		expect(resolveRate(rows, work)?.amountMinor).toBe(1);
		expect(resolveRate([rows[1] as RateRow], work)).toBeNull();
	});

	it("is the latest that starts on or before the day, at each level", () => {
		const rows = [
			rate({ projectId: "apollo", effectiveFrom: "2026-01-01", amountMinor: 100 }),
			rate({ projectId: "apollo", effectiveFrom: "2026-06-15", amountMinor: 200 }),
			rate({ projectId: "apollo", effectiveFrom: "2026-03-01", amountMinor: 150 }),
			rate({ projectId: "apollo", effectiveFrom: "2026-09-01", amountMinor: 300 }),
		];
		expect(resolveRate(rows, { ...work, on: "2026-06-14" })?.amountMinor).toBe(150);
		expect(resolveRate(rows, { ...work, on: "2026-06-15" })?.amountMinor).toBe(200);
		expect(resolveRate(rows, { ...work, on: "2026-12-31" })?.amountMinor).toBe(300);
		expect(resolveRate(rows, { ...work, on: "2025-12-31" })).toBeNull();
	});

	it("falls through a level whose rates all start later", () => {
		const rows = [
			rate({ amountMinor: 1, effectiveFrom: "2020-01-01" }),
			rate({ projectId: "apollo", taskId: "design", amountMinor: 6, effectiveFrom: "2026-07-01" }),
		];
		expect(resolveRate(rows, work)?.amountMinor).toBe(1);
		expect(resolveRate(rows, { ...work, on: "2026-07-01" })?.amountMinor).toBe(6);
	});

	it("property: is the most particular level's latest rate on or before the day, found by brute force", () => {
		const next = random(5);
		const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)] as T;
		const users = ["ada", "bob", null];
		const projects = ["apollo", "gemini", null];
		const tasks = ["design", "build", null];
		const kinds: RateKind[] = ["billable", "cost"];
		for (let run = 0; run < 500; run++) {
			const rows: RateRow[] = [];
			for (let index = 0; index < Math.floor(next() * 25); index++) {
				const taskId = pick(tasks);
				rows.push(
					rate({
						kind: pick(kinds),
						userId: taskId === null ? pick(users) : null,
						projectId: pick(projects),
						taskId,
						amountMinor: index,
						effectiveFrom: addDays("2026-01-01", Math.floor(next() * 365)),
					}),
				);
			}
			const query: RateQuery = {
				kind: pick(kinds),
				userId: pick(users),
				projectId: pick(projects),
				taskId: pick(tasks),
				on: addDays("2026-01-01", Math.floor(next() * 365)),
			};
			const fits: Record<RateLevel, (row: RateRow) => boolean> = {
				"project-task": (row) =>
					query.projectId !== null &&
					query.taskId !== null &&
					row.projectId === query.projectId &&
					row.taskId === query.taskId,
				task: (row) =>
					row.projectId === null && query.taskId !== null && row.taskId === query.taskId,
				"project-person": (row) =>
					row.taskId === null &&
					query.projectId !== null &&
					query.userId !== null &&
					row.projectId === query.projectId &&
					row.userId === query.userId,
				project: (row) =>
					row.taskId === null &&
					row.userId === null &&
					query.projectId !== null &&
					row.projectId === query.projectId,
				person: (row) =>
					row.taskId === null &&
					row.projectId === null &&
					query.userId !== null &&
					row.userId === query.userId,
				organisation: (row) => row.taskId === null && row.projectId === null && row.userId === null,
			};
			let expected: RateRow | null = null;
			for (const level of RATE_PRECEDENCE) {
				const candidates = rows
					.filter((row) => row.kind === query.kind && row.effectiveFrom <= query.on)
					.filter(fits[level])
					.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
				if (candidates.length > 0) {
					expected = candidates[0] as RateRow;
					break;
				}
			}
			const found = resolveRate(rows, query);
			// Two rows of one level may share a start day here; the table forbids it, so compare days.
			expect(found === null).toBe(expected === null);
			if (found !== null && expected !== null) {
				expect(rateLevel(found)).toBe(rateLevel(expected));
				expect(found.effectiveFrom).toBe(expected.effectiveFrom);
			}
		}
	});

	it("property: a rate added later never re-prices work before it starts", () => {
		const next = random(6);
		for (let run = 0; run < 300; run++) {
			const rows = [
				rate({ amountMinor: 100, effectiveFrom: "2026-01-01" }),
				rate({
					userId: "ada",
					amountMinor: 200,
					effectiveFrom: addDays("2026-01-01", Math.floor(next() * 200)),
				}),
			];
			const before = Array.from({ length: 20 }, (_, index) =>
				resolveRate(rows, { ...work, on: addDays("2026-01-01", index * 18) }),
			);
			const starts = addDays("2026-01-01", Math.floor(next() * 365));
			const added = rate({
				projectId: "apollo",
				taskId: next() < 0.5 ? "design" : null,
				amountMinor: 999,
				effectiveFrom: starts,
			});
			before.forEach((was, index) => {
				const on = addDays("2026-01-01", index * 18);
				if (on < starts) expect(resolveRate([...rows, added], { ...work, on })).toEqual(was);
			});
		}
	});
});
