import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { record } from "~/activity/activity.server";
import { organisationScope } from "~/db";
import { createEstimate } from "~/estimates/estimates.server";
import { recordExpense } from "~/expenses/expenses.server";
import { startImport } from "~/import/import.server";
import { createDraft } from "~/invoices/invoices.server";
import { createRecurring } from "~/invoices/recurring.server";
import {
	type Access,
	activityScopeOf,
	mayCancelLeaveOf,
	mayChangeExpensesOf,
	mayChangeTimeOf,
	mayDecideLeaveOf,
	mayDecidePeriodOf,
	mayInvoice,
	mayManageClients,
	mayManageIntegrations,
	mayManageLeavePolicy,
	mayManageRates,
	mayManageTasks,
	mayReopenPeriods,
	maySeeExpensesOf,
	maySeeLeaveKindOf,
	maySeeRates,
	maySeeTimeOf,
	timeScopeOf,
} from "~/organisations/access";
import type { Role } from "~/organisations/roles";
import { saveReport } from "~/reports/saved.server";
import { captureEmail, type Mailbox } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	seedMember,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { parseCsv } from "../reports/csv";
import { allRoutes } from "../routes";
import { open, openData, type Person, pageBody, person, submit, textOf } from "./harness";
import { seedLeave } from "./leave-seed";
import { seedEntry, seedPeriod, seedProject } from "./periods-seed";

// The Finance role, everywhere (TS-075, research B16). Finance sees everyone's
// time and expenses read-only, every rate, invoice, estimate and report,
// Dashboards and the Activity log; it manages no member, team, leave policy,
// task, integration or workspace setting, changes no client, and decides no
// period or leave unless it manages a team, and then as a manager.
//
// The inventory below is the role test of every route of an organisation, read
// from the built route configuration: for each it gives the status of the page
// to an owner, an admin, Finance, a member who manages a team ("manager") and a
// member, and for each route with an action a form and whether each of them is
// allowed it. A route with no row fails the first test, so a route added later
// gains a Finance column with the rest. Every request goes through the Worker.

const LAYOUT = "routes/app/organisation";

const COLUMNS = ["owner", "admin", "finance", "manager", "member"] as const;
type Column = (typeof COLUMNS)[number];

/** The role each column holds: a manager is a member who manages a team. */
const ROLE_OF: Record<Column, Role> = {
	owner: "owner",
	admin: "admin",
	finance: "finance",
	manager: "member",
	member: "member",
};

/** An organisation as each column finds it: Acme, owned by Ada, with Grace, a member, in the team Design. */
interface World {
	acme: { id: string };
	ada: Person;
	/** The person of the column: Ada for the owner. A manager manages Design. */
	who: Person;
	grace: { userId: string; memberId: string };
	/** A project, Website. */
	project: string;
	/** An entry of Grace's, in a week nobody submitted. */
	entry: string;
	/** Grace's submitted week of 5 October 2026. */
	period: string;
	/** Grace's request for annual leave, waiting. */
	leave: string;
	/** A client, Initech. */
	client: string;
	/** An expense category, Travel. */
	category: string;
	/** Grace's expense, with a receipt. */
	expense: string;
	/** A previewed import of clients, Ada's. */
	importJob: string;
	/** A saved report of the column's own, Mine. */
	saved: string;
	/** A draft invoice to Initech, of one line. */
	invoice: string;
	/** An estimate to Initech. */
	estimate: string;
	/** A monthly recurring invoice to Initech. */
	recurring: string;
}

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function world(column: Column): Promise<World> {
	const ada = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(ada.cookie, "Acme");
	const grace = await seedMember(acme.id, "member", "grace@example.com");
	let who = ada;
	if (column !== "owner") {
		who = await person(mailbox, `${column}@example.com`);
		await seedMembership(acme.id, who.user.id, ROLE_OF[column]);
	}
	await seedTeam(acme.id, "Design", {
		members: [grace.userId],
		managers: column === "manager" ? [who.user.id] : [],
	});
	const project = await seedProject(acme.id, "Website");
	const [client] = await organisationScope(env.DB, acme.id).clients.insert({
		name: "Initech",
		nameKey: "initech",
	});
	if (!client) throw new Error("seed failed");
	const [category] = await organisationScope(env.DB, acme.id).expenseCategories.insert({
		name: "Travel",
		nameKey: "travel",
	});
	if (!category) throw new Error("seed failed");
	const expense = await recordExpense(organisationScope(env.DB, acme.id), grace.userId, {
		spentOn: "2026-10-13",
		projectId: project,
		categoryId: category.id,
		amount: "12.50",
		quantity: "",
		notes: "Train",
		billable: false,
		reimbursable: true,
		receipt: new File(["%PDF-1.4"], "ticket.pdf", { type: "application/pdf" }),
		removeReceipt: false,
	});
	if (!expense.ok) throw new Error("seed failed");
	const started = await startImport(
		organisationScope(env.DB, acme.id),
		ada.user.id,
		"clients",
		"clients.csv",
		"Client\nGlobex\n",
	);
	if (!started.ok) throw new Error("seed failed");
	const entry = await seedEntry(
		acme.id,
		grace.userId,
		project,
		"2026-10-13T09:00:00Z",
		"2026-10-13T11:00:00Z",
		"Copy",
	);
	// Its creation, as the Day view records it, so its history has something to show.
	await record(
		organisationScope(env.DB, acme.id),
		grace.userId,
		"time_entry.created",
		{ type: "time_entry", id: entry, ownerId: grace.userId },
		{ after: { projectId: project } },
	);
	// Initech's work: a project of its own with a rate and a billable entry
	// of Ada's, uninvoiced, and a draft, an estimate and a recurring invoice.
	const scope = organisationScope(env.DB, acme.id);
	const [billed] = await scope.projects.insert({
		name: "Portal",
		nameKey: "portal",
		clientId: client.id,
	});
	if (!billed) throw new Error("seed failed");
	await scope.rates.insert({
		kind: "billable",
		projectId: billed.id,
		userId: null,
		taskId: null,
		amountMinor: 10_000,
		currency: "GBP",
		effectiveFrom: "2026-01-01",
	});
	await scope.timeEntries.insert({
		userId: ada.user.id,
		projectId: billed.id,
		description: "Build",
		billable: true,
		startedAt: new Date("2026-10-14T09:00:00Z"),
		endedAt: new Date("2026-10-14T10:00:00Z"),
	});
	const invoice = await createDraft(scope, ada.user.id, {
		clientId: client.id,
		currency: "GBP",
		issuedOn: "2026-10-31",
		lines: [
			{
				kind: "manual",
				description: "Extra",
				projectId: null,
				quantityMilli: 1000,
				unitPriceMinor: 5000,
				amountMinor: 5000,
				timeEntryIds: [],
				expenseIds: [],
			},
		],
	});
	const estimate = await createEstimate(scope, ada.user.id, {
		clientId: client.id,
		currency: "GBP",
		issuedOn: "2026-10-31",
		poNumber: null,
		subject: null,
		notes: null,
		discountBasisPoints: 0,
	});
	const recurring = await createRecurring(scope, ada.user.id, {
		clientId: client.id,
		frequency: "monthly",
		startsOn: "2030-01-01",
		endsOn: null,
		sendAutomatically: false,
		includeUninvoicedTime: false,
		currency: "GBP",
		paymentTermsDays: 30,
		subject: null,
		notes: null,
	});
	if (!invoice.ok || !estimate?.ok || !recurring?.ok) throw new Error("seed failed");
	return {
		invoice: invoice.id,
		estimate: estimate.id,
		recurring: recurring.id,
		acme,
		ada,
		who,
		grace,
		project,
		entry,
		period: await seedPeriod(acme.id, grace.userId, "2026-10-05"),
		leave: await seedLeave(acme.id, grace.userId, "annual", "2026-12-21", "2026-12-23", {
			status: "pending",
		}),
		client: client.id,
		category: category.id,
		expense: expense.id,
		importJob: started.id,
		saved: await saveReport(
			organisationScope(env.DB, acme.id),
			who.user.id,
			"Mine",
			"view=time&range=this-week",
		),
	};
}

