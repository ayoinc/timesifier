import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { nextPatternCodes } from "~/projects/projects.server";
import { freshDatabase } from "../db/database";
import { value } from "../organisations/harness";

// The pattern an organisation numbers its projects by (TS-115a, decision 67),
// for example PRJ-0001: each call takes its block of numbers in one statement,
// passes over a code a project already has or one about to be stored, and two
// creations at once never get the same number.

const ACME = "org-acme";
let scope: OrganisationScope;

beforeEach(async () => {
	await freshDatabase();
	await env.DB.prepare(
		"insert into organisations (id, name, slug, created_at, updated_at) values (?, 'Acme', 'acme', 0, 0)",
	)
		.bind(ACME)
		.run();
	scope = organisationScope(env.DB, ACME);
});

/** Numbers Acme's projects by `pattern`, the next number being `next`. */
async function numberBy(pattern: string, next: number) {
	await env.DB.prepare(
		"update organisations set project_code_pattern = ?, project_code_next = ? where id = ?",
	)
		.bind(pattern, next, ACME)
		.run();
}

async function seedProject(name: string, code: string) {
	await scope.projects.insert({
		name,
		nameKey: name.toLowerCase(),
		code,
		codeKey: code.toLowerCase(),
	});
}

const next = () => value("select project_code_next from organisations where id = ?", ACME);

describe("nextPatternCodes", () => {
	it("gives none where the organisation has no pattern", async () => {
		expect(await nextPatternCodes(scope, 3)).toEqual([]);
		expect(await next()).toBeNull();
	});

	it("takes the block of numbers asked for in one statement, and the next call goes on from it", async () => {
		await numberBy("PRJ-0001", 1);
		const spy = vi.spyOn(env.DB, "prepare");
		expect(await nextPatternCodes(scope, 3)).toEqual(["PRJ-0001", "PRJ-0002", "PRJ-0003"]);
		const updates = spy.mock.calls.filter(([sql]) => /^update "organisations"/i.test(sql));
		expect(updates).toHaveLength(1);
		spy.mockRestore();
		expect(await next()).toBe(4);
		expect(await nextPatternCodes(scope, 1)).toEqual(["PRJ-0004"]);
	});

	it("widens a number past its digits", async () => {
		await numberBy("W-98", 98);
		expect(await nextPatternCodes(scope, 3)).toEqual(["W-98", "W-99", "W-100"]);
	});

	it("passes over a code a project already has, in any case, and one about to be stored", async () => {
		await numberBy("PRJ-0001", 1);
		await seedProject("Typed", "prj-0002");
		await seedProject("Archived", "PRJ-0003");
		const codes = await nextPatternCodes(scope, 3, new Set(["prj-0005"]));
		expect(codes).toEqual(["PRJ-0001", "PRJ-0004", "PRJ-0006"]);
		expect(await next()).toBe(7);
	});

	it("never passes over a code another organisation has", async () => {
		await env.DB.prepare(
			"insert into organisations (id, name, slug, created_at, updated_at) values ('org-initech', 'Initech', 'initech', 0, 0)",
		).run();
		await organisationScope(env.DB, "org-initech").projects.insert({
			name: "Theirs",
			nameKey: "theirs",
			code: "PRJ-0001",
			codeKey: "prj-0001",
		});
		await numberBy("PRJ-0001", 1);
		expect(await nextPatternCodes(scope, 1)).toEqual(["PRJ-0001"]);
	});

	it("gives two creations at once different numbers", async () => {
		await numberBy("PRJ-0001", 1);
		const both = await Promise.all([
			nextPatternCodes(scope, 2),
			nextPatternCodes(scope, 2),
			nextPatternCodes(scope, 1),
		]);
		const all = both.flat();
		expect(all).toHaveLength(5);
		expect(new Set(all).size).toBe(5);
		expect([...all].sort()).toEqual(["PRJ-0001", "PRJ-0002", "PRJ-0003", "PRJ-0004", "PRJ-0005"]);
		expect(await next()).toBe(6);
	});
});
