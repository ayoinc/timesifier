import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "~/db";
import type { Role } from "~/organisations/roles";
import { MENU_COOKIE } from "~/shell/menu";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam } from "../organisations/harness";
import { open, type Person, person, submit, textOf } from "./harness";
import { entryDay } from "./periods-seed";

// The sweep's small feel details (TS-123, research/harvest-sweep-2.md), through
// the Worker as a browser asks: the period labels say where today is (S2-14),
// a copy that cannot be made is there, disabled, saying why (S2-13), and the
// navigation's column, hidden for wide work, arrives hidden (S2-10). Each for
// every kind of person who opens the Timesheet, and refused to a stranger.

const PAGE = "/app/acme";
const WEEK = `${PAGE}?view=week`;
const MENU = `${PAGE}/menu`;
const LONDON = "Europe/London";
/** Wednesday 11 November 2026, 10:00 in London (GMT). */
const T0 = Date.parse("2026-11-11T10:00:00Z");

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };
let site: string;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	site = uuidv7();
	await env.DB.prepare(
		"insert into projects (id, organisation_id, name, name_key, created_at, updated_at) values (?, ?, 'Site', 'site', 0, 0)",
	)
		.bind(site, acme.id)
		.run();
	await setZone(ada, LONDON);
	vi.spyOn(Date, "now").mockReturnValue(T0);
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

function setZone(who: Person, zone: string) {
	return env.DB.prepare("update users set time_zone = ? where id = ?")
		.bind(zone, who.user.id)
		.run();
}

/**
 * Signs a person in on the real clock, which a sign-in code is checked
 * against, then puts the page's clock back. Only the clock's spy is
 * restored: the mailbox's stays.
 */
async function signedInOnTheRealClock(email: string): Promise<Person> {
	const at = Date.now();
	vi.spyOn(Date, "now").mockRestore();
	try {
		return await person(mailbox, email);
	} finally {
		vi.spyOn(Date, "now").mockReturnValue(at);
	}
}

/** Two hours from `startedAt`, on the Site project. */
async function seedEntry(who: Person, startedAt: number) {
	await env.DB.prepare(
		"insert into time_entries (id, organisation_id, user_id, project_id, started_at, spent_on, ended_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 0, 0)",
	)
		.bind(
			uuidv7(),
			acme.id,
			who.user.id,
			site,
			startedAt,
			await entryDay(acme.id, who.user.id, startedAt),
			startedAt + 2 * 3_600_000,
		)
		.run();
}

type Kind = "owner" | Role | "manager" | "contractor";
const KINDS: readonly Kind[] = ["owner", "admin", "finance", "manager", "member", "contractor"];

/** A person of each kind in Acme, in London; the owner is Ada. */
async function personOf(kind: Kind): Promise<Person> {
	if (kind === "owner") return ada;
	const who = await signedInOnTheRealClock(`${kind}@example.com`);
	const role: Role = kind === "manager" || kind === "contractor" ? "member" : kind;
	await seedMembership(acme.id, who.user.id, role);
	if (kind === "manager") await seedTeam(acme.id, "Design", { managers: [who.user.id] });
	if (kind === "contractor") {
		await env.DB.prepare(
			"update memberships set is_contractor = 1 where organisation_id = ? and user_id = ?",
		)
			.bind(acme.id, who.user.id)
			.run();
	}
	await setZone(who, LONDON);
	return who;
}

/** A stranger: signed in, a member of another organisation only. */
async function stranger(): Promise<Person> {
	const who = await signedInOnTheRealClock("eve@example.com");
	await createOrganisation(who.cookie, "Elsewhere");
	return who;
}

const html = async (path: string, who: Person, cookie?: string) => {
	const response = await open(path, cookie ? { ...who, cookie: `${who.cookie}; ${cookie}` } : who);
	expect(response.status, path).toBe(200);
	return response.text();
};

/** The opening tag of the element whose id `aria-describedby` on the button named `name` points to, and its text. */
function describedBy(page: string, name: string): { button: string; reason: string } {
	const button = new RegExp(
		`<button[^>]*>(?:(?!</button>).)*${name}(?:(?!</button>).)*</button>`,
		"s",
	).exec(page)?.[0];
	if (!button) throw new Error(`no button "${name}"`);
	const id = /aria-describedby="([^"]+)"/.exec(button)?.[1];
	const reason = id ? new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(page)?.[1] : undefined;
	return { button, reason: reason ?? "" };
}

describe("S2-14 · the period labels say where today is", () => {
	it.each(KINDS)("for a %s, in their own zone", async (kind) => {
		const who = await personOf(kind);
		const thisWeek = textOf(await html(WEEK, who));
		expect(thisWeek).toContain("This week , 9–15 November 2026");
		const lastWeek = textOf(await html(`${PAGE}?view=week&start=2026-11-02`, who));
		expect(lastWeek).toContain("Last week , 2–8 November 2026");
		const later = textOf(await html(`${PAGE}?view=week&start=2026-11-23`, who));
		expect(later).toContain("23–29 November 2026");
		expect(later).not.toMatch(/(This|Last|Next) week ,/);

		const yesterday = await html(`${PAGE}?day=2026-11-10`, who);
		expect(yesterday).toContain('aria-label="Yesterday, Tue 10: choose a day"');
		expect(textOf(yesterday)).toContain("Yesterday, Tuesday 10 November");
		const before = await html(`${PAGE}?day=2026-11-09`, who);
		expect(before).toContain('aria-label="Monday 9 November: choose a day"');

		const month = textOf(await html(`${PAGE}?view=calendar&scale=month&date=2026-10-15`, who));
		expect(month).toContain("Last month , October 2026");
	});

	it("follows the person's zone: past midnight in Tokyo it is already next week", async () => {
		// Sunday 15 November, 23:30 in London; Monday 16 November, 08:30 in Tokyo.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-15T23:30:00Z"));
		expect(textOf(await html(`${PAGE}?view=week&start=2026-11-09`, ada))).toContain(
			"This week , 9–15 November 2026",
		);
		await setZone(ada, "Asia/Tokyo");
		expect(textOf(await html(`${PAGE}?view=week&start=2026-11-09`, ada))).toContain(
			"Last week , 9–15 November 2026",
		);
	});

	it("is a stranger's 404, as the Timesheet is", async () => {
		expect((await open(WEEK, await stranger())).status).toBe(404);
	});
});

