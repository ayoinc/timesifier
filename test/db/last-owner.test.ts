import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { seedMember, seedOrganisation, value } from "../organisations/harness";
import { freshDatabase } from "./database";

// An organisation always has at least one owner, and the database holds that
// itself (migrations/0004). Better Auth counts the owners and then writes in a
// second statement, so two owners who remove or demote each other in the same
// instant would both pass its check. The statements here are the ones those
// two requests would run, sent as they would arrive: with nothing in between.

const REFUSAL = /an organisation keeps at least one owner/;

const owners = (organisationId: string) =>
	value(
		"select count(*) from memberships where organisation_id = ? and role = 'owner'",
		organisationId,
	);
const members = (organisationId: string) =>
	value("select count(*) from memberships where organisation_id = ?", organisationId);

const remove = (memberId: string) =>
	env.DB.prepare("delete from memberships where id = ?").bind(memberId);
const demote = (memberId: string, role = "member") =>
	env.DB.prepare("update memberships set role = ? where id = ?").bind(role, memberId);

/** Acme with two owners and one member. */
async function acme() {
	const organisation = await seedOrganisation();
	const ada = await seedMember(organisation.id, "owner", "ada@example.com");
	const grace = await seedMember(organisation.id, "owner", "grace@example.com");
	const linus = await seedMember(organisation.id, "member", "linus@example.com");
	return { organisation, ada, grace, linus };
}

beforeEach(async () => {
	await freshDatabase();
});

describe("two owners acting on each other in the same instant", () => {
	it("removing each other as one batch: the batch is refused and both are still owners", async () => {
		const { organisation, ada, grace } = await acme();

		await expect(env.DB.batch([remove(ada.memberId), remove(grace.memberId)])).rejects.toThrow(
			REFUSAL,
		);

		expect(await owners(organisation.id)).toBe(2);
		expect(await members(organisation.id)).toBe(3);
	});

	it("demoting each other as one batch: the batch is refused and both are still owners", async () => {
		const { organisation, ada, grace } = await acme();

		await expect(env.DB.batch([demote(ada.memberId), demote(grace.memberId)])).rejects.toThrow(
			REFUSAL,
		);

		expect(await owners(organisation.id)).toBe(2);
	});

	it("one removing while the other demotes: the batch is refused", async () => {
		const { organisation, ada, grace } = await acme();

		await expect(
			env.DB.batch([remove(ada.memberId), demote(grace.memberId, "admin")]),
		).rejects.toThrow(REFUSAL);

		expect(await owners(organisation.id)).toBe(2);
	});

	it("removing each other one after the other: the first goes, the second is refused, one owner remains", async () => {
		const { organisation, ada, grace } = await acme();

		const outcomes = await Promise.allSettled([
			remove(ada.memberId).run(),
			remove(grace.memberId).run(),
		]);

		expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(await owners(organisation.id)).toBe(1);
		expect(await members(organisation.id)).toBe(2);
	});

	it("demoting each other one after the other: one is refused and one owner remains", async () => {
		const { organisation, ada, grace } = await acme();

		const outcomes = await Promise.allSettled([
			demote(ada.memberId).run(),
			demote(grace.memberId).run(),
		]);

		expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(await owners(organisation.id)).toBe(1);
		expect(await members(organisation.id)).toBe(3);
	});
});

describe("the last owner", () => {
	it("cannot be removed, demoted or moved to another organisation, in any one statement", async () => {
		const { organisation, ada, grace } = await acme();
		const other = await seedOrganisation("Globex", "globex");
		await remove(ada.memberId).run();

		await expect(remove(grace.memberId).run()).rejects.toThrow(REFUSAL);
		await expect(demote(grace.memberId).run()).rejects.toThrow(REFUSAL);
		await expect(demote(grace.memberId, "admin").run()).rejects.toThrow(REFUSAL);
		await expect(
			env.DB.prepare("update memberships set organisation_id = ? where id = ?")
				.bind(other.id, grace.memberId)
				.run(),
		).rejects.toThrow(REFUSAL);
		// Every membership at once, the owner's among them.
		await expect(
			env.DB.prepare("delete from memberships where organisation_id = ?")
				.bind(organisation.id)
				.run(),
		).rejects.toThrow(REFUSAL);

		expect(await owners(organisation.id)).toBe(1);
		expect(await members(organisation.id)).toBe(2);
	});

	it("is not removed with their account while the organisation stands", async () => {
		const { organisation, ada, grace } = await acme();
		await remove(ada.memberId).run();

		await expect(
			env.DB.prepare("delete from users where id = ?").bind(grace.userId).run(),
		).rejects.toThrow(REFUSAL);

		expect(await owners(organisation.id)).toBe(1);
	});
});

describe("what the triggers leave alone", () => {
	it("an owner goes while another remains, and a member or an admin goes at any time", async () => {
		const { organisation, ada, linus } = await acme();

		await remove(ada.memberId).run();
		await remove(linus.memberId).run();

		expect(await owners(organisation.id)).toBe(1);
		expect(await members(organisation.id)).toBe(1);
	});

	it("an owner is demoted while another remains, and a member is promoted", async () => {
		const { organisation, ada, linus } = await acme();

		await demote(ada.memberId, "admin").run();
		await demote(linus.memberId, "owner").run();

		expect(await owners(organisation.id)).toBe(2);
	});

	it("a change to an owner's row that keeps them an owner", async () => {
		const { organisation, ada, grace } = await acme();
		await remove(ada.memberId).run();

		await env.DB.prepare("update memberships set role = 'owner', updated_at = 1 where id = ?")
			.bind(grace.memberId)
			.run();

		expect(await owners(organisation.id)).toBe(1);
	});

	it("deleting the organisation takes every membership with it, the last owner's too", async () => {
		const { organisation } = await acme();
		const other = await seedOrganisation("Globex", "globex");
		await seedMember(other.id, "owner", "hedy@example.com");

		await env.DB.prepare("delete from organisations where id = ?").bind(organisation.id).run();

		expect(await members(organisation.id)).toBe(0);
		expect(await members(other.id)).toBe(1);
	});
});
