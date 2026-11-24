import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
	changeContract,
	deleteExpiredContracts,
	endContract,
	giveContract,
} from "~/contracts/contracts.server";
import { contractsOf } from "~/contracts/read.server";
import { organisationScope } from "~/db";
import { annualLeaveOf, annualLeftWords } from "~/leave/leave.server";
import { versionOn, weekOfMinutes } from "~/schedules/schedules";
import { assignSchedule } from "~/schedules/schedules.server";
import { contractPath } from "~/shell/destinations";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { value } from "../organisations/harness";
import { open, openData, type Person, pageBody, submit, textOf } from "./harness";
import { kindOf, seedLeave } from "./leave-seed";
import { KINDS, type Roles, seedRoles } from "./roles-seed";
import { seedSchedule } from "./schedule-seed";

// Contracts and their changes (TS-098a, research/contracts-model.md sections
// 2, 6 and 9): what the server does when one is given, changed from a day and
// ended, and the Contract page of Team that asks it to, by role. The rules
// without the database are test/contracts/contracts.test.ts.

/** Monday 9 November 2026, noon in London. */
const T0 = Date.parse("2026-11-09T12:00:00Z");
const TODAY = "2026-11-09";

let mailbox: Mailbox;
let roles: Roles;
let acme: Roles["acme"];
/** Linus, a member of Design, whom Hedy manages. */
let linus: Person;
/** Monday to Wednesday, 09:00 to 14:00: 15 hours a week. */
let threeDays: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	roles = await seedRoles(mailbox);
	acme = roles.acme;
	linus = roles.people.member;
	vi.spyOn(Date, "now").mockReturnValue(T0);
	threeDays = await seedSchedule(acme.id, "Three days", weekOfMinutes([300, 300, 300, 0, 0, 0, 0]));
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const scope = () => organisationScope(env.DB, acme.id);
const page = (who: Person = linus) => contractPath(acme.slug, who.user.id);

/** What a contract sheet sends: permanent, £32,000 a year, overtime not paid. */
function terms(more: Record<string, string> = {}) {
	return {
		kind: "permanent",
		payBasis: "yearly",
		pay: "32000",
		currency: "GBP",
		overtimePay: "unpaid",
		...more,
	};
}

