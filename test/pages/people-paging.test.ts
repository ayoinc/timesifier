import { beforeEach, describe, expect, it } from "vitest";

import { uuidv7 } from "~/db";
import { defaultRatesPath } from "~/projects/projects";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { type Crowd, insertAll, seedCrowd, WEEK } from "../lists/crowd";
import { createOrganisation } from "../organisations/harness";
import { open, openData, type Person, pageBody, person, textOf } from "./harness";

// Team and Default rates list people 50 at a time, in the order of the names
// they are shown by, with a filter by name or address; the page and the
// filter are in the address (TS-113). Before, an organisation of 300 people
// had all 300 on one page: Team sent 511 KB of HTML, Default rates 397 KB
// (`research/corporate/scale-test.md`, D8).

/** How many people Acme has here: the crowd's 150 and 150 more. */
const PEOPLE = 300;

let crowd: Crowd;
/** Everybody in Acme, in the order lists show them: by the name shown, then by id. */
let ordered: { id: string; name: string }[];

beforeEach(async () => {
	await freshDatabase();
	crowd = await seedCrowd(captureEmail());
	const more = Array.from({ length: PEOPLE - 150 }, () => uuidv7());
	const now = Date.now();
	await insertAll(
		"insert into users (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)",
		more.map((id, i) => [id, `Person ${148 + i}`, `person${148 + i}@example.com`, now, now]),
	);
	await insertAll(
		"insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values (?, ?, ?, 'member', ?, ?)",
		more.map((id) => [uuidv7(), crowd.acme.id, id, now, now]),
	);
	// Nobody among the three who sign in has given a name: each is shown by
	// their address up to the "@", and Default rates titles them by all of it.
	ordered = [
		{ id: crowd.owner.user.id, name: "ada" },
		{ id: crowd.admin.user.id, name: "grace" },
		{ id: crowd.manager.user.id, name: "hedy" },
		...[...crowd.others, ...more].map((id, i) => ({
			id,
			name: `Person ${String(i + 1).padStart(3, "0")}`,
		})),
	].sort((a, b) => a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : 1));
}, 60_000);

const team = (query = "") => `/app/acme/team?week=${WEEK}${query}`;
const rates = (query = "") => `${defaultRatesPath("acme")}${query === "" ? "" : `?${query}`}`;

async function html(path: string, who: Person = crowd.owner): Promise<string> {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return pageBody(response);
}

/** The ids of the people Team lists, in the order it lists them. */
async function teamIds(path: string, who: Person = crowd.owner): Promise<string[]> {
	const page = await html(path, who);
	return [...page.matchAll(/href="[^"?]*\?week=[0-9-]+&amp;person=([0-9a-f-]+)"/g)].map(
		(m) => m[1] ?? "",
	);
}

