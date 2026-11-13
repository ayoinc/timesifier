import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { dayOf } from "~/time/calendar";

// Migration 0021_entry_day_backfill (TS-111, decision 39): every entry tracked
// before days were stored is given the day it shows today, the one its start
// falls on in its person's zone now, else its organisation's. The schema is
// built up to 0020, entries are written with no day, then 0021 runs alone and
// each day it wrote is compared with `dayOf`, which every reader used before.

const MIGRATIONS = (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const BACKFILL = "0021_entry_day_backfill.sql";

/** Every zone the application accepts (`isTimeZone`): a person's may be any of them. */
const ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
const YEAR = 365.25 * 24 * 3_600_000;
const FROM = Date.parse("2000-01-01T00:00:00Z");

/** A small seeded generator, so a failing case can be run again. */
function generator(seed: number) {
	let state = seed >>> 0;
	return (below: number) => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state % below;
	};
}

beforeEach(async () => {
	await reset();
	const index = MIGRATIONS.findIndex((m) => m.name === BACKFILL);
	expect(index).toBeGreaterThan(0);
	await applyD1Migrations(env.DB, MIGRATIONS.slice(0, index));
});

async function backfill() {
	const index = MIGRATIONS.findIndex((m) => m.name === BACKFILL);
	await applyD1Migrations(env.DB, MIGRATIONS.slice(0, index + 1));
}

/** An organisation in `zone` with one project; its id and the project's. */
async function organisation(id: string, zone: string) {
	await env.DB.batch([
		env.DB.prepare(
			"insert into organisations (id, name, slug, time_zone, created_at, updated_at) values (?, ?, ?, ?, 0, 0)",
		).bind(id, id, id, zone),
		env.DB.prepare(
			"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Site', 'site', 0, 0)",
		).bind(`${id}-site`, id),
	]);
}

function user(id: string, zone: string | null) {
	return env.DB.prepare(
		"insert into users (id, name, email, email_verified, time_zone, created_at, updated_at) values (?, ?, ?, 1, ?, 0, 0)",
	).bind(id, id, `${id}@example.com`, zone);
}

function entry(id: string, organisationId: string, userId: string, startedAt: number) {
	return env.DB.prepare(
		"insert into time_entries (id, organisation_id, user_id, project_id, started_at, ended_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 0, 0)",
	).bind(id, organisationId, userId, `${organisationId}-site`, startedAt, startedAt + 60_000);
}

async function storedDays(): Promise<Map<string, string>> {
	const { results } = await env.DB.prepare("select id, spent_on from time_entries").all<{
		id: string;
		spent_on: string;
	}>();
	return new Map(results.map((r) => [r.id, r.spent_on]));
}

describe("the backfill of entries' days", () => {
	it("gives each entry the day it shows today, in its person's zone or else its organisation's", async () => {
		await organisation("acme", "Europe/London");
		await organisation("kiwi", "Pacific/Auckland");
		const people = ZONES.map((zone, i) => ({ id: `u${i}`, zone }));
		// Two people with no zone of their own, read in their organisation's.
		const unzoned = [
			{ id: "plain-acme", zone: null, organisation: "acme" },
			{ id: "plain-kiwi", zone: null, organisation: "kiwi" },
		];
		await env.DB.batch([...people, ...unzoned].map((p) => user(p.id, p.zone)));

		const next = generator(39);
		const expected = new Map<string, string>();
		const statements: D1PreparedStatement[] = [];
		const add = (userId: string, organisationId: string, zone: string, startedAt: number) => {
			const id = `e${statements.length}`;
			statements.push(entry(id, organisationId, userId, startedAt));
			expected.set(id, dayOf(startedAt, zone));
		};
		for (const p of people) {
			for (let i = 0; i < 3; i++) {
				// Anywhere from 2000 to 2040, to the minute.
				add(p.id, "acme", p.zone, FROM + next(Math.floor((40 * YEAR) / 60_000)) * 60_000);
			}
			// Each side of every midnight and clock change of a year: on the half hours of 2026.
			for (let i = 0; i < 3; i++) {
				const at = Date.parse("2026-01-01T00:00:00Z") + next(365 * 48) * 1_800_000;
				add(p.id, "kiwi", p.zone, at);
			}
		}
		for (const p of unzoned) {
			const zone = p.organisation === "acme" ? "Europe/London" : "Pacific/Auckland";
			for (let i = 0; i < 25; i++) {
				add(p.id, p.organisation, zone, FROM + next(Math.floor((40 * YEAR) / 60_000)) * 60_000);
			}
		}
		await env.DB.batch(statements);
		expect([...(await storedDays()).values()].every((day) => day === "")).toBe(true);

		await backfill();

		const stored = await storedDays();
		for (const [id, day] of expected) expect(stored.get(id), id).toBe(day);
	});

	it("reads a zone it does not know as UTC, and then refuses any row without a real date", async () => {
		await organisation("acme", "Europe/London");
		await env.DB.batch([user("lost", "Nowhere/Atlantis")]);
		const at = Date.parse("2026-07-01T23:30:00Z");
		await env.DB.batch([entry("e1", "acme", "lost", at)]);

		await backfill();

		expect(await storedDays()).toEqual(new Map([["e1", "2026-07-01"]]));
		await expect(
			env.DB.prepare("update time_entries set spent_on = '' where id = 'e1'").run(),
		).rejects.toThrow(/an entry has the date of its day/);
		await expect(entry("e2", "acme", "lost", at).run()).rejects.toThrow(
			/an entry has the date of its day/,
		);
	});
});
