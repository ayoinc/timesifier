import { describe, expect, it } from "vitest";
import { uuidv7 } from "~/db";

describe("uuidv7", () => {
	it("sorts ids from later milliseconds after earlier ones as strings", () => {
		// Includes the points where the timestamp carries into a higher byte.
		const moments = [
			0,
			1,
			255,
			256,
			65_535,
			65_536,
			2 ** 32 - 1,
			2 ** 32,
			Date.UTC(2026, 10, 11),
			Date.UTC(2026, 10, 11) + 1,
			Date.UTC(2100, 0, 1),
			2 ** 48 - 1,
		];
		for (let i = 1; i < moments.length; i++) {
			for (let attempt = 0; attempt < 50; attempt++) {
				const earlier = uuidv7(moments[i - 1]);
				const later = uuidv7(moments[i]);
				expect(earlier < later, `${earlier} < ${later}`).toBe(true);
			}
		}
	});

	it("carries the creation time in its first 48 bits", () => {
		const now = Date.UTC(2026, 10, 11, 12, 30, 45, 678);
		const hex = uuidv7(now).replaceAll("-", "").slice(0, 12);
		expect(Number.parseInt(hex, 16)).toBe(now);
	});

	it("sets version 7 and the RFC 9562 variant in every id", () => {
		for (let i = 0; i < 1000; i++) {
			expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		}
	});

	it("creates 10,000 unique ids within one millisecond", () => {
		const now = Date.now();
		const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(now)));
		expect(ids.size).toBe(10_000);
	});
});
