import { describe, expect, it } from "vitest";
import { inTerms, singular, termsOf, withArticle } from "~/workspace/work-model";

// The article an organisation's own term takes (TS-115a, decision 67): read by
// its sound, so "an activity" and "an hour" but "a unit" and "a user", and a
// word of capitals letter by letter, "an SOW".

describe("withArticle", () => {
	it.each([
		["activity", "an activity"],
		["hour", "an hour"],
		["unit", "a unit"],
		["SOW", "an SOW"],
		["user", "a user"],
	])("gives %s its article: %s", (noun, said) => {
		expect(withArticle(noun)).toBe(said);
	});

	it.each([
		["work code", "a work code"],
		["cost centre", "a cost centre"],
		["engagement", "an engagement"],
		["honour code", "an honour code"],
		["heir", "an heir"],
		["European project", "a European project"],
		["one-off job", "a one-off job"],
		["utility", "a utility"],
		["umbrella", "an umbrella"],
		["PO number", "a PO number"],
		["FX code", "an FX code"],
		["RFC", "an RFC"],
		["UK office", "a UK office"],
	])("reads %s by its sound: %s", (noun, said) => {
		expect(withArticle(noun)).toBe(said);
	});

	it("starts the article with a capital when asked", () => {
		expect(withArticle("activity", true)).toBe("An activity");
		expect(withArticle("unit", true)).toBe("A unit");
	});
});

describe("inTerms", () => {
	it("gives the internal term the article it takes, keeping the article's capital", () => {
		const activities = termsOf("internal", "Activities");
		expect(inTerms("Create a project", activities)).toBe("Create an activity");
		expect(inTerms("A project is what you track time against.", activities)).toBe(
			"An activity is what you track time against.",
		);
		expect(inTerms("Projects and a project", termsOf("internal", "Hours"))).toBe(
			"Hours and an hour",
		);
		expect(inTerms("Create a project", termsOf("internal", "Units"))).toBe("Create a unit");
		expect(inTerms("Create a project", termsOf("internal", "SOWs"))).toBe("Create an SOW");
	});

	it("leaves the words as they are outside Internal work", () => {
		for (const model of ["client_projects", "both"] as const) {
			expect(inTerms("Create a project", termsOf(model, "Activities"))).toBe("Create a project");
		}
	});

	it("takes each term to its singular", () => {
		expect(["Work codes", "Activities", "Cost centres", "Boxes", "SOWs"].map(singular)).toEqual([
			"Work code",
			"Activity",
			"Cost centre",
			"Box",
			"SOW",
		]);
	});
});
