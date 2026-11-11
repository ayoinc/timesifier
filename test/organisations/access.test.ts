import { describe, expect, it } from "vitest";
import {
	type Access,
	mayChangeTimeOf,
	mayDecidePeriodOf,
	mayReopenPeriods,
	maySeeTimeOf,
	timeScopeOf,
} from "~/organisations/access";

// Whose time a member may see, change and decide on (docs/security.md, "Whose
// time"): every cell of the table, for an owner, an admin, a manager of one
// team and a member. Ada owns the organisation, Grace is an admin, Hedy manages
// the team that holds Linus and herself, and Bola is in no team.

const owner: Access = { userId: "ada", role: "owner", managed: new Set() };
const admin: Access = { userId: "grace", role: "admin", managed: new Set() };
const manager: Access = { userId: "hedy", role: "member", managed: new Set(["hedy", "linus"]) };
const member: Access = { userId: "linus", role: "member", managed: new Set() };

const PEOPLE = ["ada", "grace", "hedy", "linus", "bola"];

/** The people `rule` allows `access` to act on, in the order of PEOPLE. */
function whom(access: Access, rule: (access: Access, personId: string) => boolean) {
	return PEOPLE.filter((personId) => rule(access, personId));
}

describe("seeing a person's time", () => {
	it("an owner or admin sees everyone's", () => {
		expect(whom(owner, maySeeTimeOf)).toEqual(PEOPLE);
		expect(whom(admin, maySeeTimeOf)).toEqual(PEOPLE);
	});

	it("a manager sees their own and their team's, and nobody else's", () => {
		expect(whom(manager, maySeeTimeOf)).toEqual(["hedy", "linus"]);
	});

	it("a member sees their own alone", () => {
		expect(whom(member, maySeeTimeOf)).toEqual(["linus"]);
	});
});

describe("changing a person's entries", () => {
	it.each([owner, admin, manager, member])("$userId changes their own alone", (access) => {
		expect(whom(access, mayChangeTimeOf)).toEqual([access.userId]);
	});
});

describe("deciding a person's period", () => {
	it("an owner or admin decides everyone's, their own included", () => {
		expect(whom(owner, mayDecidePeriodOf)).toEqual(PEOPLE);
		expect(whom(admin, mayDecidePeriodOf)).toEqual(PEOPLE);
	});

	it("a manager decides their team's, never their own", () => {
		expect(whom(manager, mayDecidePeriodOf)).toEqual(["linus"]);
	});

	it("a member decides nobody's", () => {
		expect(whom(member, mayDecidePeriodOf)).toEqual([]);
	});

	it("only an owner or admin reopens an approved period", () => {
		expect([owner, admin, manager, member].map(mayReopenPeriods)).toEqual([
			true,
			true,
			false,
			false,
		]);
	});
});

describe("the time a list or report may hold", () => {
	it("is everyone's for an owner or admin, the team's and their own for a manager, their own for a member", () => {
		expect(timeScopeOf(owner)).toEqual({ everyone: true });
		expect(timeScopeOf(admin)).toEqual({ everyone: true });
		expect(timeScopeOf(manager)).toEqual({ everyone: false, people: ["hedy", "linus"] });
		expect(timeScopeOf(member)).toEqual({ everyone: false, people: ["linus"] });
	});
});
