import { describe, expect, it } from "vitest";
import { canonicalRedirect } from "../workers/canonical-host";

describe("canonical host", () => {
	it("sends www to the same path and query on the apex", () => {
		const response = canonicalRedirect(new Request("https://www.timesifier.com/reports?week=46"));

		expect(response?.status).toBe(308);
		expect(response?.headers.get("Location")).toBe("https://timesifier.com/reports?week=46");
	});

	it.each([
		"https://timesifier.com/",
		"https://pr-12-timesifier.example.workers.dev/",
		"http://localhost:5173/",
		// A host that merely ends with the alias is not the alias.
		"https://notwww.timesifier.com/",
	])("leaves %s alone", (url) => {
		expect(canonicalRedirect(new Request(url))).toBeNull();
	});
});
