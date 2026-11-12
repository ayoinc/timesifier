import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	canSee,
	compactNavigation,
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
import {
	addressFor,
	allRoutes,
	isMoved,
	namesARecord,
	opensFor,
	STAND_IN_ORGANISATION,
} from "../routes";
import { open, openData, type Person, pageBody, person, submit, textOf } from "./harness";

// The navigation by heading and role (docs/navigation.md, "The navigation, top
// to bottom"; cards TS-053 and TS-064). Each role is shown the destinations its row names,
// under the headings that have a link shown, and gets 404 at the address of a
// destination it is not shown and at every page below it: the same 404 that a
// person who is not a member gets for another organisation's address
// (test/pages/isolation.test.ts). Every request goes through the Worker.

const ACME = STAND_IN_ORGANISATION;
const NOBODYS = "globex";

/**
 * The pages of one organisation that belong to a destination, read from the
 * route configuration. A page of one record is asked for at a record made for
 * it (`addressFor`); a page below a destination that only some of those shown
 * it may open, such as the default rates, says who (`opensFor`).
 */
const destinationPages = allRoutes
	.filter((route) => !isMoved(route))
	.map((route) => ({ route, index: destinationIndex(ACME, route.address) }))
	.filter(({ index }) => index >= 0)
	// A record's address, such as a receipt's, is 404 to a member too: its own test follows it.
	.filter(({ route }) => !namesARecord(route))
	.map(({ route, index }) => ({
		route,
		address: route.address,
		destination: destinations[index]?.id as DestinationId,
	}));

/** Who is shown what, by docs/navigation.md: the expected link labels of each kind of person, in order. */
const EVERYTHING = [
	"Timesheet",
	"Time off",
	"Expenses",
	"Team",
	"Clients",
	"Projects",
	"Tasks",
	"Invoices",
	"Estimates",
	"Approvals",
	"Reports",
	"Dashboards",
	"Activity log",
	"Integrations",
	"Workspace settings",
];
const SHOWN: Record<string, string[]> = {
	owner: EVERYTHING,
	admin: EVERYTHING,
	finance: [
		"Timesheet",
		"Time off",
		"Expenses",
		"Clients",
		"Projects",
		"Invoices",
		"Estimates",
		"Reports",
		"Dashboards",
		"Activity log",
	],
	manager: [
		"Timesheet",
		"Time off",
		"Expenses",
		"Team",
		"Projects",
		"Approvals",
		"Reports",
		"Dashboards",
		"Activity log",
	],
	member: ["Timesheet", "Time off", "Expenses", "Projects", "Reports"],
};

const VIEWERS: Record<string, Viewer> = {
	owner: { role: "owner", managesTeams: false, clientsEnabled: true },
	admin: { role: "admin", managesTeams: false, clientsEnabled: true },
	finance: { role: "finance", managesTeams: false, clientsEnabled: true },
	manager: { role: "member", managesTeams: true, clientsEnabled: true },
	member: { role: "member", managesTeams: false, clientsEnabled: true },
};

