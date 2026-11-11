import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	canSee,
	type DestinationId,
	destinationIndex,
	destinationPath,
	destinations,
	membersPath,
	organisationPath,
	type Viewer,
} from "~/shell/destinations";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, seedMembership, seedTeam, value } from "../organisations/harness";
import { allRoutes, isMoved, STAND_IN_ORGANISATION } from "../routes";
import { open, openData, type Person, pageBody, person, submit, textOf } from "./harness";

// The navigation by heading and role (docs/navigation.md, "The navigation, top
// to bottom"; card TS-053). Each role is shown the destinations its row names,
// under the headings that have a link shown, and gets 404 at the address of a
// destination it is not shown and at every page below it: the same 404 that a
// person who is not a member gets for another organisation's address
// (test/pages/isolation.test.ts). Every request goes through the Worker.

const ACME = STAND_IN_ORGANISATION;
const NOBODYS = "globex";

/** The pages of one organisation that belong to a destination, read from the route configuration. */
const destinationPages = allRoutes
	.filter((route) => !isMoved(route))
	.map((route) => ({ ...route, index: destinationIndex(ACME, route.address) }))
	.filter(({ index }) => index >= 0)
	.map(({ id, address, index }) => ({
		id,
		address,
		destination: destinations[index]?.id as DestinationId,
	}));

/** Who is shown what, by docs/navigation.md: the expected link labels of each kind of person, in order. */
const SHOWN: Record<string, string[]> = {
	owner: ["Timesheet", "Projects", "Clients", "Team", "Approvals", "Reports", "Workspace settings"],
	admin: ["Timesheet", "Projects", "Clients", "Team", "Approvals", "Reports", "Workspace settings"],
	manager: ["Timesheet", "Projects", "Team", "Approvals", "Reports"],
	member: ["Timesheet", "Projects", "Reports"],
};

const VIEWERS: Record<string, Viewer> = {
	owner: { role: "owner", managesTeams: false, clientsEnabled: true },
	admin: { role: "admin", managesTeams: false, clientsEnabled: true },
	manager: { role: "member", managesTeams: true, clientsEnabled: true },
	member: { role: "member", managesTeams: false, clientsEnabled: true },
};

let mailbox: Mailbox;
let acme: { id: string };
let people: Record<keyof typeof SHOWN, Person>;
/** A member of an organisation of her own, and of no other. */
let stranger: Person;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	const owner = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(owner.cookie, "Acme");
	const admin = await person(mailbox, "grace@example.com");
	const manager = await person(mailbox, "hedy@example.com");
	const member = await person(mailbox, "linus@example.com");
	await seedMembership(acme.id, admin.user.id, "admin");
	await seedMembership(acme.id, manager.user.id, "member");
	await seedMembership(acme.id, member.user.id, "member");
	await seedTeam(acme.id, "Design", { members: [member.user.id], managers: [manager.user.id] });
	people = { owner, admin, manager, member };
	stranger = await person(mailbox, "mallory@example.com");
	await createOrganisation(stranger.cookie, "Initech");
	// The first request to the Worker loads the whole application, which takes
	// longer than a hook is given by default.
}, 60_000);

afterEach(() => {
	vi.restoreAllMocks();
});

/** The main navigation of a page, as HTML. */
function navigationOf(html: string): string {
	const nav = /<nav aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1];
	if (nav === undefined) throw new Error("The page has no main navigation.");
	return nav;
}

