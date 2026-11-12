import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyedHash } from "~/auth/keyed-hash.server";
import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { open, type Person, person } from "../pages/harness";
import { seedLeave } from "../pages/leave-seed";
import { seedEntry, seedProject } from "../pages/periods-seed";

// Calendar feeds (TS-089): a person's ICS feed of their approved time off and,
// if they choose, their entries; a manager's of a team's approved leave only.
// The address is secret, kept as a keyed hash, and revocable; entries fall on
// the local day they start in the person's zone; descriptions only on the
// person's own feed.

const FEEDS = "/app/acme/account/calendar";
const ADDRESS = /https:\/\/[^"\s\\]+\/calendar\/(cal_[A-Za-z0-9_-]{43})\.ics/;

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function memberOfAcme(role: Role, email: string, name: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	await env.DB.prepare("update users set name = ? where id = ?").bind(name, who.user.id).run();
	return who;
}

/** Makes a feed on the page and returns its address and token. */
async function makeFeed(who: Person, fields: Record<string, string>) {
	const response = await exports.default.fetch(
		new Request(`${ORIGIN}${FEEDS}.data`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: ORIGIN,
				Cookie: who.cookie,
				"CF-Connecting-IP": who.client,
			},
			body: new URLSearchParams({ intent: "feed-create", ...fields }),
		}),
	);
	const found = (await response.text()).match(ADDRESS);
	return { status: response.status, address: found?.[0] ?? "", token: found?.[1] ?? "" };
}

const read = (address: string) => exports.default.fetch(new Request(address));

describe("a person's own feed", () => {
	it("lists approved leave and, when chosen, entries on their local day with descriptions", async () => {
		const max = await memberOfAcme("member", "max@example.com", "Max Member");
		await env.DB.prepare("update users set time_zone = 'Asia/Tokyo' where id = ?")
			.bind(max.user.id)
			.run();
		await seedLeave(acme.id, max.user.id, "annual", "2026-12-21", "2026-12-24");
		await seedLeave(acme.id, max.user.id, "study", "2026-12-28", "2026-12-28", {
			status: "pending",
		});
		const apollo = await seedProject(acme.id, "Apollo");
		// 20:00 UTC two days ago is 05:00 the next day in Tokyo, which keeps no summer time.
		await seedEntry(
			acme.id,
			max.user.id,
			apollo,
			Date.now() - 86_400_000,
			Date.now() - 86_400_000 + 3_600_000,
			"Wrote the report",
		);
		const utcDay = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
		const at = Date.parse(`${utcDay}T20:00:00Z`);
		const tokyoDay = new Date(at + 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
		const tokyo = await seedEntry(acme.id, max.user.id, apollo, at, at + 5_400_000, "Kick-off");

		const made = await makeFeed(max, { follow: "me", entries: "on" });
		expect(made.status).toBe(200);
		expect(made.address).toBe(`${ORIGIN}/calendar/${made.token}.ics`);
		expect(await value("select token_hash from calendar_feeds")).toBe(
			await keyedHash(env.BETTER_AUTH_SECRET, "calendar-feed", made.token),
		);
		expect(
			await value("select count(*) from calendar_feeds where token_hash like ?", `%${made.token}%`),
		).toBe(0);

		const response = await read(made.address);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/calendar");
		const ics = await response.text();
		expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
		expect(ics).toContain("SUMMARY:Annual leave");
		expect(ics).toContain("DTSTART;VALUE=DATE:20261221");
		expect(ics).toContain("DTEND;VALUE=DATE:20261225");
		expect(ics).not.toContain("Study leave");
		expect(ics).toContain(`UID:entry-${tokyo}@timesifier`);
		expect(ics).toContain(`DTSTART;TZID=Asia/Tokyo:${tokyoDay}T050000`);
		expect(ics).toContain(`DTEND;TZID=Asia/Tokyo:${tokyoDay}T063000`);
		expect(ics).toContain("DESCRIPTION:Kick-off");
	});

	it("leaves entries out unless they were chosen", async () => {
		const apollo = await seedProject(acme.id, "Apollo");
		await seedEntry(
			acme.id,
			ada.user.id,
			apollo,
			Date.now() - 7_200_000,
			Date.now() - 3_600_000,
			"Mine",
		);
		const made = await makeFeed(ada, { follow: "me" });
		const ics = await (await read(made.address)).text();
		expect(ics).not.toContain("Apollo");
		expect(ics).not.toContain("DESCRIPTION");
	});

	it("answers 404 once revoked, as for an address never made", async () => {
		const made = await makeFeed(ada, { follow: "me" });
		expect((await read(made.address)).status).toBe(200);
		const id = await value<string>("select id from calendar_feeds");
		const revoked = await exports.default.fetch(
			new Request(`${ORIGIN}${FEEDS}.data`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Origin: ORIGIN,
					Cookie: ada.cookie,
					"CF-Connecting-IP": ada.client,
				},
				body: new URLSearchParams({ intent: "feed-revoke", feedId: id ?? "" }),
			}),
		);
		expect(revoked.status).toBe(200);
		expect((await read(made.address)).status).toBe(404);
		expect((await read(`${ORIGIN}/calendar/cal_${"A".repeat(43)}.ics`)).status).toBe(404);
		expect((await read(`${ORIGIN}/calendar/anything.ics`)).status).toBe(404);
	});

	it("goes when its person leaves the organisation", async () => {
		const max = await memberOfAcme("member", "max@example.com", "Max Member");
		const made = await makeFeed(max, { follow: "me" });
		await env.DB.prepare("delete from memberships where user_id = ?").bind(max.user.id).run();
		expect((await read(made.address)).status).toBe(404);
	});
});

