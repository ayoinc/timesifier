import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it } from "vitest";
import { ACTIVITY_RETENTION_DAYS } from "~/activity/activity.server";
import { STORED } from "~/db/personal-data";
import * as schema from "~/db/schema";
import { uuidv7 } from "~/db/uuidv7";
import { ENTRY_DAYS_BACK, LEAVE_DAYS_BACK } from "~/integrations/feeds.server";
import { EVENT_LABELS } from "~/integrations/scopes";
import { SWITCH_OFF_AFTER } from "~/integrations/webhooks.server";
import { DOCUMENT_EMAILS } from "~/invoices/mail.server";
import { PHOTOS } from "~/landing/photos";
import { PRIMARY_ACTION, PRIVACY_PATH, TERMS_PATH } from "~/landing/Site";
import {
	type Access,
	mayChangeExpensesOf,
	mayChangeTimeOf,
	mayDecideLeaveOf,
	mayDecidePeriodOf,
	mayInvoice,
	mayManageIntegrations,
	maySeeExpensesOf,
	maySeeLeaveKindOf,
	maySeeRates,
	maySeeTimeOf,
} from "~/organisations/access";
import { Role } from "~/organisations/roles";
import { SIGN_IN_PATH } from "~/routes/auth/paths";
import { COLOR_SCHEME_COOKIE } from "~/shell/color-scheme.server";
import { GETTING_STARTED_COOKIE } from "~/timesheet/getting-started.server";
import worker from "../workers/app";
import { DAILY } from "../workers/scheduled";

import {
	CODE_COOKIE,
	captureEmail,
	KNOWN_COOKIE,
	ORIGIN,
	SESSION_COOKIE,
	setBinding,
	signIn,
} from "./auth/harness";
import { freshDatabase } from "./db/database";
import { createOrganisation } from "./organisations/harness";

// The public pages state facts. Each test here ties one of those sentences to
// the thing it is about, so that the code and the page cannot part company
// without a test failing. The claims were audited on 11 November 2026 (TS-030)
// and again on 12 November 2026 (TS-101), each audit in its pull request; the
// rules that came of them are in docs/design-direction.md, "Nothing on the page
// is untrue".

async function page(path: string): Promise<string> {
	const response = await exports.default.fetch(`${ORIGIN}${path}`);
	expect(response.status).toBe(200);
	// As a person reads it: tags gone, entities and comments resolved, spaces single.
	return (await response.text())
		.replace(/<!--.*?-->/gs, "")
		.replace(/&#x27;|&#39;|’/g, "'")
		.replace(/&amp;/g, "&");
}

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// Only the words are read: nothing is run.
const readme = import.meta.glob<string>("../README.md", {
	eager: true,
	query: "?raw",
	import: "default",
})["../README.md"];
const wrangler = import.meta.glob<string>("../wrangler.jsonc", {
	eager: true,
	query: "?raw",
	import: "default",
})["../wrangler.jsonc"];

/** Every cookie the application sets, by the name a browser shows for it. */
const COOKIES = [
	SESSION_COOKIE,
	CODE_COOKIE,
	KNOWN_COOKIE,
	COLOR_SCHEME_COOKIE,
	GETTING_STARTED_COOKIE,
];
const COUNT = ["no", "one", "two", "three", "four", "five", "six"];

it("the privacy notice lists every cookie the application sets, and counts them", async () => {
	const html = await page(PRIVACY_PATH);

	for (const cookie of COOKIES) expect(html, cookie).toContain(`>${cookie}<`);
	// It names no cookie the application does not set.
	const named = new Set(html.match(/__Host-[\w.-]+/g));
	expect([...named].sort()).toEqual([...COOKIES].sort());
	expect(words(html)).toContain(`sets ${COUNT[COOKIES.length]} cookies and no others`);
});

it("the pages say the database is in the EU because that is how the databases are created", async () => {
	// A D1 database's jurisdiction is fixed when it is created and is in no
	// configuration file: the README's commands are where the repository keeps it.
	expect(readme).toBeDefined();
	const created = (readme ?? "").split("\n").filter((line) => line.includes("wrangler d1 create"));
	expect(created.length).toBeGreaterThan(0);
	for (const command of created) expect(command).toContain("--jurisdiction eu");

	for (const path of ["/", PRIVACY_PATH]) {
		expect(words(await page(path)), path).toContain("runs and stores its data only inside the EU");
	}
});

it("wherever a page says the database is in the EU, it says what is not", async () => {
	for (const path of ["/", PRIVACY_PATH]) {
		const text = words(await page(path));
		expect(text, path).toContain("data centre nearest to you");
		expect(text, path).toContain("not restricted to the EU");
	}
});

it("the pages say requests are handled in Frankfurt because the Worker is placed there", async () => {
	// A Placement Hint runs the Worker in the data centre with the lowest latency
	// to the cloud region it names; aws:eu-central-1 is Frankfurt
	// (docs/decisions.md 34). A commented-out line does not count.
	expect(wrangler).toMatch(/^\t"placement": \{ "region": "aws:eu-central-1" \},$/m);
	for (const path of ["/", PRIVACY_PATH]) {
		expect(words(await page(path)), path).toContain("is passed to Frankfurt");
	}
});

it("each photographer is named once, in the credits at the foot of the page, not under the photograph", async () => {
	const pages = { "/": Object.values(PHOTOS), [SIGN_IN_PATH]: [PHOTOS.platform] };
	for (const [path, photos] of Object.entries(pages)) {
		const html = await page(path);
		const footer = html.slice(html.lastIndexOf("<footer"));
		expect(words(footer), path).toContain("Credits");
		for (const photo of photos) {
			expect(html.split(photo.author).length - 1, `${path}: ${photo.author}`).toBe(1);
			expect(footer).toContain(photo.author);
		}
		expect(words(html.slice(0, html.lastIndexOf("<footer"))), path).not.toMatch(/Photograph/);
	}
});

it("the home page has one primary action, said the same at the top and at the end, and one way in", async () => {
	const html = await page("/");
	const actions = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].filter(
		([, , label]) => label === PRIMARY_ACTION,
	);

	expect(actions.map(([, href]) => href)).toEqual([SIGN_IN_PATH, SIGN_IN_PATH]);
	// And one quiet "Sign in", in the band at the top, to the same page.
	const quiet = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>Sign in<\/a>/g)];
	expect(quiet.map(([, href]) => href)).toEqual([SIGN_IN_PATH]);
});

