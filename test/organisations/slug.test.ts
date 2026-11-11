import { describe, expect, it } from "vitest";
import {
	availableSlug,
	RESERVED_SLUGS,
	slugFromName,
	slugSearchPrefix,
} from "~/organisations/slug";

/** The rule, stated apart from the code: lowercase letters, digits and hyphens, 3 to 40, no hyphen at either end. */
const SLUG = /^(?=.{3,40}$)[a-z0-9]+(-[a-z0-9]+)*$/;

/** The words of the specification, written out so that dropping one from the code fails here. */
const RESERVED = [
	"new",
	"settings",
	"api",
	"auth",
	"app",
	"admin",
	"www",
	"invitations",
	"sign-in",
	"sign-up",
];

describe("the slug of a name", () => {
	it.each([
		["Acme", "acme"],
		["Acme Corp", "acme-corp"],
		["  Acme   Corp  ", "acme-corp"],
		["Smith & Sons, Ltd.", "smith-sons-ltd"],
		["Café Zoë", "cafe-zoe"],
		["Ünïcödé Åb", "unicode-ab"],
		["--Acme--", "acme"],
		["a_b.c/d", "a-b-c-d"],
		["Route 66", "route-66"],
		["ACME", "acme"],
	])("%j becomes %j", (name, slug) => {
		expect(slugFromName(name)).toBe(slug);
	});

	it.each([
		["QA", "qa-org"],
		["x", "x-org"],
		["日本語", "organisation"],
		["!!!", "organisation"],
		["🙂", "organisation"],
	])("pads %j, which is too short to be a slug, to %j", (name, slug) => {
		expect(slugFromName(name)).toBe(slug);
	});

	it("cuts a long name to 40 characters and leaves no hyphen at the end", () => {
		// The 40th character of the plain form is the hyphen after "eight".
		const name = "one two three four five six seven eight nine ten eleven";

		expect(slugFromName(name)).toBe("one-two-three-four-five-six-seven-eight");
		expect(slugFromName("a".repeat(80))).toBe("a".repeat(40));
	});

	it.each([
		"Acme",
		"QA",
		"!!!",
		"a".repeat(200),
		"-".repeat(50),
		" - a - ",
		"Ab",
		"one two three four five six seven eight nine ten eleven",
		`${"x".repeat(39)} y`,
		"<script>alert(1)</script>",
		"../../etc/passwd",
		"new",
	])("is always a slug: %j", (name) => {
		expect(slugFromName(name)).toMatch(SLUG);
	});
});

describe("the slug an organisation gets", () => {
	it("is the wanted one when nobody has it", () => {
		expect(availableSlug("acme", new Set())).toBe("acme");
		expect(availableSlug("acme", new Set(["acme-corp", "acme-2"]))).toBe("acme");
	});

	it("gets the lowest free number from 2 when the wanted one is taken", () => {
		expect(availableSlug("acme", new Set(["acme"]))).toBe("acme-2");
		expect(availableSlug("acme", new Set(["acme", "acme-2", "acme-3"]))).toBe("acme-4");
		expect(availableSlug("acme", new Set(["acme", "acme-3"]))).toBe("acme-2");
	});

	it("reserves exactly the words of the specification", () => {
		expect([...RESERVED_SLUGS].sort()).toEqual([...RESERVED].sort());
	});

	it.each(RESERVED)("is never the reserved word %j", (word) => {
		expect(availableSlug(word, new Set())).toBe(`${word}-2`);
		expect(availableSlug(word, new Set([`${word}-2`]))).toBe(`${word}-3`);
	});

	it("shortens a slug of full length to make room for the number", () => {
		const long = "a".repeat(40);
		const cutAtAHyphen = `${"a".repeat(37)}-bc`;

		expect(availableSlug(long, new Set([long]))).toBe(`${"a".repeat(38)}-2`);
		expect(availableSlug(cutAtAHyphen, new Set([cutAtAHyphen]))).toBe(`${"a".repeat(37)}-2`);
		expect(availableSlug(long, new Set([long]))).toMatch(SLUG);
	});

	it("can only be one that begins with the prefix the database is searched for", () => {
		for (const wanted of ["acme", "a".repeat(40), `${"a".repeat(31)}-${"b".repeat(8)}`, "new"]) {
			const taken = new Set<string>();
			// Far enough to reach suffixes of several digits.
			for (let n = 0; n < 1200; n++) {
				const slug = availableSlug(wanted, taken);
				expect(slug.startsWith(slugSearchPrefix(wanted))).toBe(true);
				taken.add(slug);
			}
			expect(taken.size).toBe(1200);
		}
	});
});
