import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganisationScope, organisationScope, organisations, users } from "~/db";
import { instantAt, startOfDay } from "~/time/calendar";
import { placeOnDay } from "~/time/grid";
import { setCellHours } from "~/time/manual.server";
import { freshDatabase } from "../db/database";

// Hours typed into a cell of the week's grid never carry an entry past the end
// of its day in the person's zone, or past now (TS-091, W08). The entry keeps
// its start when it fits, starts earlier when it does not, and a day without
// room for the hours is refused, saying what it has left.

const LONDON = "Europe/London";
const WEDNESDAY = "2026-11-11";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (day: string, hours: number, minutes = 0) =>
	instantAt(day, hours * 60 + minutes, LONDON);

describe("an entry placed on its day", () => {
	it("keeps its start when it ends before the day's end and now", () => {
		const start = at(WEDNESDAY, 9);
		expect(placeOnDay(WEDNESDAY, LONDON, start, 120, at(WEDNESDAY, 12))).toEqual({
			fits: true,
			start,
		});
	});

	it("21:33 and five hours, typed at 22:00 on the day, runs 17:00 to 22:00", () => {
		expect(placeOnDay(WEDNESDAY, LONDON, at(WEDNESDAY, 21, 33), 5 * 60, at(WEDNESDAY, 22))).toEqual(
			{ fits: true, start: at(WEDNESDAY, 17) },
		);
	});

	it("ends at midnight on a day that is over", () => {
		const placed = placeOnDay(
			WEDNESDAY,
			LONDON,
			at(WEDNESDAY, 21, 33),
			5 * 60,
			Date.parse("2026-11-20T00:00:00Z"),
		);
		expect(placed).toEqual({ fits: true, start: startOfDay("2026-11-12", LONDON) - 5 * HOUR });
	});

	it("is refused when the day so far is shorter than the hours, saying what is left", () => {
		expect(placeOnDay(WEDNESDAY, LONDON, at(WEDNESDAY, 9), 3 * 60, at(WEDNESDAY, 2, 27))).toEqual({
			fits: false,
			minutesLeft: 147,
		});
		// A day of 25 hours, when the clocks go back, holds 25.
		expect(
			placeOnDay(
				"2026-10-25",
				LONDON,
				at("2026-10-25", 9),
				25 * 60,
				Date.parse("2026-11-20T00:00:00Z"),
			).fits,
		).toBe(true);
		// A day that has not begun has nothing left.
		expect(placeOnDay("2026-11-12", LONDON, at("2026-11-12", 9), 60, at(WEDNESDAY, 22))).toEqual({
			fits: false,
			minutesLeft: 0,
		});
	});

	it("keeps a start the person chose, and refuses hours that do not fit after it", () => {
		const over = Date.parse("2026-11-20T00:00:00Z");
		const slot = at(WEDNESDAY, 14, 30);
		expect(placeOnDay(WEDNESDAY, LONDON, slot, 90, over, { keepStart: true })).toEqual({
			fits: true,
			start: slot,
		});
		// A slot at 23:00 with two hours would cross midnight: an hour is left from it.
		expect(
			placeOnDay(WEDNESDAY, LONDON, at(WEDNESDAY, 23), 120, over, { keepStart: true }),
		).toEqual({ fits: false, minutesLeft: 60 });
		// A slot later today that would end in the future: up to now is left.
		expect(
			placeOnDay(WEDNESDAY, LONDON, at(WEDNESDAY, 20), 180, at(WEDNESDAY, 22), {
				keepStart: true,
			}),
		).toEqual({ fits: false, minutesLeft: 120 });
	});
});

describe("hours typed into a cell", () => {
	let scope: OrganisationScope;
	let userId: string;
	let projectId: string;

	beforeEach(async () => {
		await freshDatabase();
		const db = drizzle(env.DB);
		const [organisation] = await db
			.insert(organisations)
			.values({ name: "Acme", slug: "acme" })
			.returning();
		const [person] = await db
			.insert(users)
			.values({ name: "Ada", email: "ada@example.com" })
			.returning();
		if (!organisation || !person) throw new Error("seed failed");
		scope = organisationScope(env.DB, organisation.id);
		await scope.memberships.insert({ userId: person.id, role: "owner" });
		const [project] = await scope.projects.insert({ name: "Site", nameKey: "site" });
		if (!project) throw new Error("seed failed");
		userId = person.id;
		projectId = project.id;
	});

	const cell = (minutes: number, now: number) =>
		setCellHours(scope, userId, { projectId, day: WEDNESDAY, minutes, zone: LONDON, now });
	const spans = async () =>
		(await scope.timeEntries.select()).map((e) => [e.startedAt.getTime(), e.endedAt?.getTime()]);

	it("moves an evening entry's start back so five hours end at now, on its day", async () => {
		await scope.timeEntries.insert({
			userId,
			projectId,
			description: null,
			startedAt: new Date(at(WEDNESDAY, 21, 33)),
			endedAt: new Date(at(WEDNESDAY, 21, 50)),
		});
		expect(await cell(5 * 60, at(WEDNESDAY, 22))).toEqual({ ok: true });
		expect(await spans()).toEqual([[at(WEDNESDAY, 17), at(WEDNESDAY, 22)]]);
	});

	it("keeps an entry's start when its hours fit", async () => {
		await scope.timeEntries.insert({
			userId,
			projectId,
			description: null,
			startedAt: new Date(at(WEDNESDAY, 9)),
			endedAt: new Date(at(WEDNESDAY, 10)),
		});
		expect(await cell(3 * 60, at(WEDNESDAY, 22))).toEqual({ ok: true });
		expect(await spans()).toEqual([[at(WEDNESDAY, 9), at(WEDNESDAY, 12)]]);
	});

	it("places a new entry so it ends by now", async () => {
		// The day's first entry starts at 09:00; at 10:00, two hours end at 10:00.
		expect(await cell(120, at(WEDNESDAY, 10))).toEqual({ ok: true });
		expect(await spans()).toEqual([[at(WEDNESDAY, 8), at(WEDNESDAY, 10)]]);
	});

	it("refuses hours the day does not have, with what it has left, and stores nothing", async () => {
		expect(await cell(5 * 60, at(WEDNESDAY, 2, 27))).toEqual({
			ok: false,
			reason: "day-full",
			message: "This day has only 2:27 left",
		});
		expect(await spans()).toEqual([]);
	});
});