/** A page's status. 301 is an address that has moved. */
type PageStatus = 200 | 301 | 404;
/** What a form comes to: done, or refused with this status and nothing changed. */
type Post = "done" | 403 | 404;

interface Row {
	/** The status of the page, and of its data, to each column. */
	page: Record<Column, PageStatus>;
	/** The address asked for, where the route needs more than its own. */
	address?: (w: World) => string;
	/** A form the route's action takes, and whether each column is allowed it. */
	form?: {
		fields: (w: World) => Record<string, string>;
		/** Whether what the form asks for was done. */
		made: (w: World) => Promise<boolean>;
		post: Record<Column, Post>;
		/** What a done form answers a script: 202 where the action redirects. */
		doneStatus?: 200 | 202;
	};
}

function by<T>(owner: T, admin: T, finance: T, manager: T, member: T): Record<Column, T> {
	return { owner, admin, finance, manager, member };
}
const every = <T>(cell: T) => by(cell, cell, cell, cell, cell);
const count = (sql: string, ...values: unknown[]) => value<number>(sql, ...values);

/**
 * The role table of every route of an organisation (docs/security.md,
 * "Destinations by role" and "Whose time"), with its Finance column.
 */
/** Reports, and the range a view is asked with, so it can be saved. */
const REPORTS_AT = "/app/acme/reports";
const RANGE = "?range=this-week";

/** A view of Reports saved as Ours: everyone shown the view may save it. */
function savesItsReport(view: string): NonNullable<Row["form"]> {
	return {
		fields: () => ({ intent: "save-report", name: "Ours" }),
		made: async (w) =>
			(await count(
				"select count(*) from saved_reports where owner_id = ? and name = 'Ours' and query like ?",
				w.who.user.id,
				`view=${view}&%`,
			)) === 1,
		post: every<Post>("done"),
	};
}

