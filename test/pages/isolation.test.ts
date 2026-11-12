import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationPath } from "~/shell/destinations";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation, value } from "../organisations/harness";
import {
	addressFor,
	allRoutes,
	isMoved,
	isNotFound,
	namesARecord,
	routesAtOrUnder,
	STAND_IN_ORGANISATION,
} from "../routes";
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
 * What a member gets at the route's address. A route that names a record
 * `addressFor` makes none for, such as a receipt or an invoice, names one Ada
 * has none called "x": her own organisation answers 404 too, and each such
 * route has a test of its own with a real record.
 */
function memberStatus(route: (typeof allRoutes)[number]): number {
	if (isMoved(route)) return 301;
	return isNotFound(route) || namesARecord(route) ? 404 : 200;
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
	const acme = await createOrganisation(ada.cookie, "Acme");
	expect(acme.slug).toBe(THEIRS);
	grace = await person(mailbox, "grace@example.com");
	await createOrganisation(grace.cookie, "Initech");
	expect(await value("select count(*) from organisations where slug = ?", NOBODYS)).toBe(0);
	return { ada, acme };
}

describe("the list of an organisation's routes", () => {
	it("is every route whose address holds the organisation, and no other", () => {
		expect(allRoutes.some((route) => route.id === LAYOUT)).toBe(true);
		// A route that takes an organisation in its address and is not under the
		// layout would not be covered by its check. There is none.
		const underAddress = routesAtOrUnder(organisationPath(THEIRS)).map(({ id }) => id);
		expect(underAddress.sort()).toEqual(ofAnOrganisation.map(({ id }) => id).sort());
	});

	it("holds the layout, the fifteen destinations, the pages of Team, a project's page and the default rates, the exports of Reports, the Expenses view, a receipt, the Contractors report and its export, the export of the Activity log, the invoices ZIP of Integrations, an entry's history, the pages of Invoices and Estimates, My account, the moved address and the catch-all", () => {
		expect(ofAnOrganisation.map(({ address }) => address).sort()).toEqual(
			[
				"/app/acme",
				"/app/acme",
				"/app/acme/time-off",
				"/app/acme/timesheet/day",
				"/app/acme/timesheet/month",
				"/app/acme/expenses",
				"/app/acme/projects",
				"/app/acme/projects/rates",
				"/app/acme/projects/x",
				"/app/acme/clients",
				"/app/acme/tasks",
				"/app/acme/invoices",
				"/app/acme/estimates",
				// Invoices and Estimates (TS-073, TS-074, TS-077, TS-078, TS-088); `x` stands in for a record.
				"/app/acme/estimates/x",
				"/app/acme/estimates/x/pdf",
				"/app/acme/invoices/new",
				"/app/acme/invoices/recurring",
				"/app/acme/invoices/recurring/x",
				"/app/acme/invoices/reports",
				"/app/acme/invoices/reports/export",
				"/app/acme/invoices/retainers",
				"/app/acme/invoices/settings",
				"/app/acme/invoices/uninvoiced",
				"/app/acme/invoices/x",
				"/app/acme/invoices/x/pdf",
				"/app/acme/invoices/xero",
				"/app/acme/dashboards",
				"/app/acme/activity",
				"/app/acme/activity/export",
				"/app/acme/history",
				"/app/acme/integrations",
				"/app/acme/integrations/import",
				"/app/acme/integrations/export",
				"/app/acme/integrations/invoices-export",
				"/app/acme/team",
				"/app/acme/team/members",
				"/app/acme/team/invitations",
				"/app/acme/approvals",
				"/app/acme/reports",
				"/app/acme/reports/export",
				"/app/acme/reports/expenses",
				"/app/acme/reports/expenses/export",
				"/app/acme/expenses/x/receipt",
				"/app/acme/reports/contractors",
				"/app/acme/reports/contractors/export",
				"/app/acme/reports/utilisation",
				"/app/acme/reports/profitability",
				"/app/acme/reports/leave",
				"/app/acme/reports/leave/export",
				"/app/acme/reports/saved",
				"/app/acme/settings",
				"/app/acme/account",
				"/app/acme/account/calendar",
				"/app/acme/settings/members",
				// Any other address: `*`, stood in for by `x`.
				"/app/acme/x",
			].sort(),
		);
	});

	it("has routes with an action, so a POST is covered too", () => {
		expect(withAction.map(({ id }) => id).sort()).toEqual([
			"routes/app/account",
			"routes/app/approvals",
			"routes/app/calendar-feeds",
			"routes/app/clients",
			"routes/app/estimates",
			"routes/app/estimates.$estimate",
			"routes/app/expenses",
			"routes/app/integrations",
			"routes/app/integrations.import",
			"routes/app/invitations",
			"routes/app/invoices.$invoice",
			"routes/app/invoices.new",
			"routes/app/invoices.recurring",
			"routes/app/invoices.recurring.$recurring",
			"routes/app/invoices.retainers",
			"routes/app/invoices.settings",
			"routes/app/members",
			"routes/app/project",
			"routes/app/projects",
			"routes/app/rates",
			"routes/app/reports",
			"routes/app/reports.leave",
			"routes/app/reports.profitability",
			"routes/app/reports.saved",
			"routes/app/reports.utilisation",
			"routes/app/settings",
			"routes/app/tasks",
			"routes/app/team",
			"routes/app/time-off",
			"routes/app/timesheet",
		]);
	});
});