const ask = async (who: Person, fields: Record<string, string>, of: Person = linus) => {
	const response = await submit(page(of), fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
};

const give = (who: Person, more: Record<string, string> = {}, of: Person = linus) =>
	ask(who, { intent: "give", startsOn: "2026-01-05", ...terms(more) }, of);

const theirs = async (who: Person = linus) =>
	(await contractsOf(scope(), [who.user.id])).get(who.user.id) ?? [];

const text = async (path: string, who: Person) => {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
};

const recorded = (action: string) =>
	value<number>(
		"select count(*) from activity_records where organisation_id = ? and action = ?",
		acme.id,
		action,
	);

describe("the server", () => {
	it("changes from a day: the days before keep their terms, and each change is recorded", async () => {
		const ada = roles.people.owner.user.id;
		const fields = { ...terms(), kind: "permanent" as const, overtimePay: "unpaid" as const };
		const given = await giveContract(
			scope(),
			ada,
			linus.user.id,
			"2026-01-05",
			{ ...fields, payBasis: "yearly", jobTitle: "Designer" },
			TODAY,
		);
		expect(given.change).toBe("done");
		const id = given.change === "done" ? given.id : "";
		expect(
			(
				await changeContract(
					scope(),
					ada,
					id,
					"2026-04-06",
					{ ...fields, payBasis: "yearly", pay: "34000", jobTitle: "Designer" },
					TODAY,
				)
			).change,
		).toBe("done");
		const [contract] = await theirs();
		if (!contract) throw new Error("No contract.");
		expect(contract.versions.map((v) => [v.effectiveFrom, v.payMinor])).toEqual([
			["2026-01-05", 3_200_000],
			["2026-04-06", 3_400_000],
		]);
		expect(versionOn(contract, "2026-04-05").payMinor).toBe(3_200_000);
		expect(versionOn(contract, "2026-04-06").payMinor).toBe(3_400_000);
		// A second change from the same day replaces it, and leaves the first alone.
		await changeContract(
			scope(),
			ada,
			id,
			"2026-04-06",
			{ ...fields, payBasis: "yearly", pay: "35000", jobTitle: "Designer" },
			TODAY,
		);
		const [again] = await theirs();
		expect(again?.versions.map((v) => v.payMinor)).toEqual([3_200_000, 3_500_000]);
		expect(await recorded("contract.created")).toBe(1);
		// The pay changed twice, and nothing a manager reads did.
		expect(await recorded("contract_pay.changed")).toBe(3);
		expect(await recorded("contract.changed")).toBe(2);
	});

	it("ends and starts again: a contract ends, the next begins the day after, and none overlaps", async () => {
		const ada = roles.people.owner.user.id;
		const fields = { ...terms(), kind: "fixed_term" as const, overtimePay: "unpaid" as const };
		const first = await giveContract(
			scope(),
			ada,
			linus.user.id,
			"2026-01-05",
			{ ...fields, payBasis: "yearly", endsOn: "2026-12-31" },
			TODAY,
		);
		const id = first.change === "done" ? first.id : "";
		// Another sharing a day is refused, by the server and, were it raced, by the trigger.
		const clash = await giveContract(
			scope(),
			ada,
			linus.user.id,
			"2026-12-31",
			{ ...fields, kind: "permanent", payBasis: "yearly" },
			TODAY,
		);
		expect(clash.change).toBe("overlap");
		await expect(
			env.DB.prepare(
				"insert into contracts (id, organisation_id, user_id, kind, starts_on, created_at, updated_at) values ('raced', ?, ?, 'permanent', '2026-06-01', 0, 0)",
			)
				.bind(acme.id, linus.user.id)
				.run(),
		).rejects.toThrow(/contracts never overlap/);

		expect((await endContract(scope(), ada, id, "2026-11-30", "resigned", TODAY)).change).toBe(
			"done",
		);
		expect((await endContract(scope(), ada, id, "2026-11-30", "resigned", TODAY)).change).toBe(
			"ended",
		);
		const next = await giveContract(
			scope(),
			ada,
			linus.user.id,
			"2026-12-01",
			{ ...fields, kind: "permanent", payBasis: "yearly" },
			TODAY,
		);
		expect(next.change).toBe("done");
		expect((await theirs()).map((c) => [c.kind, c.startsOn, c.endsOn, c.endReason])).toEqual([
			["fixed_term", "2026-01-05", "2026-11-30", "resigned"],
			["permanent", "2026-12-01", null, null],
		]);
		// A change of kind from a day ends the one and starts the next, as "replaced".
		const nextId = next.change === "done" ? next.id : "";
		expect(
			(
				await changeContract(
					scope(),
					ada,
					nextId,
					"2027-03-01",
					{ ...fields, kind: "contractor", payBasis: "daily", pay: "400" },
					TODAY,
				)
			).change,
		).toBe("done");
		expect((await theirs()).map((c) => [c.kind, c.startsOn, c.endsOn, c.endReason])).toEqual([
			["fixed_term", "2026-01-05", "2026-11-30", "resigned"],
			["permanent", "2026-12-01", "2027-02-28", "replaced"],
			["contractor", "2027-03-01", null, null],
		]);
	});

	it("the contract gives the hours, and a manual assignment on those days is refused", async () => {
		const ada = roles.people.owner.user.id;
		const fields = { ...terms(), kind: "permanent" as const, overtimePay: "unpaid" as const };
		await giveContract(
			scope(),
			ada,
			linus.user.id,
			"2026-01-05",
			{ ...fields, payBasis: "yearly", scheduleId: threeDays },
			TODAY,
		);
		// Written from today, as the contract's own; the days gone keep theirs.
		const rows = await env.DB.prepare(
			"select schedule_id, effective_from, source_kind from schedule_assignments where organisation_id = ? and target_kind = 'person' and target_id = ?",
		)
			.bind(acme.id, linus.user.id)
			.all();
		expect(rows.results).toEqual([
			{ schedule_id: threeDays, effective_from: TODAY, source_kind: "contract" },
		]);
		const standard = await value<string>(
			"select id from work_schedules where organisation_id = ? and name = 'Standard'",
			acme.id,
		);
		expect(
			await assignSchedule(
				scope(),
				ada,
				{ kind: "person", id: linus.user.id },
				standard,
				"2026-11-16",
				TODAY,
			),
		).toBe("contract");
	});

	it("keeps a contract three years after the end of the tax year it ended in, then deletes it with its versions", async () => {
		const ada = roles.people.owner.user.id;
		const hedy = roles.people.manager;
		const fields = { ...terms(), overtimePay: "unpaid" as const, payBasis: "yearly" as const };
		// Ended Sunday 5 April 2026, the last day of the tax year 2025 to 2026.
		await giveContract(
			scope(),
			ada,
			linus.user.id,
			"2025-01-06",
			{ ...fields, kind: "fixed_term", endsOn: "2026-04-05" },
			TODAY,
		);
		// Ended Monday 6 April 2026, the first day of the next.
		await giveContract(
			scope(),
			ada,
			hedy.user.id,
			"2025-01-06",
			{ ...fields, kind: "fixed_term", endsOn: "2026-04-06" },
			TODAY,
		);
		// No end: kept.
		await giveContract(scope(), ada, ada, "2025-01-06", { ...fields, kind: "permanent" }, TODAY);
		const count = () => value<number>("select count(*) from contracts");
		const versions = () => value<number>("select count(*) from contract_versions");

		expect(await deleteExpiredContracts(env.DB, new Date("2029-04-05T03:17:00Z"))).toBe(0);
		expect(await count()).toBe(3);
		expect(await deleteExpiredContracts(env.DB, new Date("2029-04-06T03:17:00Z"))).toBe(1);
		expect(await count()).toBe(2);
		expect(await versions()).toBe(2);
		expect(await deleteExpiredContracts(env.DB, new Date("2030-04-05T03:17:00Z"))).toBe(0);
		expect(await deleteExpiredContracts(env.DB, new Date("2030-04-06T03:17:00Z"))).toBe(1);
		expect(await count()).toBe(1);
	});

	it("keeps a person's leave adjustments after they leave, and deletes them with the last of their contracts", async () => {
		const ada = roles.people.owner.user.id;
		const hedy = roles.people.manager;
		const fields = { ...terms(), overtimePay: "unpaid" as const, payBasis: "yearly" as const };
		// Linus's two contracts end in the tax years 2025 to 2026 and 2026 to 2027; Hedy's has no end.
		const ended = (startsOn: string, endsOn: string) =>
			giveContract(
				scope(),
				ada,
				linus.user.id,
				startsOn,
				{ ...fields, kind: "fixed_term", endsOn },
				TODAY,
			);
		await ended("2025-01-06", "2026-04-05");
		await ended("2026-04-06", "2026-06-30");
		await giveContract(
			scope(),
			ada,
			hedy.user.id,
			"2025-01-06",
			{ ...fields, kind: "permanent" },
			TODAY,
		);
		const annual = await kindOf(acme.id, "annual");
		for (const who of [linus, hedy]) {
			await env.DB.prepare(
				"insert into leave_adjustments (id, organisation_id, user_id, kind_id, leave_year, minutes, reason, created_by, created_at, updated_at) values (?, ?, ?, ?, 2025, 450, 'Opening balance', ?, ?, ?)",
			)
				.bind(crypto.randomUUID(), acme.id, who.user.id, annual, ada, T0, T0)
				.run();
		}
		const kept = (who: Person) =>
			value<number>("select count(*) from leave_adjustments where user_id = ?", who.user.id);

		// Linus leaves: his contracts and his adjustment stay, as payroll records.
		await env.DB.prepare("delete from memberships where organisation_id = ? and user_id = ?")
			.bind(acme.id, linus.user.id)
			.run();
		expect(await kept(linus)).toBe(1);
		// His first contract goes; the second keeps his adjustment.
		expect(await deleteExpiredContracts(env.DB, new Date("2029-04-06T03:17:00Z"))).toBe(1);
		expect(await kept(linus)).toBe(1);
		// The last goes, and the adjustment with it; Hedy's, whose contract has no end, stays.
		expect(await deleteExpiredContracts(env.DB, new Date("2030-04-06T03:17:00Z"))).toBe(1);
		expect(await kept(linus)).toBe(0);
		expect(await kept(hedy)).toBe(1);
	});
});

describe("the Contract page, by role", () => {
	it("is read by owners, admins, Finance and the person's manager; anybody else gets the organisation's 404", async () => {
		expect((await give(roles.people.owner, { worksNumber: "W-17" })).status).toBe(200);
		const expected = { owner: 200, admin: 200, finance: 200, manager: 200, member: 404 } as const;
		for (const kind of KINDS) {
			const who = roles.people[kind];
			expect((await open(page(), who)).status, kind).toBe(expected[kind]);
			expect((await openData(page(), who)).status, kind).toBe(expected[kind]);
		}
		// The member column is Linus himself: members are not shown Team, and read their own on My account.
		expect(roles.people.member).toBe(linus);
		// A manager reads the people of their teams alone: not Grace's.
		expect((await open(page(roles.people.admin), roles.people.manager)).status).toBe(404);
	});

	it("sends a manager no pay, multiplier or works number, not even in its data", async () => {
		await give(roles.people.owner, {
			worksNumber: "W-17",
			overtimePay: "paid",
			overtimeMultiplier: "15000",
		});
		const manager = roles.people.manager;
		for (const response of [await open(page(), manager), await openData(page(), manager)]) {
			const body = await response.text();
			expect(response.status).toBe(200);
			expect(body).toContain("Overtime is paid.");
			expect(body).not.toMatch(/£|32,000|32000|payMinor|"pay"|W-17|time and a half/i);
		}
		// Finance reads it all, and is offered no change.
		const finance = await text(page(), roles.people.finance);
		expect(finance).toContain("Paid £32,000.00 a year.");
		expect(finance).toContain("Works number W-17.");
		expect(finance).not.toContain("Change contract");
		const data = await (await openData(page(), roles.people.finance)).text();
		expect(data).not.toContain('"sheets",{');
		expect((await give(roles.people.finance)).status).toBe(403);
		expect((await give(manager)).status).toBe(403);
	});

	it("is not one's own: an admin cannot give, change or end their own while another could; a sole owner can, and it says so", async () => {
		const grace = roles.people.admin;
		const ada = roles.people.owner;
		expect((await give(grace, {}, grace)).status).toBe(403);
		expect((await give(ada, {}, ada)).status).toBe(403);
		expect(await value<number>("select count(*) from contracts")).toBe(0);
		// Ada gives Grace hers; Grace still cannot change it.
		expect((await give(ada, {}, grace)).status).toBe(200);
		const [contract] = await theirs(grace);
		expect(
			(
				await ask(
					grace,
					{ intent: "end", contractId: contract?.id ?? "", lastDay: TODAY, reason: "resigned" },
					grace,
				)
			).status,
		).toBe(403);

		// With Grace an admin no longer, Ada is the only one who could: she changes her own.
		await env.DB.prepare("update memberships set role = 'member' where user_id = ?")
			.bind(grace.user.id)
			.run();
		expect((await give(ada, {}, ada)).status).toBe(200);
		expect(await text(page(ada), ada)).toContain(
			"Nobody else here can change your contract, so you change it yourself",
		);
		const summary = await value<string>(
			"select summary from activity_records where action = 'contract.created' and owner_id = ?",
			ada.user.id,
		);
		expect(JSON.parse(summary ?? "{}").after.changedAlone).toBe(true);
	});

	it("keeps a leaver's contract: removed from the organisation, their contract stays for those who read pay", async () => {
		const ada = roles.people.owner;
		expect((await give(ada, { endsOn: "2026-11-30", kind: "fixed_term" })).status).toBe(200);
		const memberId = await value<string>(
			"select id from memberships where user_id = ?",
			linus.user.id,
		);
		const removed = await submit(
			`/app/${acme.slug}/team/members`,
			{ intent: "remove", memberId: memberId ?? "" },
			ada,
			{ byScript: true },
		);
		expect(removed.status).toBe(200);
		expect(
			await value<number>("select count(*) from contracts where user_id = ?", linus.user.id),
		).toBe(1);
		const shown = await text(page(), ada);
		expect(shown).toContain("No longer a member. Their contracts are kept as payroll records.");
		expect(shown).toContain("Fixed term, from Monday 5 January 2026 to Monday 30 November 2026.");
		expect((await open(page(), roles.people.finance)).status).toBe(200);
		// Their manager no longer manages them.
		expect((await open(page(), roles.people.manager)).status).toBe(404);
	});

	it("gives, changes from a day and ends through its sheets, and says why it refuses", async () => {
		const ada = roles.people.owner;
		expect((await give(ada, { kind: "fixed_term" })).said).toContain(
			"A fixed term needs its last day.",
		);
		expect((await give(ada, { pay: "lots" })).said).toContain("Enter the pay as an amount");
		expect((await give(ada, { scheduleId: threeDays, jobTitle: "Designer" })).status).toBe(200);
		expect((await give(ada, { startsOn: "2026-06-01" })).said).toContain(
			"That shares days with their contract from Monday 5 January 2026.",
		);
		const [contract] = await theirs();
		const id = contract?.id ?? "";
		const changed = await ask(ada, {
			intent: "change",
			contractId: id,
			from: "2026-12-01",
			...terms({ pay: "34000", scheduleId: threeDays, jobTitle: "Designer" }),
		});
		expect(changed.said).toContain("The contract is changed, from Tuesday 1 December 2026.");
		const shown = await text(page(), ada);
		expect(shown).toContain("Permanent, part time, from Monday 5 January 2026.");
		expect(shown).toContain("Works 15:00 a week on Three days.");
		expect(shown).toContain("From Tuesday 1 December 2026: £34,000.00 a year.");
		const ended = await ask(ada, {
			intent: "end",
			contractId: id,
			lastDay: "2026-12-31",
			reason: "resigned",
		});
		expect(ended.said).toContain("The contract ends on Thursday 31 December 2026.");
		// A contract of somebody else's, named at this person's address, is nobody's here.
		const hedy = roles.people.manager;
		await give(ada, {}, hedy);
		const [hers] = await theirs(hedy);
		expect(
			(
				await ask(ada, {
					intent: "end",
					contractId: hers?.id ?? "",
					lastDay: TODAY,
					reason: "resigned",
				})
			).status,
		).toBe(404);
	});
});

describe("what a contract changes elsewhere", () => {
	it("the contract gives the hours: Team's week, Schedules and My account follow it, and Schedules refuses a manual assignment", async () => {
		const ada = roles.people.owner;
		expect((await give(ada, { scheduleId: threeDays })).status).toBe(200);
		const week = await text(`/app/${acme.slug}/team?person=${linus.user.id}`, roles.people.manager);
		expect(week).toContain("15:00 expected");
		expect(week).toContain("Work schedule: Three days");
		expect(week).toContain("From their contract");
		expect(await text(`/app/${acme.slug}/settings/schedules`, ada)).toContain(
			"From their contract",
		);
		expect(await text(`/app/${acme.slug}/account`, linus)).toContain("From your contract");

		const standard = await value<string>(
			"select id from work_schedules where organisation_id = ? and name = 'Standard'",
			acme.id,
		);
		const assign = await submit(
			`/app/${acme.slug}/settings/schedules`,
			{
				intent: "assign",
				targetKind: "person",
				targetId: linus.user.id,
				scheduleId: standard ?? "",
				from: "2026-11-16",
			},
			ada,
			{ byScript: true },
		);
		expect(assign.status).toBe(409);
		expect(await assign.text()).toContain("Their hours come from their contract on that day.");
	});

	it("Team's person view has Week and Contract tabs for those who read contracts", async () => {
		const week = await (
			await open(`/app/${acme.slug}/team?person=${linus.user.id}`, roles.people.manager)
		).text();
		expect(week).toContain('aria-label="Their pages"');
		expect(week).toContain(`href="${page()}"`);
		const contract = await (await open(page(), roles.people.manager)).text();
		expect(contract).toContain(`href="/app/${acme.slug}/team?person=${linus.user.id}"`);
		// Finance reads the contract without Team: no Week tab, no way back to Everyone's week.
		const finance = await (await open(page(), roles.people.finance)).text();
		expect(finance).not.toContain(`team?person=${linus.user.id}`);
		expect(finance).not.toContain("Everyone's week");
	});

	it("Members says No contract, or when a fixed term ends, links each contract, and hides Mark as contractor while a contract covers today", async () => {
		const ada = roles.people.owner;
		const members = `/app/${acme.slug}/team/members`;
		expect(await text(members, ada)).toContain("No contract");
		await give(ada, { kind: "fixed_term", endsOn: "2026-12-31" });
		const shown = await (await open(members, ada)).text();
		expect(textOf(shown)).toContain("Contract ends Thu 31 December");
		expect(shown).toContain(`href="${page()}"`);
		// The manager sees neither.
		expect(await text(members, roles.people.manager)).not.toContain("No contract");

		const memberId = await value<string>(
			"select id from memberships where user_id = ?",
			linus.user.id,
		);
		const marking = await submit(
			members,
			{ intent: "contractor", memberId: memberId ?? "", isContractor: "true" },
			ada,
			{ byScript: true },
		);
		expect(marking.status).toBe(409);
		expect(await marking.text()).toContain("Their contract says whether they are a contractor.");
		expect(
			await value<number>("select is_contractor from memberships where id = ?", memberId),
		).toBe(0);
	});

	it("My account shows the person their own contract, pay included, and their data export holds it", async () => {
		await give(roles.people.owner, { worksNumber: "W-17", jobTitle: "Designer" });
		const account = await text(`/app/${acme.slug}/account`, linus);
		expect(account).toContain("Your contract");
		expect(account).toContain("Paid £32,000.00 a year.");
		expect(account).toContain("Works number W-17.");
		// Hedy, with none, is told so.
		expect(await text(`/app/${acme.slug}/account`, roles.people.manager)).toContain(
			"You have no contract here.",
		);
	});
});

// The days of the leave year before a person's first contract (TS-098b,
// decision 76): the Give sheet asks how they count of someone who joined
// before it starts, suggests the usual allowance from 28 days after joining,
// shows the balance it makes before saving, and records the answer.
/** What a `contract.*` record holds, as far as these tests read it. */
const Recorded = z.object({ after: z.record(z.string(), z.unknown()).optional() });

const seedLeaveFor = (who: Person, startsOn: string, endsOn: string) =>
	seedLeave(acme.id, who.user.id, "annual", startsOn, endsOn);

describe("the days before a first contract", () => {
	/** Sets the day `who` joined Acme: noon, UTC, which is that day in London too. */
	const joined = (who: Person, day: string) =>
		env.DB.prepare(
			"update memberships set created_at = ? where organisation_id = ? and user_id = ?",
		)
			.bind(Date.parse(`${day}T12:00:00Z`), acme.id, who.user.id)
			.run();
	const giveFrom = (startsOn: string, of: Person, more: Record<string, string> = {}) =>
		ask(roles.people.owner, { intent: "give", startsOn, leaveDays: "25", ...terms(more) }, of);
	const preview = (startsOn: string, of: Person, more: Record<string, string> = {}) =>
		ask(roles.people.owner, { intent: "preview", startsOn, leaveDays: "25", ...terms(more) }, of);
	/** What `contract.created` recorded of how the days before count; undefined where it was not asked. */
	const answered = async (who: Person) => {
		const summary = await value<string>(
			"select summary from activity_records where organisation_id = ? and action = 'contract.created' and owner_id = ?",
			acme.id,
			who.user.id,
		);
		return Recorded.parse(JSON.parse(summary ?? "{}")).after?.priorDaysAtAllowance;
	};
	const stored = async (who: Person) => (await theirs(who))[0]?.priorDaysAtAllowance;
	/** This leave year's balance on the Contract page, and in the words the preview uses. */
	async function balanceOf(who: Person) {
		const annual = await annualLeaveOf(scope(), who.user.id);
		if (!annual) throw new Error("No annual leave.");
		return annualLeftWords(annual, 2026);
	}

	it("the first answer keeps this leave year's balance; the second counts nothing before the contract", async () => {
		const hedy = roles.people.manager;
		await joined(linus, "2026-03-02");
		await joined(hedy, "2026-03-02");
		// Before: today's 25 days of the kind's allowance, on Time off.
		expect(await balanceOf(linus)).toBe("25 days");

		expect((await preview("2026-11-16", linus, { priorDays: "allowance" })).said).toContain(
			"This year: 25 days → 25 days",
		);
		expect((await giveFrom("2026-11-16", linus, { priorDays: "allowance" })).status).toBe(200);
		expect(await stored(linus)).toBe(true);
		expect(await answered(linus)).toBe(true);
		const shown = await text(page(linus), roles.people.owner);
		expect(shown).toContain("From the contract: 25 days this leave year.");
		expect(shown).toContain("25 days left");

		// 16 November to 31 December is 46 days of 365: 25 × 46 ÷ 365 = 3.15, rounded up to 3.5.
		expect((await preview("2026-11-16", hedy, { priorDays: "nothing" })).said).toContain(
			"This year: 25 days → 3.5 days",
		);
		expect((await giveFrom("2026-11-16", hedy, { priorDays: "nothing" })).status).toBe(200);
		expect(await stored(hedy)).toBe(false);
		expect(await answered(hedy)).toBe(false);
		expect(await text(page(hedy), roles.people.owner)).toContain("3.5 days left");
		// The activity log says it in words.
		expect(
			await text(`/app/${acme.slug}/activity?from=2026-01-01&to=2026-12-31`, roles.people.owner),
		).toContain("Earlier this leave year counts at the usual allowance");
	});

	it("suggests the usual allowance when they joined 28 days or more before it starts, and nothing when fewer", async () => {
		const hedy = roles.people.manager;
		// Unanswered, the server takes the answer the sheet suggests.
		await joined(linus, "2026-11-02");
		expect((await giveFrom("2026-11-30", linus)).status).toBe(200);
		expect(await stored(linus)).toBe(true);
		await joined(hedy, "2026-11-03");
		expect((await giveFrom("2026-11-30", hedy)).status).toBe(200);
		expect(await stored(hedy)).toBe(false);
		// The page sends the sheet the day they joined, and whether they have a contract.
		const sent = await (await openData(page(roles.people.finance), roles.people.owner)).text();
		expect(sent).toContain("joinedOn");
	});

	it("is not asked of a second contract, nor of someone who joins on or after its first day", async () => {
		const hedy = roles.people.manager;
		await joined(linus, "2026-01-05");
		await giveFrom("2026-01-05", linus, { endsOn: "2026-06-30", priorDays: "allowance" });
		expect(await stored(linus)).toBe(false);
		expect(await answered(linus)).toBeUndefined();
		await giveFrom("2026-07-01", linus, { priorDays: "allowance" });
		expect((await theirs(linus)).map((c) => c.priorDaysAtAllowance)).toEqual([false, false]);
		await joined(hedy, "2026-11-20");
		await giveFrom("2026-11-16", hedy, { priorDays: "allowance" });
		expect(await stored(hedy)).toBe(false);
	});

	it("previews the balance the contract has once saved, whatever its day, hours, days and answer", async () => {
		const people = [linus, roles.people.manager, roles.people.finance, roles.people.admin];
		const cases: ({ startsOn: string } & Record<string, string>)[] = [
			{ startsOn: "2026-11-16", priorDays: "allowance", scheduleId: threeDays },
			{ startsOn: "2026-06-01", priorDays: "nothing", scheduleId: "" },
			{ startsOn: "2026-12-01", priorDays: "allowance", leaveDays: "30" },
			{ startsOn: "2026-02-02", priorDays: "nothing", scheduleId: threeDays },
		];
		for (const [index, { startsOn, ...more }] of cases.entries()) {
			const who = people[index];
			if (!who) throw new Error("Nobody.");
			await joined(who, "2026-01-05");
			await seedLeaveFor(who, "2026-03-09", "2026-03-11");
			const said = (await preview(startsOn, who, more)).said;
			const shown = /This year: (.+?) → (.+?)(?:"|\\|$)/.exec(said);
			expect(shown?.[1], said).toBe("22 days");
			expect((await giveFrom(startsOn, who, more)).status).toBe(200);
			const after = await balanceOf(who);
			expect(shown?.[2], JSON.stringify(cases[index])).toBe(after);
			expect(await text(page(who), roles.people.owner)).toContain(`${after} left`);
		}
	});
});

// A stretch between two contracts has no terms, and UK holiday accrues only
// while employed: it counts nothing (decision 76). A Give or Change that
// leaves one this leave year previews its effect on the balance.
describe("a gap between contracts", () => {
	const said = async (fields: Record<string, string>) =>
		(await ask(roles.people.owner, { intent: "preview", leaveDays: "25", ...terms(fields) })).said;
	const thisYear = async () => {
		const annual = await annualLeaveOf(scope(), linus.user.id);
		if (!annual) throw new Error("No annual leave.");
		return annualLeftWords(annual, 2026);
	};

	it("counts nothing, and the Give and Change sheets preview it before it is saved", async () => {
		const first = { kind: "fixed_term", endsOn: "2026-06-30", leaveDays: "25" };
		expect((await give(roles.people.owner, first)).status).toBe(200);
		// 5 January to 30 June, 177 days of 365: 25 × 177 ÷ 365 = 12.1, rounded up to 12.5.
		expect(await thisYear()).toBe("12.5 days");

		// From 3 August, 151 days more; July and 1 and 2 August give nothing.
		expect(await said({ startsOn: "2026-08-03" })).toContain("This year: 12.5 days → 22.5 days");
		const second = await ask(roles.people.owner, {
			intent: "give",
			startsOn: "2026-08-03",
			leaveDays: "25",
			...terms(),
		});
		expect(second.status, second.said).toBe(200);
		expect(await thisYear()).toBe("22.5 days");
		expect(await text(page(), roles.people.owner)).toContain("22.5 days left");

		const [before] = await theirs();
		if (!before) throw new Error("No contract.");
		const change = (endsOn: string) =>
			said({ contractId: before.id, from: "2026-01-05", ...first, endsOn });
		// Ending the first a month sooner widens the gap: 147 days and 151, 20.5 days.
		expect(await change("2026-05-31")).toContain("This year: 22.5 days → 20.5 days");
		// Closing it leaves none, and the sheet says nothing.
		expect(await change("2026-08-02")).not.toContain("This year");
		// A contract that is not theirs previews nothing.
		expect(
			await said({
				contractId: "not-a-contract",
				from: "2026-01-05",
				...first,
				endsOn: "2026-05-31",
			}),
		).not.toContain("This year");
		// Nothing was saved.
		expect(await thisYear()).toBe("22.5 days");
	});

	it("previews nothing for a change that leaves no gap", async () => {
		expect((await give(roles.people.owner, { leaveDays: "25" })).status).toBe(200);
		const [only] = await theirs();
		if (!only) throw new Error("No contract.");
		expect(await said({ contractId: only.id, from: "2026-11-09", leaveDays: "30" })).not.toContain(
			"This year",
		);
	});
});
