import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationPath } from "~/shell/destinations";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, value } from "../organisations/harness";
import { allRoutes, isMoved, routesAtOrUnder, STAND_IN_ORGANISATION } from "../routes";
import { open, openData, type Person, pageBody, person, submit } from "./harness";

// Criterion 4 of card TS-009: a member of one organisation receives 404 for
// any URL of another organisation.
//
// The routes are read from the built route configuration. Every route under
// the organisation layout is requested three ways (the page, its data, and a
// form where it has an action) by a person who is not a member, and for a slug
// no organisation has. Both get 404, and the two answers are the same, so the
// address of an organisation tells a stranger nothing, not even that it exists.

const LAYOUT = "routes/app/organisation";
const THEIRS = STAND_IN_ORGANISATION;
const NOBODYS = "globex";

/** Every route of one organisation: the layout that checks membership, and all it holds. */
const ofAnOrganisation = allRoutes.filter(
	(route) => route.id === LAYOUT || route.ancestors.includes(LAYOUT),
);
const withAction = ofAnOrganisation.filter((route) => route.hasAction);

/** The same address in the organisation nobody has. */
function inNobodys(address: string): string {
	return address.replace(organisationPath(THEIRS), organisationPath(NOBODYS));
}

/**
 * What a response says, apart from the address it was asked for, which a page
 * may repeat and the person asking already has.
 */
async function said(response: Response, slug: string): Promise<string> {
	return (await pageBody(response)).replaceAll(organisationPath(slug), organisationPath("~"));
}

let mailbox: Mailbox;
/** A member of an organisation of her own, and of no other. */
let grace: Person;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Ada owns Acme, at /app/acme. Grace owns Initech and asks for Acme's pages. */
async function twoOrganisations() {
	const ada = await person(mailbox, "ada@example.com");
	expect((await createOrganisation(ada.cookie, "Acme")).slug).toBe(THEIRS);
	grace = await person(mailbox, "grace@example.com");
	await createOrganisation(grace.cookie, "Initech");
	expect(await value("select count(*) from organisations where slug = ?", NOBODYS)).toBe(0);
	return { ada };
}

describe("the list of an organisation's routes", () => {
	it("is every route whose address holds the organisation, and no other", () => {
		expect(allRoutes.some((route) => route.id === LAYOUT)).toBe(true);
		// A route that takes an organisation in its address and is not under the
		// layout would not be covered by its check. There is none.
		const underAddress = routesAtOrUnder(organisationPath(THEIRS)).map(({ id }) => id);
		expect(underAddress.sort()).toEqual(ofAnOrganisation.map(({ id }) => id).sort());
	});

	it("holds the layout, the seven destinations, the pages of Team, the export of Reports, My account and the moved address", () => {
		expect(ofAnOrganisation.map(({ address }) => address).sort()).toEqual(
			[
				"/app/acme",
				"/app/acme",
				"/app/acme/projects",
				"/app/acme/clients",
				"/app/acme/team",
				"/app/acme/team/members",
				"/app/acme/team/invitations",
				"/app/acme/approvals",
				"/app/acme/reports",
				"/app/acme/reports/export",
				"/app/acme/settings",
				"/app/acme/account",
				"/app/acme/settings/members",
			].sort(),
		);
	});

	it("has routes with an action, so a POST is covered too", () => {
		expect(withAction.map(({ id }) => id).sort()).toEqual([
			"routes/app/account",
			"routes/app/approvals",
			"routes/app/clients",
			"routes/app/invitations",
			"routes/app/members",
			"routes/app/projects",
			"routes/app/settings",
			"routes/app/team",
			"routes/app/timesheet",
		]);
	});
});