const ROLE_TABLE: Record<string, Row> = {
	[LAYOUT]: { page: every(200) },
	"routes/app/timesheet": {
		page: every(200),
		form: {
			// Nobody changes another person's entries, whatever their role (decision 25).
			fields: (w) => ({ intent: "delete", entryId: w.entry }),
			made: async (w) =>
				(await count("select count(*) from time_entries where id = ?", w.entry)) === 0,
			post: every(404),
		},
	},
	"routes/app/time-off": {
		page: every(200),
		form: {
			fields: (w) => ({ intent: "approve", requestId: w.leave }),
			made: async (w) =>
				(await value<string>("select status from leave_requests where id = ?", w.leave)) ===
				"approved",
			post: by<Post>("done", "done", 403, "done", 403),
		},
	},
	"routes/app/expenses": {
		page: every(200),
		form: {
			// Everyone records their own expenses.
			fields: (w) => ({
				intent: "record",
				spentOn: "2026-10-14",
				projectId: w.project,
				categoryId: w.category,
				amount: "9.00",
				notes: "Lunch",
			}),
			made: async (w) =>
				(await count(
					"select count(*) from expenses where user_id = ? and notes = 'Lunch'",
					w.who.user.id,
				)) === 1,
			post: every<Post>("done"),
		},
	},
	// Grace's receipt: whoever may see her expenses, Finance and her manager included.
	"routes/app/expenses.receipt": {
		address: (w) => `/app/acme/expenses/${w.expense}/receipt`,
		page: by(200, 200, 200, 200, 404),
	},
	"routes/app/team": {
		page: by(200, 200, 404, 200, 404),
		form: {
			fields: () => ({ intent: "create", name: "Platform" }),
			made: async () => (await count("select count(*) from teams where name = 'Platform'")) === 1,
			post: by<Post>("done", "done", 404, 403, 404),
		},
	},
	"routes/app/members": {
		page: by(200, 200, 404, 200, 404),
		form: {
			fields: (w) => ({ intent: "role", memberId: w.grace.memberId, role: "admin" }),
			made: async (w) =>
				(await value<string>("select role from memberships where id = ?", w.grace.memberId)) ===
				"admin",
			post: by<Post>("done", "done", 404, 403, 404),
		},
	},
	"routes/app/invitations": {
		page: by(200, 200, 404, 200, 404),
		form: {
			fields: () => ({ intent: "invite", email: "bob@example.com", role: "member" }),
			made: async () =>
				(await count("select count(*) from invitations where email = 'bob@example.com'")) === 1,
			post: by<Post>("done", "done", 404, 403, 404),
		},
	},
	"routes/app/clients": {
		page: by(200, 200, 200, 404, 404),
		form: {
			// Finance is shown Clients, to invoice them, and changes none.
			fields: () => ({ intent: "create", name: "Globex" }),
			made: async () => (await count("select count(*) from clients where name = 'Globex'")) === 1,
			post: by<Post>("done", "done", 403, 404, 404),
		},
	},
	"routes/app/projects": {
		page: every(200),
		form: {
			// Every role creates projects; owners and admins alone give one its client.
			fields: (w) => ({ intent: "create", name: "Billing", clientId: w.client }),
			made: async () => (await count("select count(*) from projects where name = 'Billing'")) === 1,
			post: by<Post>("done", "done", 403, 403, 403),
		},
	},
	// Tasks and Tags (TS-066, TS-085): owners and admins alone keep them.
	"routes/app/tasks": {
		page: by(200, 200, 404, 404, 404),
		form: {
			fields: () => ({ intent: "create", name: "Research" }),
			made: async () => (await count("select count(*) from tasks where name = 'Research'")) === 1,
			post: by<Post>("done", "done", 404, 404, 404),
		},
	},
	// The default rates (TS-067): below Projects, but seen and set only by those who see rates.
	"routes/app/rates": {
		page: by(200, 200, 200, 404, 404),
		form: {
			fields: (w) => ({
				intent: "rate",
				level: "person",
				key: w.grace.userId,
				amount: "85",
				from: "2030-01-01",
			}),
			made: async (w) =>
				(await count(
					"select count(*) from rates where user_id = ? and project_id is null",
					w.grace.userId,
				)) === 1,
			post: by<Post>("done", "done", "done", 404, 404),
		},
	},
	// A project's own page (TS-066): whoever may see the project; its rates are money.
	"routes/app/project": {
		address: (w) => `/app/acme/projects/${w.project}`,
		page: every(200),
		form: {
			fields: () => ({ intent: "rate", level: "project", amount: "90", from: "2030-01-01" }),
			made: async (w) =>
				(await count(
					"select count(*) from rates where project_id = ? and user_id is null and task_id is null",
					w.project,
				)) === 1,
			post: by<Post>("done", "done", "done", 403, 403),
		},
	},
	// Invoices and Estimates (TS-073 to TS-078, TS-088): owners', admins' and
	// Finance's alone (`mayInvoice`), every page and form below them.
	"routes/app/invoices": { page: by(200, 200, 200, 404, 404) },
	"routes/app/invoices.new": {
		page: by(200, 200, 200, 404, 404),
		form: {
			fields: (w) => ({ client: w.client }),
			doneStatus: 202,
			made: async () => (await count("select count(*) from invoices")) === 2,
			post: by<Post>("done", "done", "done", 404, 404),
		},
	},
	"routes/app/invoices.uninvoiced": { page: by(200, 200, 200, 404, 404) },
	"routes/app/invoices.reports": { page: by(200, 200, 200, 404, 404) },
	"routes/app/invoices.reports.export": { page: by(200, 200, 200, 404, 404) },
	"routes/app/invoices.xero": { page: by(200, 200, 200, 404, 404) },
	"routes/app/invoices.recurring": {
		page: by(200, 200, 200, 404, 404),
		form: {
			fields: (w) => ({
				intent: "create",
				clientId: w.client,
				currency: "GBP",
				startsOn: "2030-02-01",
				frequency: "quarterly",
				endsOn: "",
				paymentTermsDays: "30",
				subject: "",
				notes: "",
			}),
			doneStatus: 202,
			made: async () =>
				(await count("select count(*) from recurring_invoices where frequency = 'quarterly'")) ===
				1,
			post: by<Post>("done", "done", "done", 404, 404),
		},
	},
	"routes/app/invoices.recurring.$recurring": {
		address: (w) => `/app/acme/invoices/recurring/${w.recurring}`,
		page: by(200, 200, 200, 404, 404),
		form: {
			fields: () => ({ intent: "stop" }),
			made: async (w) =>
				(await count(
					"select count(*) from recurring_invoices where id = ? and stopped_at is not null",
					w.recurring,
				)) === 1,
			post: by<Post>("done", "done", "done", 404, 404),
		},
	},
	"routes/app/invoices.retainers": {
		page: by(200, 200, 200, 404, 404),
		form: {
			fields: (w) => ({ intent: "open", clientId: w.client, projectId: "all", currency: "GBP" }),
			made: async () => (await count("select count(*) from retainers")) === 1,
			post: by<Post>("done", "done", "done", 404, 404),
		},
	},
	"routes/app/invoices.settings": {
		page: by(200, 200, 200, 404, 404),
		form: {
			fields: () => ({ intent: "add-tax", name: "VAT", rate: "20" }),
			made: async () => (await count("select count(*) from taxes where name = 'VAT'")) === 1,
			post: by<Post>("done", "done", "done", 404, 404),
		},
	},
	"routes/app/invoices.$invoice": {
		address: (w) => `/app/acme/invoices/${w.invoice}`,
		page: by(200, 200, 200, 404, 404),
		form: {
			fields: () => ({ intent: "delete" }),
			doneStatus: 202,
			made: async (w) =>
				(await count("select count(*) from invoices where id = ?", w.invoice)) === 0,
			post: by<Post>("done", "done", "done", 404, 404),
		},
	},
	"routes/app/invoices.$invoice.pdf": {
		address: (w) => `/app/acme/invoices/${w.invoice}/pdf`,
		page: by(200, 200, 200, 404, 404),
	},
	"routes/app/estimates": {
		page: by(200, 200, 200, 404, 404),
		form: {
			fields: (w) => ({
				intent: "create",
				clientId: w.client,
				currency: "GBP",
				issuedOn: "2026-11-02",
				subject: "Phase two",
			}),
			doneStatus: 202,
			made: async () =>
				(await count("select count(*) from estimates where subject = 'Phase two'")) === 1,
			post: by<Post>("done", "done", "done", 404, 404),
		},
	},
	"routes/app/estimates.$estimate": {
		address: (w) => `/app/acme/estimates/${w.estimate}`,
		page: by(200, 200, 200, 404, 404),
		form: {
			fields: () => ({ intent: "delete" }),
			doneStatus: 202,
			made: async (w) =>
				(await count("select count(*) from estimates where id = ?", w.estimate)) === 0,
			post: by<Post>("done", "done", "done", 404, 404),
		},
	},
	"routes/app/estimates.$estimate.pdf": {
		address: (w) => `/app/acme/estimates/${w.estimate}/pdf`,
		page: by(200, 200, 200, 404, 404),
	},
	"routes/app/approvals": {
		page: by(200, 200, 404, 200, 404),
		form: {
			fields: (w) => ({ intent: "approve", periodId: w.period }),
			made: async (w) =>
				(await value<string>("select status from periods where id = ?", w.period)) === "approved",
			post: by<Post>("done", "done", 404, "done", 404),
		},
	},
	// Each view of Reports saves what it shows, for whoever is shown it (TS-084).
	"routes/app/reports": {
		address: () => `${REPORTS_AT}${RANGE}`,
		page: every(200),
		form: savesItsReport("time"),
	},
	"routes/app/reports.export": { page: every(200) },
	"routes/app/reports.expenses": { page: every(200) },
	"routes/app/reports.expenses.export": { page: every(200) },
	"routes/app/reports.utilisation": {
		address: () => `${REPORTS_AT}/utilisation${RANGE}`,
		page: every(200),
		form: savesItsReport("utilisation"),
	},
	"routes/app/reports.leave": {
		address: () => `${REPORTS_AT}/leave${RANGE}`,
		page: every(200),
		form: savesItsReport("leave"),
	},
	"routes/app/reports.leave.export": { page: every(200) },
	// Profitability (TS-071) is money: owners, admins and Finance only, though it is below Reports.
	"routes/app/reports.profitability": {
		page: by(200, 200, 200, 404, 404),
		form: {
			fields: (w) => ({
				intent: "cost-rate",
				userId: w.grace.userId,
				amount: "45.00",
				effectiveFrom: "2030-01-01",
			}),
			made: async (w) =>
				(await count(
					"select count(*) from rates where kind = 'cost' and user_id = ?",
					w.grace.userId,
				)) === 1,
			post: by<Post>("done", "done", "done", 404, 404),
		},
	},
	// Saved reports: each person's own, whatever their role.
	"routes/app/reports.saved": {
		page: every(200),
		form: {
			fields: (w) => ({ intent: "rename", reportId: w.saved, name: "Renamed" }),
			made: async (w) =>
				(await value<string>("select name from saved_reports where id = ?", w.saved)) === "Renamed",
			post: every<Post>("done"),
		},
	},
	// Contractors (TS-079): owners, admins and Finance only, though it is below Reports.
	"routes/app/contractors": { page: by(200, 200, 200, 404, 404) },
	"routes/app/contractors.export": { page: by(200, 200, 200, 404, 404) },
	"routes/app/dashboards": { page: by(200, 200, 200, 200, 404) },
	"routes/app/activity": { page: by(200, 200, 200, 200, 404) },
	"routes/app/activity.export": { page: by(200, 200, 200, 200, 404) },
	// One entry's history (TS-072): Grace's, which the manager of her team may see.
	"routes/app/history": {
		address: (w) => `/app/acme/history?entry=${w.entry}`,
		page: by(200, 200, 200, 200, 404),
	},
	// What Track time and the day title's month read (TS-093): each person's own, whatever their role.
	"routes/app/timesheet.day": { page: every(200) },
	"routes/app/timesheet.month": { page: every(200) },
	"routes/app/integrations": {
		page: by(200, 200, 404, 404, 404),
		form: {
			fields: () => ({ intent: "token-create", name: "Sync", scopes: "time:read" }),
			made: async () => (await count("select count(*) from api_tokens where name = 'Sync'")) === 1,
			post: by<Post>("done", "done", 404, 404, 404),
		},
	},
	"routes/app/integrations.import": {
		page: by(200, 200, 404, 404, 404),
		form: {
			fields: (w) => ({ intent: "discard", importId: w.importJob }),
			doneStatus: 202,
			made: async (w) =>
				(await count(
					"select count(*) from import_jobs where id = ? and status = 'previewed'",
					w.importJob,
				)) === 0,
			post: by<Post>("done", "done", 404, 404, 404),
		},
	},
	"routes/app/integrations.export": { page: by(200, 200, 404, 404, 404) },
	"routes/app/integrations.invoices-export": { page: by(200, 200, 404, 404, 404) },
	"routes/app/settings": {
		page: by(200, 200, 404, 404, 404),
		form: {
			fields: () => ({ intent: "rename", name: "Acme Ltd" }),
			made: async (w) =>
				(await value<string>("select name from organisations where id = ?", w.acme.id)) ===
				"Acme Ltd",
			post: by<Post>("done", "done", 404, 404, 404),
		},
	},
	"routes/app/account": {
		page: every(200),
		form: {
			fields: () => ({ intent: "name", name: "Somebody New" }),
			made: async (w) =>
				(await value<string>("select name from users where id = ?", w.who.user.id)) ===
				"Somebody New",
			post: every("done"),
		},
	},
	"routes/app/moved/settings/members": { page: every(301) },
	// Each person's own calendar feeds, whatever their role.
	"routes/app/calendar-feeds": {
		page: every(200),
		form: {
			fields: () => ({ intent: "feed-create", follow: "me" }),
			made: async (w) =>
				(await count("select count(*) from calendar_feeds where user_id = ?", w.who.user.id)) === 1,
			post: every<Post>("done"),
		},
	},
	// Any other address under an organisation (TS-091): its 404 page, to everyone.
	"routes/app/not-found": { address: () => "/app/acme/x", page: every(404) },
};

