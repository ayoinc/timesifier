import { describe, expect, it } from "vitest";
import { exportFilename } from "~/organisations/export-filename";

// The name of a file an organisation exports for itself (TS-100): its name
// first, then what the file holds, then the day it was exported.

describe("exportFilename", () => {
	it("leads with the organisation's name, slugged, and ends with the day it was exported", () => {
		expect(exportFilename("Acme & Co", "time-2026-11-02-to-2026-11-08", "2026-11-13", "csv")).toBe(
			"acme-co-time-2026-11-02-to-2026-11-08-exported-2026-11-13.csv",
		);
		expect(exportFilename("Acme", "all-invoices", "2026-11-13", "zip")).toBe(
			"acme-all-invoices-exported-2026-11-13.zip",
		);
	});

	it("is letters, digits and hyphens whatever the name holds, so a header carries it as it is", () => {
		for (const name of ['Café "Zoë"', 'a"; filename="evil.exe', "Ünïcödé\r\nX-Header: 1", "東京"]) {
			expect(exportFilename(name, "leave-2026", "2026-11-13", "csv")).toMatch(
				/^[a-z0-9-]+-leave-2026-exported-2026-11-13\.csv$/,
			);
		}
		expect(exportFilename('Café "Zoë"', "leave-2026", "2026-11-13", "csv")).toBe(
			"cafe-zoe-leave-2026-exported-2026-11-13.csv",
		);
	});
});