/** The names of the people Default rates lists, in its order: the people's list alone, not the tasks'. */
async function ratesNames(path: string): Promise<string[]> {
	const page = await html(path);
	const list = page.match(/aria-label="Each person&#x27;s default rate"[\s\S]*?<\/ol>/)?.[0] ?? "";
	return [...list.matchAll(/aria-label="Set rate for ([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** How Default rates titles a person: by their whole address when they have given no name. */
const titled = (name: string) => (name.startsWith("Person") ? name : `${name}@example.com`);

/**
 * How many of the people who never sign in the data of the page at `path`
 * holds anything of: their id or their name. (The three who sign in are left
 * out, as the shell's own data may name the one asking.)
 */
async function othersInData(path: string): Promise<number> {
	const response = await openData(path, crowd.owner);
	expect(response.status, path).toBe(200);
	const data = await response.text();
	return ordered
		.filter((p) => p.name.startsWith("Person"))
		.filter((p) => data.includes(p.id) || data.includes(p.name)).length;
}

describe(`Team in an organisation of ${PEOPLE} people`, () => {
	it("lists the first 50 people in the order of their names, and the next page the 50 after", async () => {
		expect(await teamIds(team())).toEqual(ordered.slice(0, 50).map((p) => p.id));
		expect(await teamIds(team("&page=2"))).toEqual(ordered.slice(50, 100).map((p) => p.id));
		expect(await teamIds(team("&page=6"))).toEqual(ordered.slice(250).map((p) => p.id));
		const first = textOf(await html(team()));
		expect(first).toContain("1–50 of 300");
		expect(first).toContain("Next 50");
		expect(first).not.toContain("Previous 50");
		const last = textOf(await html(team("&page=6")));
		expect(last).toContain("251–300 of 300");
		expect(last).toContain("Previous 50");
		expect(last).not.toContain("Next 50");
	});

	it("finds a person by part of their name or by their address, in any case", async () => {
		const byName = ordered.filter((p) => p.name.startsWith("Person 12"));
		expect(await teamIds(team("&q=person%2012"))).toEqual(byName.map((p) => p.id));
		expect(await teamIds(team("&q=GRACE%40example"))).toEqual([crowd.admin.user.id]);
		expect(await teamIds(team("&q=person250%40"))).toEqual(
			ordered.filter((p) => p.name === "Person 250").map((p) => p.id),
		);
	});

	it("keeps the filter on the next page, and says when it finds nobody", async () => {
		const page = await html(team("&q=Person"));
		expect(page).toContain(`?week=${WEEK}&amp;q=Person&amp;page=2"`);
		const persons = ordered.filter((p) => p.name.startsWith("Person"));
		expect(await teamIds(team("&q=Person&page=2"))).toEqual(
			persons.slice(50, 100).map((p) => p.id),
		);
		expect(textOf(await html(team("&q=nobody-here")))).toContain(
			"Nobody's name or address holds “nobody-here”.",
		);
	});

	it("sends the browser the figures of the page's 50 people alone", async () => {
		expect(await othersInData(team("&page=2"))).toBe(50);
		expect(await othersInData(team())).toBe(47);
	});

	it("shows no pager while the filter leaves one page", async () => {
		const page = await html(team("&q=Person%2012"));
		expect(page).not.toContain('aria-label="Pages of people"');
	});
});

describe(`Default rates in an organisation of ${PEOPLE} people`, () => {
	it("lists the first 50 people in the order of their names, and the next page the 50 after", async () => {
		const names = ordered.map((p) => titled(p.name));
		expect(await ratesNames(rates())).toEqual(names.slice(0, 50));
		expect(await ratesNames(rates("page=2"))).toEqual(names.slice(50, 100));
		expect(textOf(await html(rates()))).toContain("1–50 of 300");
	});

	it("finds a person by part of their name or by their address, in any case", async () => {
		expect(await ratesNames(rates("q=person%2012"))).toEqual(
			ordered.filter((p) => p.name.startsWith("Person 12")).map((p) => p.name),
		);
		expect(await ratesNames(rates("q=Hedy%40"))).toEqual(["hedy@example.com"]);
	});

	it("keeps the filter on the next page, and says when it finds nobody", async () => {
		expect(await html(rates("q=person"))).toContain('?q=person&amp;page=2"');
		const persons = ordered.filter((p) => p.name.startsWith("Person")).map((p) => p.name);
		expect(await ratesNames(rates("q=person&page=2"))).toEqual(persons.slice(50, 100));
		expect(textOf(await html(rates("q=nobody-here")))).toContain(
			"Nobody's name or address holds “nobody-here”.",
		);
	});

	it("sends the browser the rates of the page's 50 people alone", async () => {
		expect(await othersInData(rates("page=2"))).toBe(50);
		expect(await othersInData(rates())).toBe(47);
	});
});

describe("a small organisation", () => {
	it("lists everyone on one page, with no pager and no filter on Default rates", async () => {
		await freshDatabase();
		const ada = await person(captureEmail(), "ada@example.com");
		await createOrganisation(ada.cookie, "Acme");
		const onTeam = await html(team(), ada);
		expect(onTeam).not.toContain('aria-label="Pages of people"');
		const onRates = await html(rates(), ada);
		expect(onRates).not.toContain('aria-label="Pages of people"');
		expect(onRates).not.toContain('aria-label="Filter people"');
		expect(onRates).toContain('aria-label="Set rate for ada@example.com"');
	});
});