/** Every route of one organisation: the layout that checks membership, and all it holds. */
const ofAnOrganisation = allRoutes.filter(
	(route) => route.id === LAYOUT || route.ancestors.includes(LAYOUT),
);
const withAction = ofAnOrganisation.filter((route) => route.hasAction);

/** A response's status, its body read so nothing is left open. */
async function statusOf(response: Promise<Response>): Promise<number> {
	const answered = await response;
	await answered.arrayBuffer();
	return answered.status;
}

describe("the role table", () => {
	it("has a row for every route of an organisation, and a form for every action", () => {
		const missing = ofAnOrganisation.filter(({ id }) => !Object.hasOwn(ROLE_TABLE, id));
		expect(
			missing.map(({ id }) => id),
			"Add a row, with its Finance column, to ROLE_TABLE in test/pages/finance.test.ts",
		).toEqual([]);
		const formless = withAction.filter(({ id }) => !ROLE_TABLE[id]?.form);
		expect(
			formless.map(({ id }) => id),
			"Add a form, with each role's answer, to the route's row in ROLE_TABLE",
		).toEqual([]);
		const unbuilt = Object.keys(ROLE_TABLE).filter(
			(id) => !ofAnOrganisation.some((route) => route.id === id),
		);
		expect(unbuilt, "ROLE_TABLE has rows for routes that are not built").toEqual([]);
	});

	it.each(COLUMNS)(
		"answers each page and its data to the %s as the table says",
		async (column) => {
			const w = await world(column);
			const wrong: string[] = [];
			for (const route of ofAnOrganisation) {
				const row = ROLE_TABLE[route.id];
				if (!row) continue;
				const address = row.address?.(w) ?? route.address;
				const expected = row.page[column];
				const page = await statusOf(open(address, w.who));
				// A redirect is answered to a data request with 202 and where to go.
				const data = await statusOf(openData(address, w.who));
				if (page !== expected) wrong.push(`${route.id} ${address}: ${page}, not ${expected}`);
				const expectedData = expected === 301 ? 202 : expected;
				if (data !== expectedData) {
					wrong.push(`${route.id} ${address} data: ${data}, not ${expectedData}`);
				}
			}
			expect(wrong).toEqual([]);
		},
		120_000,
	);

	describe.each(COLUMNS)("a form posted by the %s", (column) => {
		it.each(withAction.map(({ id, address, isIndex }) => ({ id, address, isIndex })))(
			"$id",
			async ({ id, address, isIndex }) => {
				const form = ROLE_TABLE[id]?.form;
				if (!form) throw new Error(`Add a form for ${id} to ROLE_TABLE.`);
				const w = await world(column);
				const own = ROLE_TABLE[id]?.address?.(w) ?? address;
				const at = isIndex ? `${own}?index` : own;
				const expected = form.post[column];

				const response = await submit(at, form.fields(w), w.who, { byScript: true });
				await response.arrayBuffer();

				if (expected === "done") {
					expect(response.status).toBe(form.doneStatus ?? 200);
					expect(await form.made(w)).toBe(true);
				} else {
					expect(response.status).toBe(expected);
					expect(await form.made(w)).toBe(false);
				}
			},
			60_000,
		);
	});
});

