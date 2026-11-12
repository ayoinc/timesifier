import { describe, expect, it } from "vitest";
import {
	type Access,
	activityScopeOf,
	isFinance,
	mayCancelLeaveOf,
	mayChangeExpensesOf,
	mayChangeTimeOf,
	mayDecideLeaveOf,
	mayDecidePeriodOf,
	mayInvoice,
	mayManageIntegrations,
	mayManageLeavePolicy,
	mayManageRates,
	mayManageTasks,
	mayReopenPeriods,
	maySeeExpensesOf,
	maySeeLeaveKindOf,
	maySeeRates,
	maySeeTimeOf,
	timeScopeOf,
} from "~/organisations/access";
import type { Role } from "~/organisations/roles";

// Whose time a member may see, change and decide on (docs/security.md, "Whose
// time", "Rates and money"): every cell of the table, for an owner, an admin,
// Finance, a manager of one team and a member. Ada owns the organisation, Grace
// is an admin, Kat is Finance, Hedy manages the team that holds Linus and
// herself, and Bola is in no team.

const owner: Access = { userId: "ada", role: "owner", managed: new Set() };
const admin: Access = { userId: "grace", role: "admin", managed: new Set() };
const finance: Access = { userId: "kat", role: "finance", managed: new Set() };
const manager: Access = { userId: "hedy", role: "member", managed: new Set(["hedy", "linus"]) };
const member: Access = { userId: "linus", role: "member", managed: new Set() };

const PEOPLE = ["ada", "grace", "kat", "hedy", "linus", "bola"];

/** The people `rule` allows `access` to act on, in the order of PEOPLE. */
function whom(access: Access, rule: (access: Access, personId: string) => boolean) {
	return PEOPLE.filter((personId) => rule(access, personId));
}

describe("seeing a person's time", () => {
	it("an owner or admin sees everyone's", () => {
		expect(whom(owner, maySeeTimeOf)).toEqual(PEOPLE);
		expect(whom(admin, maySeeTimeOf)).toEqual(PEOPLE);
	});

	it("Finance sees everyone's", () => {
		expect(whom(finance, maySeeTimeOf)).toEqual(PEOPLE);
	});

	it("a manager sees their own and their team's, and nobody else's", () => {
		expect(whom(manager, maySeeTimeOf)).toEqual(["hedy", "linus"]);
	});

	it("a member sees their own alone", () => {
		expect(whom(member, maySeeTimeOf)).toEqual(["linus"]);
	});
});

describe("changing a person's entries", () => {
	it.each([owner, admin, finance, manager, member])("$userId changes their own alone", (access) => {
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

	it("a member, and Finance managing no team, decide nobody's", () => {
		expect(whom(member, mayDecidePeriodOf)).toEqual([]);
		expect(whom(finance, mayDecidePeriodOf)).toEqual([]);
	});

	it("Finance managing a team decides that team's, never their own", () => {
		const managing: Access = { ...finance, managed: new Set(["kat", "linus"]) };
		expect(whom(managing, mayDecidePeriodOf)).toEqual(["linus"]);
	});

	it("only an owner or admin reopens an approved period", () => {
		expect([owner, admin, finance, manager, member].map(mayReopenPeriods)).toEqual([
			true,
			true,
			false,
			false,
			false,
		]);
	});
});

describe("a person's leave (TS-061)", () => {
	/** Mona manages another team, which holds Bola: not Linus's. */
	const otherManager: Access = { userId: "mona", role: "member", managed: new Set(["bola"]) };
	const everyone = [owner, admin, finance, manager, otherManager, member];

	it("is decided by an owner, an admin or a manager of the person's team, never by the person", () => {
		expect(everyone.map((access) => whom(access, mayDecideLeaveOf))).toEqual([
			["grace", "kat", "hedy", "linus", "bola"],
			["ada", "kat", "hedy", "linus", "bola"],
			[],
			["linus"],
			["bola"],
			[],
		]);
	});

	it("is cancelled by an owner or admin alone, never on their own", () => {
		expect(everyone.map((access) => whom(access, mayCancelLeaveOf))).toEqual([
			["grace", "kat", "hedy", "linus", "bola"],
			["ada", "kat", "hedy", "linus", "bola"],
			[],
			[],
			[],
			[],
		]);
	});

	it("shows its kind to the person, their team's managers, owners and admins, and not to Finance", () => {
		expect(everyone.map((access) => whom(access, maySeeLeaveKindOf))).toEqual([
			PEOPLE,
			PEOPLE,
			["kat"],
			["hedy", "linus"],
			["bola"],
			["linus"],
		]);
	});

	it("follows a policy only an owner or admin sets", () => {
		expect(everyone.map(mayManageLeavePolicy)).toEqual([true, true, false, false, false, false]);
	});
});

describe("the time a list or report may hold", () => {
	it("is everyone's for an owner or admin, the team's and their own for a manager, their own for a member", () => {
		expect(timeScopeOf(owner)).toEqual({ everyone: true });
		expect(timeScopeOf(admin)).toEqual({ everyone: true });
		expect(timeScopeOf(finance)).toEqual({ everyone: true });
		expect(timeScopeOf(manager)).toEqual({ everyone: false, people: ["hedy", "linus"] });
		expect(timeScopeOf(member)).toEqual({ everyone: false, people: ["linus"] });
	});
});

describe("expenses", () => {
	it("are seen by whoever sees the person's time", () => {
		for (const access of [owner, admin, finance, manager, member]) {
			expect(whom(access, maySeeExpensesOf)).toEqual(whom(access, maySeeTimeOf));
		}
	});

	it.each([owner, admin, finance, manager, member])("$userId changes their own alone", (access) => {
		expect(whom(access, mayChangeExpensesOf)).toEqual([access.userId]);
	});
});

describe("money, tasks and integrations, by role", () => {
	const ROLES: Role[] = ["owner", "admin", "finance", "member"];
	/** Each rule, and the roles it allows: a manager is a member here, and sees no rate. */
	const TABLE: [string, (role: Role) => boolean, Role[]][] = [
		["isFinance", isFinance, ["finance"]],
		["maySeeRates", maySeeRates, ["owner", "admin", "finance"]],
		["mayManageRates", mayManageRates, ["owner", "admin", "finance"]],
		["mayInvoice", mayInvoice, ["owner", "admin", "finance"]],
		["mayManageTasks", mayManageTasks, ["owner", "admin"]],
		["mayManageIntegrations", mayManageIntegrations, ["owner", "admin"]],
	];

	it.each(TABLE)("%s allows exactly its roles", (_name, rule, allowed) => {
		expect(ROLES.filter(rule)).toEqual(allowed);
	});

	it("a manager sees no rate, whatever team they manage", () => {
		expect(maySeeRates(manager.role)).toBe(false);
	});
});

describe("the activity log a person may read", () => {
	it("is everyone's for an owner, admin or Finance, the team's and their own for a manager, their own for a member", () => {
		expect(activityScopeOf(owner)).toEqual({ everyone: true });
		expect(activityScopeOf(admin)).toEqual({ everyone: true });
		expect(activityScopeOf(finance)).toEqual({ everyone: true });
		expect(activityScopeOf(manager)).toEqual({ everyone: false, people: ["hedy", "linus"] });
		expect(activityScopeOf(member)).toEqual({ everyone: false, people: ["linus"] });
	});
});
