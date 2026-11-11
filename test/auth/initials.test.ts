import { describe, expect, it } from "vitest";

import { initialsOf } from "~/auth/person-name";

// The letters of the avatar that opens the profile menu (TS-063): from the
// person's name, else from their address. These run in the Workers runtime, so
// the splitting into characters is the deployed server's.

describe("a person's initials", () => {
	it("are the first letters of the first and the last word of the name", () => {
		expect(initialsOf("Ada Lovelace", "ada@example.com")).toBe("AL");
		expect(initialsOf("Ada King Lovelace", "ada@example.com")).toBe("AL");
	});

	it("are one letter for a name of one word", () => {
		expect(initialsOf("Ada", "x@example.com")).toBe("A");
	});

	it("are upper case, and ignore the spaces around and between the words", () => {
		expect(initialsOf("  grace   hopper ", "g@example.com")).toBe("GH");
	});

	it("are the first letter of the address when there is no name", () => {
		expect(initialsOf(null, "linus@example.com")).toBe("L");
		expect(initialsOf("", "linus@example.com")).toBe("L");
		expect(initialsOf("   ", "linus@example.com")).toBe("L");
	});

	it("never cut a character a reader sees in half", () => {
		expect(initialsOf("Émile Zola", "e@example.com")).toBe("ÉZ");
		expect(initialsOf("E\u0301mile", "e@example.com")).toBe("E\u0301");
		expect(initialsOf("👩🏽‍💻 Coder", "c@example.com")).toBe("👩🏽‍💻C");
		expect(initialsOf("Łukasz Ölund", "l@example.com")).toBe("ŁÖ");
	});
});
