import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { organisationScope, uuidv7 } from "~/db";
import { memberships, organisations, users } from "~/db/schema";
import { DEFAULT_KINDS, KIND_KEYS, type KindKey } from "~/leave/kinds";
import { freshDatabase } from "./database";

// The tables of leave (TS-061): every organisation starts with the six kinds
// and a working week of Monday to Friday, 7.5 hours, however it is made; each
// row belongs to one organisation; a reference stays inside it; and the rules
// the database holds by itself hold.

let database: D1Database;

beforeEach(async () => {
	database = await freshDatabase();
});

/** The message of the error a promise rejects with, or null when it resolves. */
async function refusal(promise: Promise<unknown>): Promise<string | null> {
	try {
		await promise;
		return null;
	} catch (error) {
		// Drizzle wraps D1's error, which names the constraint, as its cause.
		if (error instanceof Error && error.cause instanceof Error) return error.cause.message;
		return String(error);
	}
}

/** Acme and Globex, with Ada in Acme and Bola in Globex. */
async function seed() {
	const db = drizzle(database);
	const [acme, globex] = await db
		.insert(organisations)
		.values([
			{ name: "Acme", slug: "acme" },
			{ name: "Globex", slug: "globex" },
		])
		.returning();
	const [ada, bola] = await db
		.insert(users)
		.values([
			{ name: "Ada", email: "ada@example.com" },
			{ name: "Bola", email: "bola@example.com" },
		])
		.returning();
	if (!acme || !globex || !ada || !bola) throw new Error("seed failed");
	await db.insert(memberships).values([
		{ organisationId: acme.id, userId: ada.id, role: "member" },
		{ organisationId: globex.id, userId: bola.id, role: "member" },
	]);
	const kindOf = async (organisationId: string, key: KindKey) => {
		const [kind] = await organisationScope(database, organisationId).leaveKinds.select((k) =>
			eq(k.key, key),
		);
		if (!kind) throw new Error(`no ${key} kind`);
		return kind;
	};
	return {
		acme,
		globex,
		ada,
		bola,
		acmeAnnual: await kindOf(acme.id, "annual"),
		globexAnnual: await kindOf(globex.id, "annual"),
	};
}