/** What the bar under 600px holds for each kind of person, and what More holds under its headings. */
const COMPACT: Record<string, { bar: string[]; more: [string | null, string[]][] }> = {
	owner: {
		bar: ["Timesheet", "Time off", "Expenses", "Projects"],
		more: [
			["Organize", ["Team", "Clients", "Tasks"]],
			["Bill", ["Invoices", "Estimates"]],
			["Review", ["Approvals", "Reports", "Dashboards", "Activity log"]],
			[null, ["Integrations", "Workspace settings"]],
		],
	},
	finance: {
		bar: ["Timesheet", "Time off", "Expenses", "Projects"],
		more: [
			["Organize", ["Clients"]],
			["Bill", ["Invoices", "Estimates"]],
			["Review", ["Reports", "Dashboards", "Activity log"]],
		],
	},
	manager: {
		bar: ["Timesheet", "Time off", "Expenses", "Projects"],
		more: [
			["Organize", ["Team"]],
			["Review", ["Approvals", "Reports", "Dashboards", "Activity log"]],
		],
	},
	member: { bar: ["Timesheet", "Time off", "Expenses", "Projects", "Reports"], more: [] },
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
	const finance = await person(mailbox, "katherine@example.com");
	const manager = await person(mailbox, "hedy@example.com");
	const member = await person(mailbox, "linus@example.com");
	await seedMembership(acme.id, admin.user.id, "admin");
	await seedMembership(acme.id, finance.user.id, "finance");
	await seedMembership(acme.id, manager.user.id, "member");
	await seedMembership(acme.id, member.user.id, "member");
	await seedTeam(acme.id, "Design", { members: [member.user.id], managers: [manager.user.id] });
	people = { owner, admin, finance, manager, member };
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

/** The labels of the links in some HTML, in order. */
function labelsOf(html: string): string[] {
	return [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map(([, inner]) => readOut(inner ?? ""));
}

/** The text of some HTML as a screen reader reads it: words hidden from it, such as a bar label, left out. */
function readOut(html: string): string {
	return textOf(html.replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, ""));
}

/** The destinations' list of a navigation: what follows the timer's control, up to "More". */
function listOf(nav: string): string {
	const more = nav.search(/<button[^>]*popovertarget=/i);
	return nav.slice(nav.indexOf("<ul"), more < 0 ? undefined : more);
}

/** The labels of the destinations' links in a navigation, in order. */
function linksOf(nav: string): string[] {
	return labelsOf(listOf(nav));
}

/** The labels of the links the bar under 600px leaves out of view: those the CSS hides there. */
function hiddenInBarOf(nav: string): string[] {
	return [...listOf(nav).matchAll(/<li class="[^"]*max-medium:hidden[^"]*">([\s\S]*?)<\/li>/g)].map(
		([, inner]) => readOut(inner ?? ""),
	);
}

/** What the popover More opens holds: its headings and their links, or null when there is no More. */
function moreOf(nav: string): [string | null, string[]][] | null {
	const popover = /<div[^>]*id="navigation-more"[^>]*>([\s\S]*)<\/div>\s*<\/div>\s*$/.exec(
		nav,
	)?.[1];
	if (popover === undefined) return null;
	return [
		...popover.matchAll(/<div[^>]*>(?:<p[^>]*>([^<]*)<\/p>)?<ul[^>]*>([\s\S]*?)<\/ul><\/div>/g),
	].map(([, heading, list]) => [heading ?? null, labelsOf(list ?? "")]);
}

/** A 404's body, with the organisation's address taken out. */
async function notFoundBody(response: Response, slug: string): Promise<string> {
	return (await pageBody(response)).replaceAll(organisationPath(slug), organisationPath("~"));
}

describe("the list of destinations", () => {
	it("is the navigation of docs/navigation.md, in its order", () => {
		expect(destinations.map(({ label, heading }) => [heading, label])).toEqual([
			["Track", "Timesheet"],
			["Track", "Time off"],
			["Track", "Expenses"],
			["Organize", "Team"],
			["Organize", "Clients"],
			["Organize", "Projects"],
			["Organize", "Tasks"],
			["Bill", "Invoices"],
			["Bill", "Estimates"],
			["Review", "Approvals"],
			["Review", "Reports"],
			["Review", "Dashboards"],
			["Review", "Activity log"],
			[null, "Integrations"],
			[null, "Workspace settings"],
		]);
	});

	it.each(Object.keys(VIEWERS))("shows a %s what that row names", (kind) => {
		const viewer = VIEWERS[kind] as Viewer;
		const shown = destinations.filter(({ id }) => canSee(viewer, id)).map(({ label }) => label);
		expect(shown).toEqual(SHOWN[kind]);
	});

	it.each(Object.keys(COMPACT))(
		"under 600px gives a %s the bar and the More of docs/navigation.md",
		(kind) => {
			const viewer = VIEWERS[kind] as Viewer;
			const visible = destinations.filter(({ id }) => canSee(viewer, id)).map(({ id }) => id);
			const { bar, more } = compactNavigation(visible);
			const label = (id: DestinationId) => destinations.find((each) => each.id === id)?.label;
			expect(bar.map(label)).toEqual(COMPACT[kind]?.bar);
			expect(
				more.map(({ heading, destinations: links }) => [heading, links.map(({ label }) => label)]),
			).toEqual(COMPACT[kind]?.more);
		},
	);

	it("never puts a lone destination in More: it stays in the bar", () => {
		const member = compactNavigation(["timesheet", "time-off", "expenses", "projects", "reports"]);
		expect(member.bar).toEqual(["timesheet", "time-off", "expenses", "projects", "reports"]);
		expect(member.more).toEqual([]);
		const two = compactNavigation([
			"timesheet",
			"time-off",
			"expenses",
			"projects",
			"reports",
			"team",
		]);
		expect(two.bar).toEqual(["timesheet", "time-off", "expenses", "projects"]);
		expect(two.more.map(({ heading }) => heading)).toEqual(["Organize", "Review"]);
	});

	it("hides Clients from everyone when the organisation turns Clients off, and nothing else", () => {
		for (const viewer of Object.values(VIEWERS)) {
			const off = { ...viewer, clientsEnabled: false };
			for (const { id } of destinations) {
				expect(canSee(off, id), id).toBe(id === "clients" ? false : canSee(viewer, id));
			}
		}
	});

	it("covers every destination, the pages of Team, a project's page and the default rates in the pages walked below", () => {
		const covered = new Set(destinationPages.map(({ destination }) => destination));
		expect([...covered].sort()).toEqual(destinations.map(({ id }) => id).sort());
		const ids = destinationPages.map(({ route }) => route.id);
		expect(destinationPages.map(({ address }) => address)).toContain(membersPath(ACME));
		expect(ids).toContain("routes/app/project");
		expect(ids).toContain("routes/app/rates");
	});
});

describe.each(Object.keys(SHOWN))("to a %s", (kind) => {
	it("the navigation shows their links, each heading only when a link under it shows", async () => {
		const who = people[kind] as Person;
		const nav = navigationOf(await pageBody(await open(organisationPath(ACME), who)));
		const labels = SHOWN[kind] as string[];

		expect(linksOf(nav)).toEqual(labels);
		for (const heading of ["Track", "Organize", "Bill", "Review"]) {
			const under = destinations.filter(
				(each) => each.heading === heading && labels.includes(each.label),
			);
			expect(nav.includes(`>${heading}</span>`), heading).toBe(under.length > 0);
		}
	});

	it("under 600px the bar keeps its links and More holds the rest, under their headings", async () => {
		const who = people[kind] as Person;
		const nav = navigationOf(await pageBody(await open(organisationPath(ACME), who)));
		const compact = COMPACT[kind === "admin" ? "owner" : kind];
		if (!compact) throw new Error(kind);

		const inMore = compact.more.flatMap(([, links]) => links);
		expect(hiddenInBarOf(nav)).toEqual(SHOWN[kind]?.filter((label) => inMore.includes(label)));
		if (compact.more.length === 0) expect(moreOf(nav)).toBeNull();
		else expect(moreOf(nav)).toEqual(compact.more);
	});

	it("every page of a destination: shown, or the same 404 as another organisation's", async () => {
		const who = people[kind] as Person;
		const viewer = VIEWERS[kind] as Viewer;
		for (const { route, destination } of destinationPages) {
			const address = await addressFor(route, acme.id);
			const page = await open(address, who);
			const data = await openData(address, who);

			// A page below a destination that holds money, such as the default
			// rates or the Contractors report, is the same 404 to whoever does
			// not see rates (TS-067, TS-079).
			if (canSee(viewer, destination) && opensFor(route, viewer.role)) {
				expect(page.status, address).toBe(200);
				expect(data.status, address).toBe(200);
				continue;
			}
			expect(page.status, address).toBe(404);
			expect(data.status, address).toBe(404);
			if (canSee(viewer, destination) && route.hasPage) {
				// A page below a destination they are shown: the 404 of an address
				// that holds no page, drawn in their own shell, with none of the page.
				// A file, such as the Contractors export, answers as a stranger's would.
				const text = textOf(await pageBody(page));
				expect(text, address).toContain("There's no page here");
				expect(text, address).not.toContain("Default rates");
				continue;
			}
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
		"comes before the first heading for a %s, and with nothing running is Track time, to the Day view's timer",
		async (kind) => {
			const nav = navigationOf(
				await pageBody(await open(organisationPath(ACME), people[kind] as Person)),
			);
			const timer = nav.slice(0, nav.indexOf("<ul"));

			expect(nav.indexOf("<ul")).toBeGreaterThan(0);
			expect(timer).toMatch(/<a[^>]*href="\/app\/acme#timer"[^>]*>[\s\S]*Track time[\s\S]*<\/a>/);
			expect(textOf(timer)).toBe("Track time");
		},
	);
});

describe("the profile menu (TS-063)", () => {
	it.each(Object.keys(SHOWN))(
		"is in the band for a %s, with no other way to My account there",
		async (kind) => {
			const who = people[kind] as Person;
			const html = await pageBody(await open(organisationPath(ACME), who));
			const band = /<header\b[^>]*>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";

			// Named after the person, who has given no name yet: their address, and its first letter.
			const button = new RegExp(
				`<button[^>]*aria-label="Account menu for ${who.user.email}, ${who.user.email.charAt(0).toUpperCase()}"[^>]*>[\\s\\S]*?<\\/button>`,
			).exec(band)?.[0];
			expect(button).toBeDefined();
			expect(textOf(button ?? "")).toBe(who.user.email.charAt(0).toUpperCase());
			// The menu is closed until it is opened: neither of its items is in the band.
			expect(textOf(band)).not.toContain("My account");
			expect(textOf(band)).not.toContain("Sign out");
			expect((await open(`${organisationPath(ACME)}/account`, who)).status).toBe(200);
		},
	);
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
