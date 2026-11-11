import { expect, it } from "vitest";

it("fails on purpose to prove the pipeline blocks a red test", () => {
	expect(1).toBe(2);
});