it("the privacy notice names this deployment's host and sender, from its settings and the request", async () => {
	setBinding("EMAIL_FROM", "no-reply@mail.timesifier.example");
	const text = words(await page(PRIVACY_PATH));

	const { host } = new URL(ORIGIN);
	expect(text).toContain(`Each is sent only to ${host}`);
	expect(text).toContain(`cannot reach ${host}.`);
	expect(text).toContain("email service, from no-reply@mail.timesifier.example. Timesifier sends");

	// A deployment that sends no mail names no address.
	setBinding("EMAIL_FROM", undefined);
	expect(words(await page(PRIVACY_PATH))).toContain("Cloudflare's email service. Timesifier sends");
});

// What is stored, who sees it, how long it is kept and who else is sent it:
// the claims of TS-101, audited on 12 November 2026.

/** Every table of the schema. */
const TABLES = Object.values<unknown>(schema).filter((value): value is SQLiteTable =>
	is(value, SQLiteTable),
);

it("the privacy notice says what every table holds: each is in one row of the list beside the schema, and the notice shows every row", async () => {
	const listed = STORED.flatMap(({ rows }) => rows.flatMap(({ tables }) => [...tables]));
	const names = TABLES.map((table) => getTableConfig(table).name);

	expect(new Set(listed).size, "a table is in two rows").toBe(listed.length);
	expect([...listed].sort()).toEqual([...names].sort());

	const html = await page(PRIVACY_PATH);
	for (const { heading, rows } of STORED) {
		expect(html, heading).toContain(`>${heading}</h3>`);
		for (const { term } of rows)
			expect(html, term).toContain(`<dt class="text-title-medium wrap-anywhere">${term}</dt>`);
	}
});

it("deleting an organisation deletes everything in it, as the notice says: every table with an organisation cascades from it", async () => {
	const organisations = TABLES.filter((table) => "organisationId" in getTableColumns(table));
	expect(organisations.length).toBeGreaterThan(40);
	for (const table of organisations) {
		const { name, foreignKeys } = getTableConfig(table);
		const toOrganisation = foreignKeys.filter(
			(key) => getTableConfig(key.reference().foreignTable).name === "organisations",
		);
		expect(
			toOrganisation.map((key) => key.onDelete),
			name,
		).toContain("cascade");
	}
	expect(words(await page(PRIVACY_PATH))).toContain(
		"Everything in it goes at once: its memberships, invitations and all its work, and first its receipts.",
	);
});