/** The labels of the destinations' links in a navigation, in order: what follows the timer's control. */
function linksOf(nav: string): string[] {
	const list = nav.slice(nav.indexOf("<ul"));
	return [...list.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map(([, inner]) => textOf(inner ?? ""));
}

/** A 404's body, with the organisation's address taken out. */
async function notFoundBody(response: Response, slug: string): Promise<string> {
	return (await pageBody(response)).replaceAll(organisationPath(slug), organisationPath("~"));
}

describe("the list of destinations", () => {
	it("is the navigation of docs/navigation.md, in its order", () => {
		expect(destinations.map(({ label, heading }) => [heading, label])).toEqual([
			["Track", "Timesheet"],
			["Organize", "Projects"],
			["Organize", "Clients"],
			["Organize", "Team"],
			["Review", "Approvals"],
			["Review", "Reports"],
			[null, "Workspace settings"],
		]);
	});

	it.each(Object.keys(VIEWERS))("shows a %s what that row names", (kind) => {
		const viewer = VIEWERS[kind] as Viewer;
		const shown = destinations.filter(({ id }) => canSee(viewer, id)).map(({ label }) => label);
		expect(shown).toEqual(SHOWN[kind]);
	});

	it("hides Clients from everyone when the organisation turns Clients off, and nothing else", () => {
		for (const viewer of Object.values(VIEWERS)) {
			const off = { ...viewer, clientsEnabled: false };
			for (const { id } of destinations) {
				expect(canSee(off, id), id).toBe(id === "clients" ? false : canSee(viewer, id));
			}
		}
	});

	it("covers every destination and the pages of Team in the pages walked below", () => {
		const covered = new Set(destinationPages.map(({ destination }) => destination));
		expect([...covered].sort()).toEqual(destinations.map(({ id }) => id).sort());
		expect(destinationPages.map(({ address }) => address)).toContain(membersPath(ACME));
	});
});

describe.each(Object.keys(SHOWN))("to a %s", (kind) => {
	it("the navigation shows their links, each heading only when a link under it shows", async () => {
		const who = people[kind] as Person;
		const nav = navigationOf(await pageBody(await open(organisationPath(ACME), who)));
		const labels = SHOWN[kind] as string[];

		expect(linksOf(nav)).toEqual(labels);
		for (const heading of ["Track", "Organize", "Review"]) {
			const under = destinations.filter(
				(each) => each.heading === heading && labels.includes(each.label),
			);
			expect(nav.includes(`>${heading}</span>`), heading).toBe(under.length > 0);
		}
	});

	it("every page of a destination: shown, or the same 404 as another organisation's", async () => {
		const who = people[kind] as Person;
		for (const { address, destination } of destinationPages) {
			const page = await open(address, who);
			const data = await openData(address, who);

			if (canSee(VIEWERS[kind] as Viewer, destination)) {
				expect(page.status, address).toBe(200);
				expect(data.status, address).toBe(200);
				continue;
			}
			expect(page.status, address).toBe(404);
			expect(data.status, address).toBe(404);
			// The person asking for an organisation nobody has, and a stranger
			// asking for this one, get this very answer.
			const nobodys = address.replace(organisationPath(ACME), organisationPath(NOBODYS));
			const body = await notFoundBody(page, ACME);
			expect(body, address).toBe(await notFoundBody(await open(nobodys, who), NOBODYS));
			expect(body, address).toBe(await notFoundBody(await open(address, stranger), ACME));
		}
	});
});

describe("a destination a person is not shown", () => {
	it("refuses its form with 404 before its action runs", async () => {
		const response = await submit(
			destinationPath(ACME, "settings"),
			{ intent: "rename", name: "Taken over" },
			people.member,
			{ byScript: true },
		);

		expect(response.status).toBe(404);
		expect(await value("select name from organisations where id = ?", acme.id)).toBe("Acme");
	});

	it("is 404 from the request after a manager stops managing", async () => {
		const team = destinationPath(ACME, "team");
		expect((await open(team, people.manager)).status).toBe(200);

		await env.DB.prepare("update team_members set is_manager = 0 where user_id = ?")
			.bind(people.manager.user.id)
			.run();

		expect((await open(team, people.manager)).status).toBe(404);
	});

	it("Clients is hidden and 404 for everyone while the organisation has it turned off", async () => {
		await env.DB.prepare("update organisations set clients_enabled = 0 where id = ?")
			.bind(acme.id)
			.run();

		const clients = destinationPath(ACME, "clients");
		const html = await pageBody(await open(organisationPath(ACME), people.owner));
		expect(linksOf(navigationOf(html))).not.toContain("Clients");
		expect((await open(clients, people.owner)).status).toBe(404);
		expect((await open(clients, people.admin)).status).toBe(404);
	});
});

describe("the navigation's timer control (TS-051)", () => {
	it.each(Object.keys(SHOWN))(
		"comes before the first heading for a %s, and with nothing running is Start timer, to the Day view's timer",
		async (kind) => {
			const nav = navigationOf(
				await pageBody(await open(organisationPath(ACME), people[kind] as Person)),
			);
			const timer = nav.slice(0, nav.indexOf("<ul"));

			expect(nav.indexOf("<ul")).toBeGreaterThan(0);
			expect(timer).toMatch(/<a[^>]*href="\/app\/acme#timer"[^>]*>[\s\S]*Start timer[\s\S]*<\/a>/);
			expect(textOf(timer)).toBe("Start timer");
		},
	);
});

describe("My account", () => {
	it.each(Object.keys(SHOWN))("is opened by a %s from the band", async (kind) => {
		const who = people[kind] as Person;
		const html = await pageBody(await open(organisationPath(ACME), who));

		expect(html).toMatch(/<a[^>]*href="\/app\/acme\/account"[^>]*>My account<\/a>/);
		expect((await open(`${organisationPath(ACME)}/account`, who)).status).toBe(200);
	});
});

describe("the members' old address", () => {
	it("sends an owner to the members under Team, with its query", async () => {
		const response = await open(
			`${organisationPath(ACME)}/settings/members?from=mail`,
			people.owner,
		);

		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe(`${membersPath(ACME)}?from=mail`);
	});

	it("tells a stranger nothing: the same 404 as any other address of the organisation", async () => {
		const old = `${organisationPath(ACME)}/settings/members`;
		expect((await open(old, stranger)).status).toBe(404);
	});
});
