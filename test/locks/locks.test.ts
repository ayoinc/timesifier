import { describe, expect, it } from "vitest";
import {
	type LockInput,
	type LockReason,
	lockOf,
	lockOfChange,
	mayChangeItem,
} from "~/locks/locks";
import { locksEntries, PeriodStatus } from "~/periods/periods";
import { addDays } from "~/time/calendar";

// Why an entry, an expense or a day of leave cannot change (TS-064, B22): the
// lock date, its person's period, and being invoiced.

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

const open: LockInput = {
	day: "2026-11-11",
	lockedThrough: null,
	periodStatus: null,
	invoiced: false,
};

describe("the lock on an item", () => {
	it("is none for an item on an open day, never invoiced", () => {
		expect(lockOf(open)).toBeNull();
		for (const status of ["withdrawn", "returned"] as const) {
			expect(lockOf({ ...open, periodStatus: status })).toBeNull();
		}
	});

	it("is the lock date on and before it, and not after", () => {
		expect(lockOf({ ...open, lockedThrough: "2026-11-11" })).toBe("locked-through");
		expect(lockOf({ ...open, lockedThrough: "2026-11-30" })).toBe("locked-through");
		expect(lockOf({ ...open, lockedThrough: "2026-11-10" })).toBeNull();
	});

	it("is the period's while it is submitted or approved", () => {
		expect(lockOf({ ...open, periodStatus: "submitted" })).toBe("submitted");
		expect(lockOf({ ...open, periodStatus: "approved" })).toBe("approved");
	});

	it("is invoiced for an item on an invoice line", () => {
		expect(lockOf({ ...open, invoiced: true })).toBe("invoiced");
	});

	it("gives invoiced first, then the lock date, then approved, then submitted", () => {
		expect(
			lockOf({ ...open, invoiced: true, lockedThrough: "2026-12-01", periodStatus: "approved" }),
		).toBe("invoiced");
		expect(lockOf({ ...open, lockedThrough: "2026-12-01", periodStatus: "approved" })).toBe(
			"locked-through",
		);
		expect(lockOf({ ...open, lockedThrough: "2026-12-01", periodStatus: "submitted" })).toBe(
			"locked-through",
		);
	});

	it("property: is null exactly when nothing locks it, and the period's lock agrees with locksEntries", () => {
		const next = random(11);
		const statuses = [null, ...PeriodStatus.options];
		for (let run = 0; run < 2000; run++) {
			const day = addDays("2026-01-01", Math.floor(next() * 365));
			const lockedThrough = next() < 0.5 ? null : addDays("2026-01-01", Math.floor(next() * 365));
			const periodStatus = statuses[Math.floor(next() * statuses.length)] ?? null;
			const invoiced = next() < 0.2;
			const reason = lockOf({ day, lockedThrough, periodStatus, invoiced });
			const byDate = lockedThrough !== null && day <= lockedThrough;
			const byPeriod = locksEntries(periodStatus);
			expect(reason === null).toBe(!invoiced && !byDate && !byPeriod);
			const expected: LockReason | null = invoiced
				? "invoiced"
				: byDate
					? "locked-through"
					: byPeriod
						? (periodStatus as LockReason)
						: null;
			expect(reason).toBe(expected);
		}
	});
});

describe("a change to an item", () => {
	const locked: LockInput = { ...open, day: "2026-11-01", lockedThrough: "2026-11-05" };
	const free: LockInput = { ...open, day: "2026-11-11", lockedThrough: "2026-11-05" };

	it("may be made when the item is unlocked before and after", () => {
		expect(mayChangeItem(free, free)).toBe(true);
		expect(lockOfChange(free, free)).toBeNull();
	});

	it("may not create, edit or delete an item on a locked day", () => {
		expect(mayChangeItem(null, locked)).toBe(false);
		expect(mayChangeItem(locked, locked)).toBe(false);
		expect(mayChangeItem(locked, null)).toBe(false);
		expect(lockOfChange(null, locked)).toBe("locked-through");
	});

	it("may not move an item out of a locked day, nor into one", () => {
		expect(mayChangeItem(locked, free)).toBe(false);
		expect(mayChangeItem(free, locked)).toBe(false);
	});

	it("names the lock as the item was before the lock it would have after", () => {
		expect(lockOfChange({ ...free, invoiced: true }, locked)).toBe("invoiced");
		expect(lockOfChange(free, { ...free, periodStatus: "approved" })).toBe("approved");
	});

	it("takes no role: the lock date binds the owner as it binds everyone", () => {
		// The rule has no input for who asks, so no role can pass a lock.
		expect(mayChangeItem.length).toBe(2);
		expect(lockOf.length).toBe(1);
	});

	it("is allowed for a creation and a deletion with nothing locked", () => {
		expect(mayChangeItem(null, free)).toBe(true);
		expect(mayChangeItem(free, null)).toBe(true);
		expect(mayChangeItem(null, null)).toBe(true);
	});
});