describe("a manager's team feed", () => {
	it("lists the team's approved leave by name, with no entries and no words", async () => {
		const mia = await memberOfAcme("member", "mia@example.com", "Mia Manager");
		const max = await memberOfAcme("member", "max@example.com", "Max Member");
		const team = await seedTeam(acme.id, "Design", {
			members: [max.user.id],
			managers: [mia.user.id],
		});
		await seedLeave(acme.id, max.user.id, "sick", "2026-11-16", "2026-11-17");
		const apollo = await seedProject(acme.id, "Apollo");
		await seedEntry(
			acme.id,
			max.user.id,
			apollo,
			Date.now() - 7_200_000,
			Date.now() - 3_600_000,
			"Secret",
		);

		const made = await makeFeed(mia, { follow: team });
		expect(made.status).toBe(200);
		const ics = await (await read(made.address)).text();
		expect(ics).toContain("SUMMARY:Max Member: Sick leave");
		expect(ics).toContain("X-WR-CALNAME:Design leave · Acme");
		expect(ics).not.toContain("Apollo");
		expect(ics).not.toContain("DESCRIPTION");

		// No longer its manager: the address shows nothing.
		await env.DB.prepare("update team_members set is_manager = 0 where user_id = ?")
			.bind(mia.user.id)
			.run();
		expect((await read(made.address)).status).toBe(404);
	});

	it("is refused for a team the person does not manage", async () => {
		const max = await memberOfAcme("member", "max@example.com", "Max Member");
		const team = await seedTeam(acme.id, "Design", {
			members: [max.user.id],
			managers: [ada.user.id],
		});
		expect((await makeFeed(max, { follow: team })).status).toBe(400);
		expect(await value("select count(*) from calendar_feeds")).toBe(0);
	});
});

describe("the page, by role", () => {
	it("every member opens their own feeds; a manager is offered their teams", async () => {
		const roles: [Role, string][] = [
			["admin", "ben@example.com"],
			["finance", "fin@example.com"],
			["member", "max@example.com"],
		];
		for (const [role, email] of roles) {
			const who = await memberOfAcme(role, email, email);
			const page = await open(FEEDS, who);
			expect(page.status, role).toBe(200);
			expect(await page.text()).toContain("Calendar feeds");
		}
		const mia = await memberOfAcme("member", "mia@example.com", "Mia Manager");
		await seedTeam(acme.id, "Design", { members: [], managers: [mia.user.id] });
		expect(await (await open(FEEDS, mia)).text()).toContain("a team you manage");
		expect((await open(FEEDS, ada)).status).toBe(200);
	});
});
