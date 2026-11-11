import { describe, expect, it } from "vitest";

describe("test runtime", () => {
	it("runs inside the Workers runtime, so tests see what production sees", () => {
		expect(navigator.userAgent).toBe("Cloudflare-Workers");
	});
});
