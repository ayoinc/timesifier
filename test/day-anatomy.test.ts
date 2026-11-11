import { expect, it } from "vitest";

import { box, onFace, type Projection, project, round3 } from "~/anatomy/iso";
import {
	ADDED_RAIL_HOURS,
	DAY_HOUR,
	dayRails,
	WEEK_HOUR,
	WEEK_LANES,
	WEEK_LENGTH,
	WEEK_RAIL_HOURS,
	WENT_RAIL_HOURS,
} from "~/landing/day-anatomy";
import { LOGGED_ENTRIES, length, RHYTHM, week, weekTotal } from "~/landing/example-week";
import { begin, dayAt, EXAMPLE_DAY } from "~/landing/running-day";

// The anatomy of a working day is a measuring instrument: a length in it is a
// time. These hold the figure to the same example the tables on the page add up.

const dayMinutes = (from: number, to: number) => ((to - from) / DAY_HOUR) * 60;
const weekMinutes = (from: number, to: number) => ((to - from) / WEEK_HOUR) * 60;

it("as it went: the running stretch is at the timer, and each finished stretch is as long as its time", () => {
	const { went } = dayRails(EXAMPLE_DAY);

	expect(went.running.from).toBe(0);
	expect(dayMinutes(0, went.running.to) * 60).toBeCloseTo(EXAMPLE_DAY.elapsed);
	// The newest lies nearest the timer.
	expect(went.entries.map(({ from, to }) => Math.round(dayMinutes(from, to)))).toEqual(
		[...LOGGED_ENTRIES].reverse().map(length),
	);
});

it("as it went: the bare rail between stretches is the breaks, a longer one after the fourth stretch", () => {
	const { went } = dayRails(EXAMPLE_DAY);
	const breaks = went.breaks.map(({ from, to }) => Math.round(dayMinutes(from, to)));

	// Newest first: the longer break before the running stretch, then the short ones.
	expect(breaks.slice(0, 3)).toEqual([RHYTHM.longBreak, RHYTHM.shortBreak, RHYTHM.shortBreak]);
	// A break starts where a stretch ends, and ends where the one before it starts.
	expect(went.breaks[0]?.from).toBe(went.running.to);
	for (const [index, strip] of went.entries.entries()) {
		expect(went.breaks[index]?.to).toBe(strip.from);
		expect(went.breaks[index + 1]?.from ?? strip.to).toBe(strip.to);
	}
});

it("added up: the same strips lie end to end, and the rider stands at everything recorded", () => {
	const { went, added } = dayRails(EXAMPLE_DAY);

	expect(added.running).toEqual(went.running);
	let reached = added.running.to;
	for (const [index, strip] of added.entries.entries()) {
		expect(strip.from).toBe(reached);
		// As long as it is on the other rail: closing up loses nothing.
		const lived = went.entries[index];
		expect(strip.to - strip.from).toBeCloseTo((lived?.to ?? 0) - (lived?.from ?? 0));
		reached = strip.to;
	}
	expect(added.total).toBe(reached);
	expect(dayMinutes(0, added.total) * 60).toBeCloseTo(EXAMPLE_DAY.total);
});

it("the rider stands at the day's total at any time of day", () => {
	for (const iso of ["2026-11-11T01:30:10Z", "2026-11-11T09:15:00Z", "2026-11-11T15:02:47Z"]) {
		const now = new Date(iso).getTime();
		const day = dayAt(begin(now), now);
		const { added, went } = dayRails(day);

		expect(dayMinutes(0, added.total) * 60, iso).toBeCloseTo(day.total);
		expect(went.entries, iso).toHaveLength(day.logged.length);
		for (const pause of went.breaks) expect(pause.to, iso).toBeGreaterThanOrEqual(pause.from);
	}
});

it("a day longer than its rails stops at their ends and never leaves the bench", () => {
	const { went, added } = dayRails({ ...EXAMPLE_DAY, elapsed: 30 * 3600 });

	expect(went.running.to).toBe(WENT_RAIL_HOURS * DAY_HOUR);
	expect(added.total).toBe(ADDED_RAIL_HOURS * DAY_HOUR);
	for (const strip of [...went.entries, ...went.breaks, ...added.entries]) {
		expect(strip.to).toBeGreaterThanOrEqual(strip.from);
		expect(strip.to).toBeLessThanOrEqual(WENT_RAIL_HOURS * DAY_HOUR);
	}
});

it("in the week each project's lane is as long as its total, a strip for each day worked", () => {
	expect(WEEK_LANES.map((lane) => lane.project)).toEqual(week.map((row) => row.project));

	for (const [index, lane] of WEEK_LANES.entries()) {
		const row = week[index];
		expect(Math.round(weekMinutes(0, lane.total)), lane.project).toBe(row?.total);
		expect(
			lane.strips.map(({ from, to }) => Math.round(weekMinutes(from, to))),
			lane.project,
		).toEqual(row?.days.filter((day) => day > 0));
		expect(lane.total, lane.project).toBeLessThanOrEqual(WEEK_RAIL_HOURS * WEEK_HOUR);
	}
});

it("the lanes add up to the week's total, which is what the totaliser shows", () => {
	const lanes = WEEK_LANES.reduce((total, lane) => total + lane.total, 0);

	expect(lanes).toBeCloseTo(WEEK_LENGTH);
	expect(Math.round(weekMinutes(0, WEEK_LENGTH))).toBe(weekTotal);
});

// The drawing board: every figure shares one view.

const P: Projection = { scale: 1, origin: [100, 100] };

it("the floor's axes run down the page at two across to one down, and upright stays upright", () => {
	const [ox, oy] = project([0, 0, 0], P);
	const [xx, xy] = project([100, 0, 0], P);
	const [yx, yy] = project([0, 100, 0], P);
	const [zx, zy] = project([0, 0, 100], P);

	expect((xx - ox) / (xy - oy)).toBeCloseTo(2, 1);
	expect((yx - ox) / (yy - oy)).toBeCloseTo(-2, 1);
	expect(zx).toBe(ox);
	expect(zy).toBeLessThan(oy);
});

it("equal lengths stay equal wherever they are", () => {
	const span = (from: number) => project([from + 40, 7, 3], P)[0] - project([from, 7, 3], P)[0];

	expect(span(0)).toBeCloseTo(span(900), 0);
});

it("a solid is closed faces, and its silhouette goes round all of them", () => {
	for (const paths of [
		box({ x: 0, y: 0, z: 0, w: 10, d: 20, h: 5 }, P),
		round3({ x: 0, y: 0, z: 0, r: 8, h: 5 }, P),
	]) {
		for (const face of [paths.left, paths.top, paths.outline]) {
			expect(face.startsWith("M")).toBe(true);
			expect(face.endsWith("Z")).toBe(true);
			expect(face).not.toContain("NaN");
		}
	}
});

it("artwork laid on a face starts at the corner it is given", () => {
	const corner = [12, 34, 56] as const;
	const [x, y] = project(corner, P);

	for (const face of ["left", "right", "top"] as const) {
		expect(onFace(face, corner, P).endsWith(` ${x} ${y})`)).toBe(true);
	}
});