describe("a member of one organisation asking for another organisation's address", () => {
	it.each(ofAnOrganisation)("$id: the page $address is 404", async (route) => {
		const { address } = route;
		const { ada } = await twoOrganisations();
		expect((await open(address, ada)).status).toBe(isMoved(route) ? 301 : 200);

		const theirs = await open(address, grace);
		const nobodys = await open(inNobodys(address), grace);

		expect(theirs.status).toBe(404);
		expect(nobodys.status).toBe(404);
		const body = await said(theirs, THEIRS);
		expect(body).toBe(await said(nobodys, NOBODYS));
		// A resource route, a file to download, answers with the same 404 as
		// nobody's address and draws no page.
		if (route.hasPage) {
			expect(body).toContain("There is no page at this address, or it is not yours to open.");
		}
		expect(body).not.toContain("Acme");
	});

	it.each(ofAnOrganisation)("$id: the data of $address is 404", async (route) => {
		const { address } = route;
		const { ada } = await twoOrganisations();
		// A redirect is answered to a data request with 202 and where to go.
		expect((await openData(address, ada)).status).toBe(isMoved(route) ? 202 : 200);

		const theirs = await openData(address, grace);
		const nobodys = await openData(inNobodys(address), grace);

		expect(theirs.status).toBe(404);
		expect(nobodys.status).toBe(404);
		const body = await said(theirs, THEIRS);
		expect(body).toBe(await said(nobodys, NOBODYS));
		expect(body).not.toContain("Acme");
	});

	// Each form is one the route's action would act on for a member: the 404 is
	// for who is asking, not for what was sent.
	const FORMS: Record<string, Record<string, string>> = {
		"routes/app/settings": { intent: "rename", name: "Taken over" },
		"routes/app/members": { intent: "role", memberId: "m-ada", role: "member" },
		"routes/app/invitations": { intent: "invite", email: "mallory@example.com", role: "admin" },
		"routes/app/account": { intent: "leave" },
		"routes/app/projects": { intent: "create", name: "Taken over" },
		"routes/app/clients": { intent: "create", name: "Taken over" },
		"routes/app/team": { intent: "create", name: "Taken over" },
		"routes/app/approvals": { intent: "approve-all", startsOn: "2026-01-05" },
		"routes/app/timesheet": { intent: "stop" },
	};

	it.each(withAction)(
		"$id: a form posted to $address is 404, and its action does not run",
		async ({ id, address }) => {
			const fields = FORMS[id];
			if (!fields) throw new Error(`Add a form for ${id} to FORMS.`);
			await twoOrganisations();

			for (const byScript of [false, true]) {
				const theirs = await submit(address, fields, grace, { byScript });
				const nobodys = await submit(inNobodys(address), fields, grace, { byScript });

				expect(theirs.status).toBe(404);
				expect(nobodys.status).toBe(404);
				expect(await said(theirs, THEIRS)).toBe(await said(nobodys, NOBODYS));
			}
			expect(await value("select name from organisations where slug = ?", THEIRS)).toBe("Acme");
			expect(await value("select count(*) from memberships")).toBe(2);
			expect(await value("select count(*) from invitations")).toBe(0);
			expect(await value("select count(*) from projects")).toBe(0);
			expect(await value("select count(*) from clients")).toBe(0);
			expect(await value("select count(*) from teams")).toBe(0);
		},
	);

	it("is 404 for a person who belongs to no organisation at all", async () => {
		await twoOrganisations();
		const nobody = await person(mailbox, "nobody@example.com");

		for (const { address } of ofAnOrganisation) {
			expect((await open(address, nobody)).status, address).toBe(404);
			expect((await openData(address, nobody)).status, address).toBe(404);
		}
	});

	it("is 404 from the moment a member is removed", async () => {
		const { ada } = await twoOrganisations();
		const settings = "/app/acme/settings";
		expect((await open(settings, ada)).status).toBe(200);

		// Grace takes Ada's place as the owner of Acme; Ada's session is untouched.
		const acme = await value<string>("select id from organisations where slug = ?", THEIRS);
		await env.DB.batch([
			env.DB.prepare(
				"insert into memberships (id, organisation_id, user_id, role, created_at, updated_at) values ('m-grace', ?, ?, 'owner', 0, 0)",
			).bind(acme, grace.user.id),
			env.DB.prepare("delete from memberships where organisation_id = ? and user_id = ?").bind(
				acme,
				ada.user.id,
			),
		]);

		expect((await open(settings, ada)).status).toBe(404);
		expect((await openData(settings, ada)).status).toBe(404);
		expect((await open(settings, grace)).status).toBe(200);
	});
});