/** The rules of `app/organisations/access.ts`, by kind of person. */
describe("the rules inside the destinations", () => {
	const ME = "me";
	const TEAM = "grace";
	const OUTSIDER = "mallory";
	const KINDS = {
		owner: { userId: ME, role: "owner", managed: new Set<string>() },
		admin: { userId: ME, role: "admin", managed: new Set<string>() },
		finance: { userId: ME, role: "finance", managed: new Set<string>() },
		"finance who manages a team": { userId: ME, role: "finance", managed: new Set([TEAM, ME]) },
		manager: { userId: ME, role: "member", managed: new Set([TEAM, ME]) },
		member: { userId: ME, role: "member", managed: new Set<string>() },
	} satisfies Record<string, Access>;
	type Kind = keyof typeof KINDS;
	const of = (
		owner: boolean,
		admin: boolean,
		finance: boolean,
		financeManager: boolean,
		manager: boolean,
		member: boolean,
	): Record<Kind, boolean> => ({
		owner,
		admin,
		finance,
		"finance who manages a team": financeManager,
		manager,
		member,
	});
	const T = true;
	const F = false;

	const RULES: [string, (access: Access) => boolean, Record<Kind, boolean>][] = [
		["sees rates", (a) => maySeeRates(a.role), of(T, T, T, T, F, F)],
		["sets rates", (a) => mayManageRates(a.role), of(T, T, T, T, F, F)],
		["invoices", (a) => mayInvoice(a.role), of(T, T, T, T, F, F)],
		["manages clients", (a) => mayManageClients(a.role), of(T, T, F, F, F, F)],
		["manages tasks", (a) => mayManageTasks(a.role), of(T, T, F, F, F, F)],
		["manages integrations", (a) => mayManageIntegrations(a.role), of(T, T, F, F, F, F)],
		["sees a team member's time", (a) => maySeeTimeOf(a, TEAM), of(T, T, T, T, T, F)],
		["sees anybody's time", (a) => maySeeTimeOf(a, OUTSIDER), of(T, T, T, T, F, F)],
		["sees anybody's expenses", (a) => maySeeExpensesOf(a, OUTSIDER), of(T, T, T, T, F, F)],
		["changes their own time", (a) => mayChangeTimeOf(a, ME), of(T, T, T, T, T, T)],
		["changes a team member's time", (a) => mayChangeTimeOf(a, TEAM), of(F, F, F, F, F, F)],
		["changes a team member's expenses", (a) => mayChangeExpensesOf(a, TEAM), of(F, F, F, F, F, F)],
		["decides a team member's period", (a) => mayDecidePeriodOf(a, TEAM), of(T, T, F, T, T, F)],
		["decides anybody's period", (a) => mayDecidePeriodOf(a, OUTSIDER), of(T, T, F, F, F, F)],
		["decides their own period", (a) => mayDecidePeriodOf(a, ME), of(T, T, F, F, F, F)],
		["reopens an approved period", (a) => mayReopenPeriods(a), of(T, T, F, F, F, F)],
		["decides a team member's leave", (a) => mayDecideLeaveOf(a, TEAM), of(T, T, F, T, T, F)],
		["decides anybody's leave", (a) => mayDecideLeaveOf(a, OUTSIDER), of(T, T, F, F, F, F)],
		["decides their own leave", (a) => mayDecideLeaveOf(a, ME), of(F, F, F, F, F, F)],
		["cancels approved leave", (a) => mayCancelLeaveOf(a, TEAM), of(T, T, F, F, F, F)],
		["sees a team member's kind of leave", (a) => maySeeLeaveKindOf(a, TEAM), of(T, T, F, T, T, F)],
		["sees anybody's kind of leave", (a) => maySeeLeaveKindOf(a, OUTSIDER), of(T, T, F, F, F, F)],
		["sets the leave policy", (a) => mayManageLeavePolicy(a), of(T, T, F, F, F, F)],
		["reports on everyone", (a) => timeScopeOf(a).everyone, of(T, T, T, T, F, F)],
		["reads everyone's activity", (a) => activityScopeOf(a).everyone, of(T, T, T, T, F, F)],
	];

	it.each(RULES)("who %s", (_, rule, expected) => {
		const found = Object.fromEntries(
			Object.entries(KINDS).map(([kind, access]) => [kind, rule(access)]),
		);
		expect(found).toEqual(expected);
	});
});

