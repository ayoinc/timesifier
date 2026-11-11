import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_MEANINGS } from "~/organisations/people";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, type Role, seedMembership } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";

// The production audit's defects on Projects, Clients, Team, Members,
// Invitations, My account and Workspace settings (TS-091), as the server
// renders them. What needs a browser is in e2e/audit-lists.spec.ts.

const ACME = "/app/acme";

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

async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

async function send(path: string, fields: Record<string, string>, who: Person = ada) {
	const response = await submit(path, fields, who, { byScript: true });
	expect(response.status, await response.text()).toBe(200);
}

const mainOf = (html: string) => html.match(/<main[\s\S]*<\/main>/)?.[0] ?? "";
const main = async (path: string, who: Person = ada) =>
	mainOf(await pageBody(await open(path, who)));

describe("My account: leaving (W26)", () => {
	const LEAVE_BUTTON = />Leave organisation<\/button>/;

	it("does not offer the only owner to leave, and says what to do instead", async () => {
		const html = await main(`${ACME}/account`);
		expect(html).not.toMatch(LEAVE_BUTTON);
		expect(textOf(html)).toContain(
			"You are the only owner of Acme. Make someone else an owner on Members , or delete the organisation in Workspace settings .",
		);
		expect(html).toContain(`href="${ACME}/team/members"`);
		expect(html).toContain(`href="${ACME}/settings"`);
	});

	it("offers it to a member, and to an owner when there is another", async () => {
		const linus = await memberOfAcme("member", "linus@example.com");
		const asMember = await main(`${ACME}/account`, linus);
		expect(asMember).toMatch(LEAVE_BUTTON);
		expect(textOf(asMember)).not.toContain("You are the only owner");

		await memberOfAcme("owner", "grace@example.com");
		const asOwner = await main(`${ACME}/account`);
		expect(asOwner).toMatch(LEAVE_BUTTON);
		expect(textOf(asOwner)).not.toContain("You are the only owner");
	});
});

describe("Projects and Clients: a row opens its sheet (W24, W15)", () => {
	it("Projects: the name is a button that opens the sheet, and there is no Actions menu or Search button", async () => {
		await send(`${ACME}/projects`, { intent: "create", name: "Website" });
		const html = await main(`${ACME}/projects`);
		expect(html).toMatch(
			/<button[^>]*type="button"[^>]*aria-haspopup="dialog"[^>]*>Website<\/button>/,
		);
		expect(html).not.toContain("Actions for");
		// Only the Apply for a browser with no script, inside <noscript>, submits the filters.
		const scripted = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
		const buttons = [...scripted.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(
			([, label]) => textOf(label ?? ""),
		);
		for (const word of ["Search", "Filter", "Apply"]) expect(buttons).not.toContain(word);
	});

	it("Clients: the name is a button that opens the sheet, and the intro says what a client is", async () => {
		await send(`${ACME}/clients`, { intent: "create", name: "Globex" });
		const html = await main(`${ACME}/clients`);
		expect(html).toMatch(
			/<button[^>]*type="button"[^>]*aria-haspopup="dialog"[^>]*>Globex<\/button>/,
		);
		expect(html).not.toContain("Actions for");
		expect(textOf(html)).toContain("The companies your projects are for.");
		expect(html).toMatch(/<form[^>]*role="search"[^>]*aria-label="Filter clients"/);
		expect(textOf(html)).toContain("Search clients");
	});

	it("archiving and restoring keep their intents, and the archived row opens the same sheet", async () => {
		await send(`${ACME}/projects`, { intent: "create", name: "Website" });
		const projectId = await env.DB.prepare(
			"select id from projects where name = 'Website'",
		).first<string>("id");
		await send(`${ACME}/projects`, { intent: "archive", projectId: projectId ?? "" });
		const archived = await main(`${ACME}/projects?show=archived`);
		expect(archived).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Website<\/button>/);
		await send(`${ACME}/projects`, { intent: "restore", projectId: projectId ?? "" });
		const active = await main(`${ACME}/projects`);
		expect(textOf(active)).toContain("Website");
	});
});

describe("Team pages: the tabs are under the heading and its sentence (W20)", () => {
	for (const [page, path] of [
		["This week", `${ACME}/team`],
		["Teams", `${ACME}/team?show=teams`],
		["Members", `${ACME}/team/members`],
		["Invitations", `${ACME}/team/invitations`],
	] as const) {
		it(page, async () => {
			const html = await main(path);
			const heading = html.indexOf("<h1");
			const tabs = html.indexOf('aria-label="Team pages"');
			expect(heading).toBeGreaterThanOrEqual(0);
			expect(tabs).toBeGreaterThan(heading);
			// The sentence under the heading comes before the tabs too.
			expect(html.slice(heading, tabs)).toMatch(
				/<p[^>]*class="[^"]*text-on-surface-variant[^"]*"[^>]*>/,
			);
		});
	}

	it("Team filters people as typed, with no Filter button (W18)", async () => {
		const html = await main(`${ACME}/team`);
		expect(html).toMatch(/<form[^>]*role="search"[^>]*aria-label="Filter people"/);
		expect(textOf(html)).toContain("Search people");
		const form = html.match(/<form[^>]*role="search"[\s\S]*?<\/form>/)?.[0] ?? "";
		expect(form.replace(/<noscript>[\s\S]*?<\/noscript>/, "")).not.toMatch(/type="submit"/);
	});
});

describe("Member's role, in words (W30)", () => {
	it("a member is someone who tracks their own time and submits their timesheet", () => {
		// The role choice, on Members and Invitations, reads its words from here.
		expect(ROLE_MEANINGS.member).toBe("Tracks their own time and submits their timesheet.");
	});
});