describe("S2-13 · a copy that cannot be made says why", () => {
	it.each(KINDS)(
		"for a %s, the Week view's copy with hours is there, disabled and described by why",
		async (kind) => {
			const who = await personOf(kind);
			const { button, reason } = describedBy(await html(WEEK, who), "Copy last week with hours");
			expect(button).toContain('aria-disabled="true"');
			expect(button).not.toMatch(/\sdisabled(=""|\s|>)/);
			expect(reason).toBe("No week in the last three has time to copy.");

			// With time in the week before, it can be pressed and says nothing more.
			await seedEntry(who, Date.parse("2026-11-03T09:00:00Z"));
			const ready = describedBy(await html(WEEK, who), "Copy last week with hours");
			expect(ready.button).not.toContain("aria-disabled");
			expect(ready.button).not.toContain("aria-describedby");
		},
	);

	it.each(KINDS)(
		"for a %s, an empty day's copy is there, disabled and described by why",
		async (kind) => {
			const who = await personOf(kind);
			const { button, reason } = describedBy(
				await html(PAGE, who),
				"Copy last working day&#x27;s entries",
			);
			expect(button).toContain('aria-disabled="true"');
			expect(reason).toBe("No working day in the last three weeks has time to copy.");

			await seedEntry(who, Date.parse("2026-11-10T09:00:00Z"));
			const page = await html(PAGE, who);
			expect(page).not.toContain("Copy last working day");
			expect(describedBy(page, "Copy Tue 10&#x27;s entries").button).not.toContain("aria-disabled");
		},
	);

	it("says when the week, or the day, is yet to come", async () => {
		const next = await html(`${PAGE}?view=week&start=2026-11-16`, ada);
		expect(describedBy(next, "Copy last week with hours").reason).toBe(
			"Hours can be copied once the week has begun.",
		);
		const tomorrow = await html(`${PAGE}?day=2026-11-12`, ada);
		expect(describedBy(tomorrow, "Copy last working day&#x27;s entries").reason).toBe(
			"A day&#x27;s entries can be copied once the day has come.",
		);
	});

	it("is a stranger's 404", async () => {
		expect((await open(PAGE, await stranger())).status).toBe(404);
	});
});

describe("S2-10 · the menu, hidden for wide work, arrives hidden", () => {
	const nav = (page: string) => /<nav[^>]*aria-label="Main"[^>]*>/.exec(page)?.[0] ?? "";

	it.each(KINDS)("for a %s, the choice is read from the browser's cookie", async (kind) => {
		const who = await personOf(kind);
		const shown = await html(WEEK, who);
		expect(nav(shown)).toContain('data-menu="shown"');
		expect(shown).toMatch(/aria-keyshortcuts="Control\+\\ Meta\+\\"[^>]*>.*?Hide menu/s);

		const hidden = await html(WEEK, who, `${MENU_COOKIE}=hidden`);
		expect(nav(hidden)).toContain('data-menu="hidden"');
		expect(hidden).toMatch(/aria-keyshortcuts="Control\+\\ Meta\+\\"[^>]*>.*?>Menu</s);
		// The links leave the column, but stay in the bar under 600px.
		expect(hidden).toMatch(/<ul class="[^"]*medium:hidden/);
	});

	it.each(KINDS)("for a %s, the form without script stores it and goes back", async (kind) => {
		const who = await personOf(kind);
		const hide = await submit(MENU, { menu: "hidden", back: `${PAGE}/projects?q=site` }, who);
		expect(hide.status).toBe(303);
		expect(hide.headers.get("Location")).toBe(`${PAGE}/projects?q=site`);
		expect(hide.headers.get("Set-Cookie")).toBe(
			`${MENU_COOKIE}=hidden; Max-Age=31536000; Path=/; Secure; SameSite=Lax`,
		);
		const show = await submit(MENU, { menu: "shown", back: PAGE }, who);
		expect(show.headers.get("Set-Cookie")).toBe(
			`${MENU_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=Lax`,
		);
	});

	it("goes back only to a page of the same organisation", async () => {
		for (const back of ["/app/elsewhere", "/app/acmeco", "/sign-in", "//evil.example/app/acme"]) {
			const answer = await submit(MENU, { menu: "hidden", back }, ada);
			expect(answer.status, back).toBe(303);
			expect(answer.headers.get("Location"), back).toBe(PAGE);
		}
	});

	it("reads nothing but its one word: any other value is the column shown", async () => {
		expect(nav(await html(WEEK, ada, `${MENU_COOKIE}=HIDDEN`))).toContain('data-menu="shown"');
		expect(nav(await html(WEEK, ada, "menu=hidden"))).toContain('data-menu="shown"');
	});

	it("is a stranger's 404, and a person signed out goes to sign in", async () => {
		const eve = await stranger();
		expect((await submit(MENU, { menu: "hidden", back: PAGE }, eve)).status).toBe(404);
		const signedOut = await submit(MENU, { menu: "hidden", back: PAGE });
		expect(signedOut.status).toBe(302);
		expect(signedOut.headers.get("Location")).toMatch(/^\/sign-in/);
	});
});