it("the notice says activity records are deleted after the retention the daily job applies", async () => {
	await freshDatabase();
	const mailbox = captureEmail();
	const ada = await signIn(mailbox, "ada@example.com");
	const acme = await createOrganisation(ada.cookie, "Acme");
	const DAY = 24 * 60 * 60 * 1000;
	const now = Date.parse("2026-11-12T03:17:00Z");
	const record = (days: number) =>
		env.DB.prepare(
			"insert into activity_records (id, organisation_id, actor_id, source, action, subject_type, subject_id, summary, created_at) values (?, ?, null, 'system', 'project.created', 'project', ?, '{}', ?)",
		)
			.bind(uuidv7(), acme.id, String(days), now - days * DAY)
			.run();
	await record(ACTIVITY_RETENTION_DAYS - 1);
	await record(ACTIVITY_RETENTION_DAYS + 1);

	// The trigger is one wrangler.jsonc runs, and the Worker's own handler deletes on it.
	expect(wrangler).toContain(`"${DAILY}"`);
	const ctx = createExecutionContext();
	await worker.scheduled(createScheduledController({ scheduledTime: now, cron: DAILY }), env, ctx);
	await waitOnExecutionContext(ctx);
	const left = await env.DB.prepare(
		"select subject_id from activity_records where action = 'project.created'",
	).all<{
		subject_id: string;
	}>();
	expect(left.results.map((row) => row.subject_id)).toEqual([String(ACTIVITY_RETENTION_DAYS - 1)]);

	expect(words(await page(PRIVACY_PATH))).toContain(
		`Each record is deleted ${ACTIVITY_RETENTION_DAYS} days after it was made, by a job that runs every day.`,
	);
});

it("the notice names every email the application sends, and whom it goes to", async () => {
	// Only the words are read: a module that calls `sendEmail` sends an email.
	const sources = import.meta.glob<string>(
		["../app/**/*.ts", "../app/**/*.tsx", "../workers/**/*.ts"],
		{
			eager: true,
			query: "?raw",
			import: "default",
		},
	);
	const senders = Object.entries(sources)
		.filter(([path, text]) => path !== "../app/auth/email.server.ts" && /\bsendEmail\(/.test(text))
		.map(([path]) => path)
		.sort();
	// Each sender, with what the notice says of the messages it sends.
	const said: Record<string, string[]> = {
		"../app/auth/auth.server.ts": ["a sign-in code, to the address entered on the sign-in page"],
		"../app/auth/organisations.server.ts": [
			"an invitation, to the address an owner or admin invites",
		],
		"../app/budgets/budget.server.ts": [
			"a budget alert, to the organisation's owners and admins and, for a budget in hours, to the managers",
		],
		"../app/integrations/webhooks.server.ts": [
			"a notice that a webhook was switched off, to the person who added it",
		],
		"../app/invoices/mail.server.ts": [
			"an invoice or an estimate, as a PDF, to the billing contacts of a client",
			"a reminder of an overdue invoice, with its PDF, to the client's billing contacts",
		],
	};
	expect(senders).toEqual(Object.keys(said).sort());

	const text = words(await page(PRIVACY_PATH));
	for (const sentence of Object.values(said).flat()) expect(text).toContain(sentence);
	expect(text).toContain(`at most ${DOCUMENT_EMAILS.max} invoice and estimate emails in 24 hours`);
	expect(words(await page(TERMS_PATH))).toContain(
		`An organisation can send at most ${DOCUMENT_EMAILS.max} in 24 hours.`,
	);
});

it("the notice says what a webhook is sent and when it stops, and how far a calendar feed reaches, as the code does", async () => {
	const text = words(await page(PRIVACY_PATH));
	for (const label of Object.values(EVENT_LABELS)) expect(text).toContain(label.toLowerCase());
	expect(text).toContain(`after ${SWITCH_OFF_AFTER} failures in a row the webhook is switched off`);
	expect(text).toContain(`from the last ${LEAVE_DAYS_BACK} days on`);
	expect(text).toContain(`of the last ${ENTRY_DAYS_BACK} days`);
});

it("the pages say receipts are kept in the EU because their bucket has the EU jurisdiction", async () => {
	const buckets = [...(wrangler ?? "").matchAll(/\{ "binding": "RECEIPTS",[^}]*\}/g)].map(
		([b]) => b,
	);
	expect(buckets.length).toBeGreaterThan(0);
	for (const bucket of buckets) expect(bucket).toContain('"jurisdiction": "eu"');
	expect(words(await page(PRIVACY_PATH))).toContain("in a bucket restricted to the EU");
	expect(words(await page("/"))).toContain("Receipts are kept in storage restricted to the EU.");
});