describe("a member of one organisation asking for another organisation's address", () => {
	it.each(ofAnOrganisation)("$id: the page $address is 404", async (route) => {
		const { ada, acme } = await twoOrganisations();
		// A page of one record, such as a project's own page, at a record of Acme's.
		const address = await addressFor(route, acme.id);
		// A member is answered the page, or the redirect of a moved address, or,
		// at an address that holds no page, the 404 drawn in their own shell.
		expect((await open(address, ada)).status).toBe(memberStatus(route));

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
		const { ada, acme } = await twoOrganisations();
		const address = await addressFor(route, acme.id);
		// A redirect is answered to a data request with 202 and where to go.
		expect((await openData(address, ada)).status).toBe(isMoved(route) ? 202 : memberStatus(route));

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
		"routes/app/reports": { intent: "save-report", name: "Taken over" },
		"routes/app/reports.utilisation": { intent: "save-report", name: "Taken over" },
		"routes/app/reports.leave": { intent: "save-report", name: "Taken over" },
		"routes/app/reports.profitability": { intent: "save-report", name: "Taken over" },
		"routes/app/reports.saved": { intent: "delete", reportId: "r-1" },
		"routes/app/clients": { intent: "create", name: "Taken over" },
		"routes/app/team": { intent: "create", name: "Taken over" },
		"routes/app/approvals": { intent: "approve-all", startsOn: "2026-01-05" },
		"routes/app/timesheet": { intent: "stop" },
		"routes/app/integrations": { intent: "token-create", name: "Taken over", scopes: "time:read" },
		"routes/app/integrations.import": { intent: "discard", importId: "i-acme" },
		"routes/app/calendar-feeds": { intent: "feed-create", follow: "me" },
		"routes/app/expenses": { intent: "delete", expenseId: "e-ada" },
		"routes/app/tasks": { intent: "create-tag", name: "Taken over" },
		"routes/app/project": { intent: "add-task", taskId: "t-general" },
		"routes/app/rates": {
			intent: "rate",
			level: "person",
			key: "u-ada",
			amount: "100",
			from: "2026-12-01",
		},
		"routes/app/time-off": {
			intent: "request",
			kindId: "k-annual",
			startsOn: "2026-12-21",
			endsOn: "2026-12-23",
		},
		"routes/app/invoices.new": { client: "c-theirs" },
		"routes/app/invoices.$invoice": { intent: "delete" },
		"routes/app/invoices.settings": {
			intent: "details",
			legalName: "Taken over",
			address: "",
			taxNumber: "",
			paymentTermsDays: "30",
			defaultNotes: "",
			lateReminderAfterDays: "",
			lateReminderEveryDays: "",
		},
		"routes/app/estimates": {
			intent: "create",
			clientId: "c-theirs",
			currency: "GBP",
			issuedOn: "2026-11-12",
			subject: "",
		},
		"routes/app/estimates.$estimate": { intent: "delete" },
		"routes/app/invoices.recurring": {
			intent: "create",
			clientId: "c-theirs",
			currency: "GBP",
			startsOn: "2026-12-01",
			frequency: "monthly",
			endsOn: "",
			paymentTermsDays: "30",
			subject: "",
			notes: "",
		},
		"routes/app/invoices.recurring.$recurring": { intent: "stop" },
		"routes/app/invoices.retainers": {
			intent: "open",
			clientId: "c-theirs",
			projectId: "all",
			currency: "GBP",
		},
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
			expect(await value("select count(*) from leave_requests")).toBe(0);
			for (const table of ["invoices", "estimates", "recurring_invoices", "retainers", "taxes"]) {
				expect(await value(`select count(*) from ${table}`), table).toBe(0);
			}
			expect(await value("select count(*) from invoice_settings")).toBe(0);
			expect(await value("select count(*) from api_tokens")).toBe(0);
			expect(await value("select count(*) from calendar_feeds")).toBe(0);
			expect(await value("select count(*) from expense_categories")).toBe(0);
		},
	);

	// The intents of TS-090, each posted by a stranger to another organisation's
	// address: the layout answers before any of them is read.
	const MORE_FORMS: { id: string; fields: Record<string, string> }[] = [
		{
			id: "routes/app/time-off",
			fields: {
				intent: "request-work",
				kind: "overtime",
				startsOn: "2026-12-21",
				endsOn: "2026-12-23",
				hours: "2",
			},
		},
		{ id: "routes/app/time-off", fields: { intent: "withdraw-work", requestId: "w-1" } },
		{ id: "routes/app/time-off", fields: { intent: "approve-work", requestId: "w-1" } },
		{ id: "routes/app/time-off", fields: { intent: "refuse-work", requestId: "w-1" } },
		{
			id: "routes/app/time-off",
			fields: { intent: "cancel-work", requestId: "w-1", comment: "Plans changed" },
		},
		{ id: "routes/app/approvals", fields: { intent: "approve-work", requestId: "w-1" } },
		{ id: "routes/app/approvals", fields: { intent: "refuse-work", requestId: "w-1" } },
		{
			id: "routes/app/settings",
			fields: {
				intent: "timesheet-rules",
				overtime: "allowed",
				weekend: "none",
				overtimeDayCap: "",
				overtimeWeekCap: "",
				shortNotice: "refused",
			},
		},
	];

	it.each(MORE_FORMS)(
		"$id: $fields.intent posted to another organisation is 404",
		async ({ id, fields }) => {
			const route = withAction.find((each) => each.id === id);
			if (!route) throw new Error(`No route ${id} with an action.`);
			await twoOrganisations();

			for (const byScript of [false, true]) {
				const theirs = await submit(route.address, fields, grace, { byScript });
				const nobodys = await submit(inNobodys(route.address), fields, grace, { byScript });

				expect(theirs.status).toBe(404);
				expect(nobodys.status).toBe(404);
				expect(await said(theirs, THEIRS)).toBe(await said(nobodys, NOBODYS));
			}
			expect(await value("select count(*) from work_requests")).toBe(0);
			expect(await value("select overtime_policy from organisations where slug = ?", THEIRS)).toBe(
				"none",
			);
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
