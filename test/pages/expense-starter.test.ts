import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { askToAddCategories } from "~/expenses/expenses";
import {
	HMRC_CAR_MILEAGE_PENCE,
	HMRC_MILEAGE_RATES,
	USUAL_CATEGORIES,
	usualCategories,
} from "~/expenses/starter";

import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { seedMembership, seedNoCategories, value } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";
import { KINDS, type Kind, seedRoles } from "./roles-seed";

// The usual expense categories (TS-119, S2-05): a new organisation has them
// from the start, Mileage at HMRC's rate for cars in a GBP organisation; an
// owner or admin of one with none adds them with one action, once however
// often it is pressed; and anyone else who finds none is told who can add
// them, by name. Each addition is in the Activity log.

const EXPENSES = "/app/acme/expenses";
const SETTINGS = "/app/acme/settings";
const ADD = "Add the usual categories";
/** A Wednesday: the server's clock for the tests that need one. */
const T0 = Date.parse("2026-11-11T10:00:00Z");

let mailbox: Mailbox;
let acme: { id: string };
let people: Record<Kind, Person>;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	const seeded = await seedRoles(mailbox);
	acme = seeded.acme;
	people = seeded.people;
	await env.DB.prepare("update users set name = ? where id = ?")
		.bind("Ada Lovelace", people.owner.user.id)
		.run();
	await env.DB.prepare("update users set name = ? where id = ?")
		.bind("Grace Hopper", people.admin.user.id)
		.run();
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const count = (sql: string) => value<number>(sql, acme.id);
const categories = () => count("select count(*) from expense_categories where organisation_id = ?");
const created = () =>
	count(
		"select count(*) from activity_records where organisation_id = ? and action = 'expense_category.created'",
	);

async function textAt(path: string, who: Person) {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
}