// What Finance does, page by page.

const REPORTS = "/app/acme/reports";
const EXPORT = "/app/acme/reports/export";
const TIMESHEET = "/app/acme";
const CLIENTS = "/app/acme/clients";
const PROJECTS = "/app/acme/projects";
const APPROVALS = "/app/acme/approvals";
const TIME_OFF = "/app/acme/time-off";
const ACTIVITY = "/app/acme/activity";
/** Monday 5 to Sunday 11 October 2026: a week in the past. */
const WEEK = "range=custom&from=2026-10-05&to=2026-10-11";

/**
 * Acme, owned by Ada, with Katherine as Finance, Grace, a member in Design,
 * and Mallory, a member in no team. Each tracked time in the week of 5
 * October 2026 and submitted it, and each asked for leave in December.
 * Katherine manages Design when `managesDesign` is set.
 */
async function financeWorld({ managesDesign = false } = {}) {
	const ada = await person(mailbox, "ada@example.com");
	const acme = await createOrganisation(ada.cookie, "Acme");
	const katherine = await person(mailbox, "katherine@example.com");
	await seedMembership(acme.id, katherine.user.id, "finance");
	const grace = await person(mailbox, "grace@example.com");
	await seedMembership(acme.id, grace.user.id, "member");
	const mallory = await seedMember(acme.id, "member", "mallory@example.com");
	await seedTeam(acme.id, "Design", {
		members: [grace.user.id],
		managers: managesDesign ? [katherine.user.id] : [],
	});
	const [client] = await organisationScope(env.DB, acme.id).clients.insert({
		name: "Initech",
		nameKey: "initech",
	});
	if (!client) throw new Error("seed failed");
	const website = await seedProject(acme.id, "Website");

	const people = { ada: ada.user.id, grace: grace.user.id, mallory: mallory.userId };
	await seedEntry(acme.id, people.ada, website, "2026-10-05T09:00:00Z", "2026-10-05T10:00:00Z");
	const gracesEntry = await seedEntry(
		acme.id,
		people.grace,
		website,
		"2026-10-06T09:00:00Z",
		"2026-10-06T11:00:00Z",
		"Copy",
	);
	await seedEntry(acme.id, people.mallory, website, "2026-10-08T10:00:00Z", "2026-10-08T13:00:00Z");

	const periods = {
		grace: await seedPeriod(acme.id, people.grace, "2026-10-05"),
		mallory: await seedPeriod(acme.id, people.mallory, "2026-10-05"),
		katherine: await seedPeriod(acme.id, katherine.user.id, "2026-10-05"),
	};
	const leave = (userId: string) =>
		seedLeave(acme.id, userId, "annual", "2026-12-21", "2026-12-23", { status: "pending" });
	const requests = {
		grace: await leave(people.grace),
		mallory: await leave(people.mallory),
		katherine: await leave(katherine.user.id),
	};
	return {
		acme,
		ada,
		katherine,
		grace,
		mallory,
		client: client.id,
		website,
		gracesEntry,
		periods,
		requests,
	};
}

