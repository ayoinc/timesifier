import { describe, expect, it } from "vitest";

import { sameQuery } from "../../app/components/FilterBar";
import { onlyTabChanged } from "../../app/projects/projects";

// A list's search (TS-057, TS-114) answers what the field holds. Projects
// filters the list it was sent while the words narrow the ones it was read for,
// and asks the server again (`useRevalidator`) when they do not; Clients and
// Tasks keep their tabs without a read. Main run 45137788218 found two holes:
// Enter on a search already applied read the page again for the same address,
// and the page's own request to read again was refused, because an address
// that had not changed counted as a move between tabs. The list then kept the
// projects read for "GLOB" after the field was cleared, and asked dozens of
// times. The browser test is in e2e/projects-search.spec.ts.

const at = (search: string) => new URL(`https://timesifier.test/app/acme/projects${search}`);

describe("onlyTabChanged", () => {
	it("is a move between tabs when the tab alone changed", () => {
		expect(onlyTabChanged(at("?q=glob"), at("?q=glob&show=archived"))).toBe(true);
		expect(onlyTabChanged(at("?show=archived"), at(""))).toBe(true);
	});

	it("is no move between tabs for an address that did not change: the page asks to read again, and does", () => {
		expect(onlyTabChanged(at(""), at(""))).toBe(false);
		expect(onlyTabChanged(at("?q=glob"), at("?q=glob"))).toBe(false);
		expect(onlyTabChanged(at("?q=glob&show=archived"), at("?q=glob&show=archived"))).toBe(false);
	});

	it("is no move between tabs when the words or the page changed", () => {
		expect(onlyTabChanged(at("?q=glob"), at(""))).toBe(false);
		expect(
			onlyTabChanged(at(""), new URL("https://timesifier.test/app/acme/clients?show=archived")),
		).toBe(false);
	});
});

describe("sameQuery", () => {
	const q = (search: string) => new URLSearchParams(search);

	it("holds for the same parameters in any order", () => {
		expect(sameQuery(q("q=GLOB&show=archived"), q("show=archived&q=GLOB"))).toBe(true);
		expect(sameQuery(q(""), q(""))).toBe(true);
	});

	it("tells different words, a dropped parameter and a different tab apart", () => {
		expect(sameQuery(q("q=GLOB"), q("q=GLO"))).toBe(false);
		expect(sameQuery(q("q=GLOB"), q(""))).toBe(false);
		expect(sameQuery(q("q=GLOB"), q("q=GLOB&show=archived"))).toBe(false);
		expect(sameQuery(q("q=glob"), q("q=GLOB"))).toBe(false);
	});
});