describe("a new organisation", () => {
	it("has the six kinds of leave, as the app's defaults say", async () => {
		const { acme } = await seed();
		const kinds = await organisationScope(database, acme.id).leaveKinds.select();
		expect(
			kinds
				.map(({ key, name, enabled, needsApproval, allowanceHalfDays }) => ({
					key,
					name,
					enabled,
					needsApproval,
					allowanceHalfDays,
				}))
				.sort((a, b) => KIND_KEYS.indexOf(a.key as KindKey) - KIND_KEYS.indexOf(b.key as KindKey)),
		).toEqual(KIND_KEYS.map((key) => ({ key, enabled: true, ...DEFAULT_KINDS[key] })));
		// Each id is a UUID version 7, and its own.
		for (const kind of kinds) {
			expect(kind.id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
		}
		expect(new Set(kinds.map((k) => k.id)).size).toBe(6);
	});

	it("has a working week of Monday to Friday, 7.5 hours a day", async () => {
		const { acme, globex } = await seed();
		for (const organisationId of [acme.id, globex.id]) {
			const week = await organisationScope(database, organisationId).workingDays.select(undefined, {
				orderBy: (d) => [asc(d.weekday)],
			});
			expect(week.map((d) => [d.weekday, d.minutes])).toEqual([
				[1, 450],
				[2, 450],
				[3, 450],
				[4, 450],
				[5, 450],
				[6, 0],
				[7, 0],
			]);
		}
	});

	it("made by plain SQL gets them too, and loses them with the organisation", async () => {
		const id = uuidv7();
		await database
			.prepare(
				"insert into organisations (id, name, slug, created_at, updated_at) values (?, 'Initech', 'initech', 0, 0)",
			)
			.bind(id)
			.run();
		const count = async (table: string) =>
			(await database
				.prepare(`select count(*) as n from ${table} where organisation_id = ?`)
				.bind(id)
				.first<number>("n")) ?? 0;
		expect([await count("leave_kinds"), await count("working_days")]).toEqual([6, 7]);
		await database.prepare("delete from organisations where id = ?").bind(id).run();
		expect([await count("leave_kinds"), await count("working_days")]).toEqual([0, 0]);
	});
});

describe("each table of leave", () => {
	it.each(["leaveKinds", "leaveRequests", "publicHolidays", "workingDays"] as const)(
		"%s: the scope of one organisation holds none of another's rows",
		async (name) => {
			const { acme, globex, ada, bola, acmeAnnual, globexAnnual } = await seed();
			for (const [organisationId, userId, kindId] of [
				[acme.id, ada.id, acmeAnnual.id],
				[globex.id, bola.id, globexAnnual.id],
			] as const) {
				const scope = organisationScope(database, organisationId);
				await scope.leaveRequests.insert({
					userId,
					kindId,
					startsOn: "2026-11-16",
					endsOn: "2026-11-20",
					status: "pending",
				});
				await scope.publicHolidays.insert({ day: "2026-12-25", name: "Christmas Day" });
			}

			const ofAcme = await organisationScope(database, acme.id)[name].select();
			const ofGlobex = await organisationScope(database, globex.id)[name].select();
			expect(ofAcme.length).toBeGreaterThan(0);
			expect(ofAcme.every((row) => row.organisationId === acme.id)).toBe(true);
			expect(ofGlobex.every((row) => row.organisationId === globex.id)).toBe(true);
			const ids = new Set(ofAcme.map((row) => row.id));
			expect(ofGlobex.some((row) => ids.has(row.id))).toBe(false);
		},
	);
});

describe("a request for leave", () => {
	it("cannot take a kind of another organisation", async () => {
		const { acme, ada, acmeAnnual, globexAnnual } = await seed();
		const scope = organisationScope(database, acme.id);
		const request = {
			userId: ada.id,
			startsOn: "2026-11-16",
			endsOn: "2026-11-20",
			status: "pending",
		};

		expect(
			await refusal(scope.leaveRequests.insert({ ...request, kindId: globexAnnual.id })),
		).toContain("FOREIGN KEY");
		const [made] = await scope.leaveRequests.insert({ ...request, kindId: acmeAnnual.id });
		expect(
			await refusal(
				scope.leaveRequests.update({ kindId: globexAnnual.id }, (r) => eq(r.id, made?.id ?? "")),
			),
		).toContain("FOREIGN KEY");
	});

	it("cannot be made for a person who is not a member", async () => {
		const { acme, bola, acmeAnnual } = await seed();
		expect(
			await refusal(
				organisationScope(database, acme.id).leaveRequests.insert({
					userId: bola.id,
					kindId: acmeAnnual.id,
					startsOn: "2026-11-16",
					endsOn: "2026-11-20",
					status: "pending",
				}),
			),
		).toContain("FOREIGN KEY");
	});

	it.each([
		["a status that is not one", { status: "maybe" }, "leave_requests_status_known"],
		[
			"a last day before the first",
			{ endsOn: "2026-11-15" },
			"leave_requests_ends_on_or_after_start",
		],
		[
			"a second half on a request of one day",
			{ endsOn: "2026-11-16", endsHalf: true },
			"leave_requests_one_half_on_one_day",
		],
	])("is refused with %s", async (_, change, constraint) => {
		const { acme, ada, acmeAnnual } = await seed();
		expect(
			await refusal(
				organisationScope(database, acme.id).leaveRequests.insert({
					userId: ada.id,
					kindId: acmeAnnual.id,
					startsOn: "2026-11-16",
					endsOn: "2026-11-20",
					status: "pending",
					...change,
				}),
			),
		).toContain(constraint);
	});

	it("goes when its person leaves the organisation, or its kind goes", async () => {
		const { acme, ada, acmeAnnual } = await seed();
		const scope = organisationScope(database, acme.id);
		await scope.leaveRequests.insert({
			userId: ada.id,
			kindId: acmeAnnual.id,
			startsOn: "2026-11-16",
			endsOn: "2026-11-20",
			status: "approved",
		});
		await drizzle(database).delete(memberships).where(eq(memberships.userId, ada.id));
		expect(await scope.leaveRequests.select()).toEqual([]);
	});
});

describe("the rules the database holds", () => {
	it("has one kind of each key, and one public holiday a day, in an organisation", async () => {
		const { acme, globex } = await seed();
		const scope = organisationScope(database, acme.id);
		expect(
			await refusal(
				scope.leaveKinds.insert({ key: "annual", name: "Annual again", allowanceHalfDays: 10 }),
			),
		).toContain("UNIQUE");
		await scope.publicHolidays.insert({ day: "2026-12-25", name: "Christmas Day" });
		expect(
			await refusal(scope.publicHolidays.insert({ day: "2026-12-25", name: "Christmas" })),
		).toContain("UNIQUE");
		// Another organisation has its own.
		await organisationScope(database, globex.id).publicHolidays.insert({
			day: "2026-12-25",
			name: "Christmas Day",
		});
	});

	it.each([
		["a kind that is not one", { key: "bank" }, "leave_kinds_key_known"],
		["an allowance over two years", { allowanceHalfDays: 731 }, "leave_kinds_allowance_in_range"],
		["an allowance below nothing", { allowanceHalfDays: -1 }, "leave_kinds_allowance_in_range"],
	])("refuses %s", async (_, change, constraint) => {
		const { acme } = await seed();
		const id = uuidv7();
		const values = { key: "annual", allowanceHalfDays: 50, ...change };
		expect(
			await refusal(
				database
					.prepare(
						"insert into leave_kinds (id, organisation_id, key, name, allowance_half_days, created_at, updated_at) values (?, ?, ?, 'X', ?, 0, 0)",
					)
					.bind(id, acme.id, values.key, values.allowanceHalfDays)
					.run(),
			),
		).toContain(constraint);
	});

	it.each([
		[0, 450, "working_days_weekday_in_range"],
		[8, 450, "working_days_weekday_in_range"],
		[1, 1441, "working_days_minutes_in_range"],
		[1, -1, "working_days_minutes_in_range"],
	])("refuses a working day %i of %i minutes", async (weekday, minutes, constraint) => {
		const { acme } = await seed();
		expect(
			await refusal(
				database
					.prepare(
						"update working_days set weekday = ?, minutes = ? where organisation_id = ? and weekday = 1",
					)
					.bind(weekday, minutes, acme.id)
					.run(),
			),
		).toContain(constraint);
	});
});