async function ask(who: Person, fields: Record<string, string>, path = SETTINGS) {
	const response = await submit(path, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

describe("HMRC's rate", () => {
	it("is 45p a mile for cars from 6 April 2011 and 55p from 6 April 2026, as GOV.UK publishes it", () => {
		expect(HMRC_MILEAGE_RATES).toBe(
			"https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances/travel-mileage-and-fuel-rates-and-allowances",
		);
		expect(HMRC_CAR_MILEAGE_PENCE).toEqual([
			{ effectiveFrom: "2011-04-06", unitPriceMinor: 45 },
			{ effectiveFrom: "2026-04-06", unitPriceMinor: 55 },
		]);
	});

	it("prices Mileage only in GBP; in another currency it is an amount each time", () => {
		for (const currency of ["GBP", "EUR", "USD", "JPY"]) {
			const set = usualCategories(currency);
			expect(set.map((c) => c.name)).toEqual([...USUAL_CATEGORIES]);
			const mileage = set.find((c) => c.name === "Mileage");
			expect(mileage?.unit, currency).toEqual(
				currency === "GBP" ? { name: "mile", prices: HMRC_CAR_MILEAGE_PENCE } : null,
			);
			expect(set.filter((c) => c.unit !== null).length).toBe(currency === "GBP" ? 1 : 0);
		}
	});
});

describe("a new organisation", () => {
	it("has the usual eight categories, active, with Mileage at HMRC's rate, each recorded as the system's", async () => {
		const rows = await env.DB.prepare(
			"select name, unit_name, unit_price_minor, archived_at from expense_categories where organisation_id = ? order by name_key",
		)
			.bind(acme.id)
			.all();
		expect(rows.results).toEqual(
			[...USUAL_CATEGORIES]
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
				.map((name) => ({
					name,
					unit_name: name === "Mileage" ? "mile" : null,
					unit_price_minor: name === "Mileage" ? 55 : null,
					archived_at: null,
				})),
		);
		const prices = await env.DB.prepare(
			"select p.effective_from, p.unit_price_minor from expense_category_prices p join expense_categories c on c.id = p.category_id where c.organisation_id = ? and c.name = 'Mileage' order by p.effective_from",
		)
			.bind(acme.id)
			.all();
		expect(prices.results).toEqual([
			{ effective_from: "2011-04-06", unit_price_minor: 45 },
			{ effective_from: "2026-04-06", unit_price_minor: 55 },
		]);

		const records = await env.DB.prepare(
			"select actor_id, source, subject_type, summary from activity_records where organisation_id = ? and action = 'expense_category.created'",
		)
			.bind(acme.id)
			.all<{ actor_id: string | null; source: string; subject_type: string; summary: string }>();
		expect(records.results).toHaveLength(8);
		for (const record of records.results) {
			expect(record).toMatchObject({
				actor_id: null,
				source: "system",
				subject_type: "expense_category",
			});
		}
		expect(records.results.map((r) => JSON.parse(r.summary))).toContainEqual({
			after: { name: "Mileage", unitName: "mile", unitPriceMinor: 55, effectiveFrom: "2026-04-06" },
		});
	});

	it("lets a member record an expense in Travel on the first visit", async () => {
		vi.spyOn(Date, "now").mockReturnValue(T0);
		await env.DB.prepare(
			"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Apex', 'apex', 0, 0)",
		)
			.bind(crypto.randomUUID(), acme.id)
			.run();
		const text = await textAt(EXPENSES, people.member);
		expect(text).toContain("Record expense");
		expect(text).not.toContain("There are no expense categories");
	});
});

describe("an organisation with no categories", () => {
	beforeEach(async () => {
		await seedNoCategories(acme.id);
	});

	it("offers owners and admins the usual categories; Finance, managers and members are told who can add them, by name", async () => {
		for (const kind of KINDS) {
			const text = await textAt(EXPENSES, people[kind]);
			if (kind === "owner" || kind === "admin") {
				expect(text, kind).toContain(ADD);
				expect(text, kind).toContain("Workspace settings");
			} else {
				expect(text, kind).not.toContain(ADD);
				expect(text, kind).toContain(
					"There are no expense categories to record in yet. Ask Ada Lovelace or Grace Hopper to add them.",
				);
				expect(text, kind).not.toContain("Workspace settings");
			}
		}
		const settings = await textAt(SETTINGS, people.owner);
		expect(settings).toContain(ADD);
	});

	it("adds the eight once for an owner, and records each as theirs; a second press adds and records nothing", async () => {
		const before = await created();
		const first = await ask(people.owner, { intent: "add-usual-categories" });
		expect(first.status).toBe(200);
		expect(first.said).toContain("8 expense categories added.");
		expect(await categories()).toBe(8);
		expect(await created()).toBe((before ?? 0) + 8);
		expect(
			await value(
				"select count(*) from activity_records where organisation_id = ? and action = 'expense_category.created' and actor_id = ? and source = 'web'",
				acme.id,
				people.owner.user.id,
			),
		).toBe(8);

		const again = await ask(people.admin, { intent: "add-usual-categories" });
		expect(again.status).toBe(409);
		expect(again.said).toContain("The organisation has categories now");
		expect(await categories()).toBe(8);
		expect(await created()).toBe((before ?? 0) + 8);
		// No longer offered once there are categories.
		expect(await textAt(SETTINGS, people.owner)).not.toContain(ADD);
	});

	it("adds them once when two presses arrive together", async () => {
		const before = (await created()) ?? 0;
		const answers = await Promise.all([
			ask(people.owner, { intent: "add-usual-categories" }),
			ask(people.admin, { intent: "add-usual-categories" }),
		]);
		expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
		expect(await categories()).toBe(8);
		expect(await created()).toBe(before + 8);
	});

	it("refuses Finance, managers and members, who cannot open Workspace settings", async () => {
		for (const kind of ["finance", "manager", "member"] as const) {
			expect((await ask(people[kind], { intent: "add-usual-categories" })).status, kind).toBe(404);
		}
		expect(await categories()).toBe(0);
	});

	it("is not offered when an archived category is all there is, which the settings restore", async () => {
		await ask(people.owner, { intent: "add-category", name: "Hotels" });
		const id = await value<string>(
			"select id from expense_categories where organisation_id = ?",
			acme.id,
		);
		await ask(people.owner, { intent: "archive-category", categoryId: id ?? "" });
		const text = await textAt(EXPENSES, people.owner);
		expect(text).not.toContain(ADD);
		expect(text).toContain("Add them in Workspace settings");
		expect((await ask(people.owner, { intent: "add-usual-categories" })).status).toBe(409);
	});

	it("leaves Mileage unpriced in a currency other than GBP", async () => {
		await env.DB.prepare("update organisations set currency = 'EUR' where id = ?")
			.bind(acme.id)
			.run();
		expect((await ask(people.owner, { intent: "add-usual-categories" })).status).toBe(200);
		expect(
			await value(
				"select count(*) from expense_categories where organisation_id = ? and unit_name is not null",
				acme.id,
			),
		).toBe(0);
		expect(
			await value(
				"select count(*) from expense_category_prices where organisation_id = ?",
				acme.id,
			),
		).toBe(0);
	});
});

describe("who can add categories", () => {
	it("names the first three owners and admins, owners first, and counts the rest", async () => {
		await seedNoCategories(acme.id);
		for (const email of ["linnea@example.com", "mae@example.com", "nell@example.com"]) {
			const admin = await person(mailbox, email);
			await seedMembership(acme.id, admin.user.id, "admin");
		}
		expect(await textAt(EXPENSES, people.member)).toContain(
			"Ask Ada Lovelace, Grace Hopper, linnea@example.com or one of the 2 other owners and admins to add them.",
		);
	});

	it("says so in a sentence however many there are", () => {
		const lead = "There are no expense categories to record in yet.";
		expect(askToAddCategories({ names: [], others: 0 })).toBe(
			`${lead} An owner or admin adds them.`,
		);
		expect(askToAddCategories({ names: ["Ada"], others: 0 })).toBe(`${lead} Ask Ada to add them.`);
		expect(askToAddCategories({ names: ["Ada", "Grace"], others: 0 })).toBe(
			`${lead} Ask Ada or Grace to add them.`,
		);
		expect(askToAddCategories({ names: ["Ada", "Grace", "Linnea"], others: 1 })).toBe(
			`${lead} Ask Ada, Grace, Linnea or another owner or admin to add them.`,
		);
	});
});