const periodStatus = (id: string) => value<string>("select status from periods where id = ?", id);
const leaveStatus = (id: string) =>
	value<string>("select status from leave_requests where id = ?", id);

/** A form sent by script, as the pages' sheets send theirs: its status. */
async function post(path: string, fields: Record<string, string>, who: Person) {
	const response = await submit(path, fields, who, { byScript: true });
	await response.arrayBuffer();
	return response.status;
}

describe("Finance on Reports", () => {
	it("is offered Everyone, and the report and its export hold everyone's time", async () => {
		const { katherine } = await financeWorld();

		const html = await pageBody(await open(`${REPORTS}?${WEEK}`, katherine));
		const text = textOf(html);
		expect(text).toContain("Everyone's time in Acme.");
		expect(html).toContain(">Person<");
		expect(html).toMatch(/>Everyone</);
		expect(text).toMatch(/Total 6:00/);

		const response = await open(`${EXPORT}?${WEEK}`, katherine);
		expect(response.status).toBe(200);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const [header, ...rows] = parseCsv(
			new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.slice(3)),
		);
		const person = header?.indexOf("person") ?? -1;
		expect(rows.map((cells) => cells[person]?.split("@")[0]).sort()).toEqual([
			"ada",
			"grace",
			"mallory",
		]);
	});

	it("narrows to anybody in the organisation", async () => {
		const { katherine, mallory } = await financeWorld();
		const response = await open(`${REPORTS}?${WEEK}&person=${mallory.userId}`, katherine);
		expect(response.status).toBe(200);
		expect(textOf(await pageBody(response))).toMatch(/Total 3:00/);
	});
});

describe("Finance on Timesheet", () => {
	it("is shown their own time alone", async () => {
		const { acme, katherine, grace, website } = await financeWorld();
		await seedEntry(
			acme.id,
			grace.user.id,
			website,
			Date.now() - 120_000,
			Date.now() - 60_000,
			"Secret copy",
		);

		expect(textOf(await pageBody(await open(TIMESHEET, grace)))).toContain("Secret copy");
		expect(textOf(await pageBody(await open(TIMESHEET, katherine)))).not.toContain("Secret copy");
	});

	it("changes and deletes nobody else's entries", async () => {
		const { katherine, website, gracesEntry } = await financeWorld();
		const at = `${TIMESHEET}?index`;

		const edit = {
			intent: "edit",
			entryId: gracesEntry,
			projectId: website,
			date: "2026-10-06",
			start: "08:00",
			end: "12:00",
			description: "Changed",
		};
		expect(await post(at, edit, katherine)).toBe(404);
		expect(await post(at, { intent: "delete", entryId: gracesEntry }, katherine)).toBe(404);

		expect(
			await value<string>("select description from time_entries where id = ?", gracesEntry),
		).toBe("Copy");
		expect(
			await value("select ended_at - started_at from time_entries where id = ?", gracesEntry),
		).toBe(2 * 60 * 60 * 1000);
	});
});

describe("Finance and what it does not manage", () => {
	it("gets 404 at Team, Members, Invitations, Workspace settings, Tasks and Integrations, and their forms change nothing", async () => {
		const { katherine, acme, grace } = await financeWorld();
		const graceMember = await value<string>(
			"select id from memberships where user_id = ?",
			grace.user.id,
		);

		for (const page of [
			"team",
			"team/members",
			"team/invitations",
			"settings",
			"tasks",
			"integrations",
		]) {
			const address = `/app/acme/${page}`;
			expect(await statusOf(open(address, katherine)), address).toBe(404);
			expect(await statusOf(openData(address, katherine)), address).toBe(404);
		}

		expect(await post("/app/acme/team", { intent: "create", name: "Platform" }, katherine)).toBe(
			404,
		);
		expect(
			await post(
				"/app/acme/team/members",
				{ intent: "role", memberId: String(graceMember), role: "admin" },
				katherine,
			),
		).toBe(404);
		expect(
			await post(
				"/app/acme/team/invitations",
				{ intent: "invite", email: "bob@example.com", role: "member" },
				katherine,
			),
		).toBe(404);
		expect(await post("/app/acme/settings", { intent: "rename", name: "Mine" }, katherine)).toBe(
			404,
		);

		expect(await count("select count(*) from teams")).toBe(1);
		expect(await value<string>("select role from memberships where id = ?", graceMember)).toBe(
			"member",
		);
		expect(await count("select count(*) from invitations")).toBe(0);
		expect(await value<string>("select name from organisations where id = ?", acme.id)).toBe(
			"Acme",
		);
	});
});