it("Who sees what names every role, and says of each what access.ts lets it do", async () => {
	// Each role, by the row of the notice that speaks for it.
	const rows: Record<Role, string> = {
		owner: "Owners and admins",
		admin: "Owners and admins",
		finance: "Finance",
		member: "Members",
	};
	expect(Object.keys(rows).sort()).toEqual([...Role.options].sort());
	const html = await page(PRIVACY_PATH);
	for (const term of [...Object.values(rows), "Managers", "Contractors"]) {
		expect(html, term).toContain(`<dt class="text-title-medium wrap-anywhere">${term}</dt>`);
	}

	const me = "me";
	const colleague = "colleague";
	const as = (role: Role, managed: string[] = []): Access => ({
		userId: me,
		role,
		managed: new Set(managed),
	});

	// Owners, admins and Finance see everyone's time, expenses and money.
	for (const role of ["owner", "admin", "finance"] as const) {
		expect(maySeeTimeOf(as(role), colleague), role).toBe(true);
		expect(maySeeExpensesOf(as(role), colleague), role).toBe(true);
		expect(maySeeRates(role) && mayInvoice(role), role).toBe(true);
	}
	// Owners and admins see the kind of leave and decide; Finance neither, unless it manages.
	for (const role of ["owner", "admin"] as const) {
		expect(maySeeLeaveKindOf(as(role), colleague), role).toBe(true);
		expect(
			mayDecidePeriodOf(as(role), colleague) && mayDecideLeaveOf(as(role), colleague),
			role,
		).toBe(true);
		expect(mayManageIntegrations(role), role).toBe(true);
	}
	expect(maySeeLeaveKindOf(as("finance"), colleague)).toBe(false);
	expect(
		mayDecidePeriodOf(as("finance"), colleague) || mayDecideLeaveOf(as("finance"), colleague),
	).toBe(false);
	expect(mayManageIntegrations("finance")).toBe(false);
	expect(maySeeLeaveKindOf(as("finance", [colleague]), colleague)).toBe(true);

	// A manager, of any role, sees and decides for the people of their teams, never for themselves, and no money.
	const manager = as("member", [colleague]);
	expect(maySeeTimeOf(manager, colleague) && maySeeExpensesOf(manager, colleague)).toBe(true);
	expect(maySeeLeaveKindOf(manager, colleague)).toBe(true);
	expect(mayDecidePeriodOf(manager, colleague) && mayDecideLeaveOf(manager, colleague)).toBe(true);
	expect(mayDecidePeriodOf(manager, me) || mayDecideLeaveOf(manager, me)).toBe(false);
	expect(maySeeTimeOf(manager, "stranger")).toBe(false);
	expect(maySeeRates(manager.role)).toBe(false);

	// A member sees their own and not a colleague's, nor the kind of their leave.
	const member = as("member");
	expect(maySeeTimeOf(member, me) && !maySeeTimeOf(member, colleague)).toBe(true);
	expect(maySeeLeaveKindOf(member, colleague)).toBe(false);
	expect(mayManageIntegrations("member")).toBe(false);

	// Nobody changes another person's time or expenses.
	for (const role of Role.options) {
		expect(mayChangeTimeOf(as(role, [colleague]), colleague), role).toBe(false);
		expect(mayChangeExpensesOf(as(role, [colleague]), colleague), role).toBe(false);
	}

	const text = words(html);
	expect(text).toContain("Nobody changes another person's time entries or expenses");
	expect(text).toContain(
		"That a colleague is on leave, but not which kind, unless Finance manages their team",
	);
	expect(text).toContain("never their own. A manager sees no rate, invoice or estimate.");
	expect(text).toContain("An owner or admin can give Timesifier an address");
	expect(text).toContain("An owner or admin can make a token");
	expect(words(await page("/"))).toContain(
		"owners, admins and Finance see everyone's time; a manager sees their own and their teams'; everyone else sees their own.",
	);
});

it("the home page and the terms say what is built in the present tense", async () => {
	const home = words(await page("/"));
	for (const phrase of [" will ", "being built", "In development", "Soon "]) {
		expect(home, phrase).not.toContain(phrase);
	}
	const terms = words(await page(TERMS_PATH));
	expect(terms).not.toContain("being built");
	expect(terms).toContain("Timesifier is a web application that keeps track of time");
});