describe("Finance on Approvals and Time off", () => {
	it("decides nothing while it manages no team: Approvals is 404, and a decision on leave is refused", async () => {
		const { katherine, periods, requests } = await financeWorld();

		expect(await statusOf(open(APPROVALS, katherine))).toBe(404);
		expect(await post(APPROVALS, { intent: "approve", periodId: periods.grace }, katherine)).toBe(
			404,
		);
		expect(await post(TIME_OFF, { intent: "approve", requestId: requests.grace }, katherine)).toBe(
			403,
		);

		expect(await periodStatus(periods.grace)).toBe("submitted");
		expect(await leaveStatus(requests.grace)).toBe("pending");
	});

	it("managing a team, decides that team's periods and leave alone, and never its own", async () => {
		const { katherine, periods, requests } = await financeWorld({ managesDesign: true });

		const page = await open(APPROVALS, katherine);
		expect(page.status).toBe(200);
		const text = textOf(await pageBody(page));
		expect(text).toContain("grace@example.com");
		expect(text).not.toContain("mallory@example.com");

		expect(await post(APPROVALS, { intent: "approve", periodId: periods.grace }, katherine)).toBe(
			200,
		);
		expect(await post(APPROVALS, { intent: "approve", periodId: periods.mallory }, katherine)).toBe(
			403,
		);
		expect(
			await post(APPROVALS, { intent: "approve", periodId: periods.katherine }, katherine),
		).toBe(403);
		expect(await periodStatus(periods.grace)).toBe("approved");
		expect(await periodStatus(periods.mallory)).toBe("submitted");
		expect(await periodStatus(periods.katherine)).toBe("submitted");

		expect(await post(TIME_OFF, { intent: "approve", requestId: requests.grace }, katherine)).toBe(
			200,
		);
		expect(
			await post(TIME_OFF, { intent: "approve", requestId: requests.mallory }, katherine),
		).toBe(403);
		expect(
			await post(TIME_OFF, { intent: "approve", requestId: requests.katherine }, katherine),
		).toBe(403);
		expect(await leaveStatus(requests.grace)).toBe("approved");
		expect(await leaveStatus(requests.mallory)).toBe("pending");
		expect(await leaveStatus(requests.katherine)).toBe("pending");
	});
});

describe("Finance on Clients", () => {
	it("sees every client and its projects, and is offered nothing to change", async () => {
		const { katherine } = await financeWorld();

		const response = await open(CLIENTS, katherine);
		expect(response.status).toBe(200);
		const html = await pageBody(response);
		expect(textOf(html)).toContain("Initech");
		expect(html).not.toContain("Create client");
		expect(html).not.toContain("Actions for Initech");
	});

	it("is refused every change to a client, and giving a project one, as docs/security.md says", async () => {
		const { katherine, ada, client } = await financeWorld();

		for (const fields of [
			{ intent: "create", name: "Globex" },
			{ intent: "rename", clientId: client, name: "Initech Ltd" },
			{ intent: "archive", clientId: client },
			{ intent: "restore", clientId: client },
		] as Record<string, string>[]) {
			expect(await post(CLIENTS, fields, katherine), fields.intent).toBe(403);
		}
		expect(await count("select count(*) from clients")).toBe(1);
		expect(await value<string>("select name from clients where id = ?", client)).toBe("Initech");
		expect(await value("select archived_at from clients where id = ?", client)).toBeNull();

		expect(
			await post(PROJECTS, { intent: "create", name: "Billing", clientId: client }, katherine),
		).toBe(403);
		expect(await count("select count(*) from projects where name = 'Billing'")).toBe(0);

		// A project with no client is every role's to create.
		expect(await post(PROJECTS, { intent: "create", name: "Billing" }, katherine)).toBe(200);
		expect(await value("select client_id from projects where name = 'Billing'")).toBeNull();

		// An owner still manages them.
		expect(await post(CLIENTS, { intent: "create", name: "Globex" }, ada)).toBe(200);
		expect(await count("select count(*) from clients")).toBe(2);
	});
});

describe("Finance on the Activity log", () => {
	it("reads everyone's records, such as a project another person created", async () => {
		const { katherine, ada, grace } = await financeWorld();
		expect(await post(PROJECTS, { intent: "create", name: "Launch" }, ada)).toBe(200);

		const response = await open(ACTIVITY, katherine);
		expect(response.status).toBe(200);
		expect(textOf(await pageBody(response))).toContain("Launch");
		// A member who manages no team is not shown it.
		expect(await statusOf(open(ACTIVITY, grace))).toBe(404);
	});
});

describe("Finance in Bill and Review", () => {
	it("opens Invoices, Estimates, Dashboards and the Activity log, which a member gets 404 for", async () => {
		const { katherine, grace } = await financeWorld();
		for (const page of ["invoices", "estimates", "dashboards", "activity"]) {
			const address = `/app/acme/${page}`;
			expect(await statusOf(open(address, katherine)), address).toBe(200);
			expect(await statusOf(open(address, grace)), address).toBe(404);
		}
	});
});
