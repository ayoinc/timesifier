import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { routes as builtRoutes } from "virtual:react-router/server-build";
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it, vi } from "vitest";
import { ActivitySource } from "~/activity/actions";
import { ACTIVITY_RETENTION_DAYS } from "~/activity/activity.server";
import { signInCodeEmail } from "~/auth/sign-in-code-email";
import { builtInPlatformBrand } from "~/brand/platform-brand.server";
import {
	BROWSER_ERROR_FIELD_WORDS,
	BROWSER_ERROR_FIELDS,
	browserErrorNotice,
	CSP_REPORT_FIELD_WORDS,
	CSP_REPORT_FIELDS,
} from "~/browser-errors/report";
import { BrowserErrorReportSchema } from "~/browser-errors/report.server";
import { mayCreateProject } from "~/clients/managers.server";
import { STORED } from "~/db/personal-data";
import * as schema from "~/db/schema";
import { uuidv7 } from "~/db/uuidv7";
import { MILEAGE_RATE_CURRENCY, USUAL_CATEGORIES } from "~/expenses/starter";
import { EXPORT_KEEP_DAYS } from "~/exports/paths";
import { IMPORT_MAX_ROWS } from "~/import/import.server";
import { API_RATE_LIMIT } from "~/integrations/api-tokens.server";
import { ENTRY_DAYS_BACK, LEAVE_DAYS_BACK } from "~/integrations/feeds.server";
import { OPENAPI_PATH } from "~/integrations/paths";
import { API_SCOPES, EVENT_LABELS, SCOPE_LABELS } from "~/integrations/scopes";
import { BACKOFF_MINUTES, SWITCH_OFF_AFTER } from "~/integrations/webhooks.server";
import { DOCUMENT_EMAILS } from "~/invoices/mail.server";
import { XERO_COLUMNS } from "~/invoices/xero";
import { CAPABILITIES, inWords } from "~/landing/capabilities";
import { parseMarkdown } from "~/landing/markdown";
import { deploymentOperator } from "~/landing/operator";
import { PHOTOS } from "~/landing/photos";
import {
	ACCESSIBILITY_PATH,
	API_DOCS_PATH,
	CONTACT_PATH,
	DPA_PATH,
	FEATURES_PATH,
	HELLO_EMAIL,
	INTEGRATIONS_PATH,
	OUTSIDE_LINKS,
	PRICING_PATH,
	PRIMARY_ACTION,
	PRIVACY_EMAIL,
	PRIVACY_PATH,
	PUBLIC_FILES,
	PUBLIC_PAGES,
	SECURITY_EMAIL,
	SECURITY_PATH,
	TERMS_PATH,
} from "~/landing/Site";
import { homeStructuredData } from "~/landing/structured-data";
import {
	BREACH_NOTICE_HOURS,
	R2_HOLDS,
	SUB_PROCESSOR_NOTICE_DAYS,
	SUB_PROCESSORS,
	TIME_TRAVEL_DAYS,
	WORKERS_LOGS_DAYS,
} from "~/landing/trust";
import { DEFAULT_KINDS, KIND_KEYS } from "~/leave/kinds";
import { LOCK_LABELS } from "~/locks/locks";
import { NOTIFICATION_RETENTION_DAYS } from "~/notifications/kinds";
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
import { NOTICE_DAYS, PLAN_DETAILS, PLANS, PRICE_CURRENCY, PRICES, pounds } from "~/plans/plans";
import { DAILY_MAIL_CAP, MAIL_BATCH, SIGN_IN_DAYS, SUPPORT_HOURS } from "~/platform/limits";
import { REPORT_VIEWS } from "~/reports/views";
import { SIGN_IN_PATH } from "~/routes/auth/paths";
import { COLOR_SCHEME_COOKIE } from "~/shell/color-scheme.server";
import { destination, destinations } from "~/shell/destinations";
import { GETTING_STARTED_COOKIE } from "~/timesheet/getting-started.server";
// The pipeline, read as text: a directory whose name starts with a dot is not globbed.
import ci from "../.github/workflows/ci.yml?raw";
import worker from "../workers/app";
import { DAILY, HOURLY } from "../workers/scheduled";

import {
	CODE_COOKIE,
	captureEmail,
	KNOWN_COOKIE,
	ORIGIN,
	SESSION_COOKIE,
	setBinding,
	signIn,
} from "./auth/harness";
import {
	askProvider,
	configureProviders,
	googleClaims,
	microsoftClaims,
	STATE_COOKIE,
	signInWith,
} from "./auth/social-harness";
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
	STATE_COOKIE,
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

it("signing in with Google or Microsoft sets no cookie the notice does not list", async () => {
	await freshDatabase();
	configureProviders("google", "microsoft");
	const named = (response: Response) =>
		response.headers.getSetCookie().map((line) => line.slice(0, line.indexOf("=")));
	const set = new Set<string>();
	for (const provider of ["google", "microsoft"] as const) {
		for (const name of named(await askProvider(provider))) set.add(name);
		const claims =
			provider === "google" ? googleClaims("ada@acme.com") : microsoftClaims("ada@acme.com");
		const { response } = await signInWith(provider, claims);
		for (const name of named(response)) set.add(name);
	}
	expect(set).toContain(STATE_COOKIE);
	for (const name of set) expect(COOKIES, name).toContain(name);
	vi.restoreAllMocks();
});

it("the notice names Google and Microsoft under who else handles it only where this deployment offers them", async () => {
	const none = words(await page(PRIVACY_PATH));
	expect(none).not.toContain("Signing in with Google");
	expect(none).not.toContain("Signing in with Microsoft");

	configureProviders("microsoft");
	const microsoft = words(await page(PRIVACY_PATH));
	expect(microsoft).toContain(
		"If you choose Sign in with Microsoft, with a work or school account, Microsoft learns that you are signing in to Timesifier",
	);
	expect(microsoft).not.toContain("Signing in with Google");

	configureProviders("google");
	const both = words(await page(PRIVACY_PATH));
	expect(both).toContain(
		"If you choose Sign in with Google, Google learns that you are signing in to Timesifier",
	);
	expect(both).toContain("Timesifier asks for nothing else and keeps no token from Google.");
});

it("the notice says no token from Google or Microsoft is kept, as the account hooks make sure", async () => {
	const text = words(await page(PRIVACY_PATH));
	expect(text).toContain(
		"No token from either is kept, so Timesifier cannot act for you at Google or Microsoft.",
	);
	// The columns that would hold one are emptied on every write (test/auth/social.test.ts).
	await freshDatabase();
	configureProviders("microsoft");
	await signInWith("microsoft", microsoftClaims("ada@acme.com"));
	vi.restoreAllMocks();
	const account = await env.DB.prepare(
		"select provider_id, access_token, refresh_token, id_token from accounts where provider_id = 'microsoft'",
	).first();
	expect(account).toEqual({
		provider_id: "microsoft",
		access_token: null,
		refresh_token: null,
		id_token: null,
	});
});

/** The pages that say where the data is kept and handled: each says it the same way. */
const LOCATED = ["/", PRIVACY_PATH, SECURITY_PATH, DPA_PATH];

it("the pages say the database is in the EU because that is how the databases are created", async () => {
	// A D1 database's jurisdiction is fixed when it is created and is in no
	// configuration file: the README's commands are where the repository keeps it.
	expect(readme).toBeDefined();
	const created = (readme ?? "").split("\n").filter((line) => line.includes("wrangler d1 create"));
	expect(created.length).toBeGreaterThan(0);
	for (const command of created) expect(command).toContain("--jurisdiction eu");
	// So is an R2 bucket's: the receipts' and the logos' (TS-070, TS-100), each
	// named as `wrangler.jsonc` binds it.
	const buckets = (readme ?? "")
		.split("\n")
		.filter((line) => line.includes("wrangler r2 bucket create"));
	expect(buckets.map((line) => line.match(/bucket create (\S+)/)?.[1])).toEqual([
		"timesifier-receipts",
		"timesifier-receipts-preview",
		"timesifier-brand",
		"timesifier-brand-preview",
	]);
	for (const command of buckets) expect(command).toContain("--jurisdiction eu");

	for (const path of LOCATED) {
		expect(words(await page(path)), path).toContain("runs and stores its data only inside the EU");
	}
});

it("wherever a page says the database is in the EU, it says what is not", async () => {
	for (const path of LOCATED) {
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
	for (const path of LOCATED) {
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
		"Everything in it goes at once: its memberships, invitations and all its work, and first its receipts, its logo and its exports of everything.",
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
	const security = words(await page(SECURITY_PATH));
	expect(security).toContain(
		`the only deletion is the daily job's: each record is deleted ${ACTIVITY_RETENTION_DAYS} days after it was made.`,
	);
	expect(security).toContain(
		`The activity log Each record is deleted ${ACTIVITY_RETENTION_DAYS} days after it was made.`,
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
		"../app/notifications/mail.server.ts": [
			"a notification, to the person it is for, unless they turned that kind's email off on My account",
			"a timesheet or a request waiting for their decision, their own timesheet or request decided",
			"a budget alert, to the organisation's owners and admins and, for a budget in hours, to the managers",
			"a notice that an export of everything is ready, or could not be made, to the owner who asked for it; each with a link that turns its kind off",
		],
		"../app/integrations/webhooks.server.ts": [
			"a notice that a webhook was switched off, to the person who added it",
		],
		"../app/organisations/domains.server.ts": [
			"a notice that a verified domain's DNS record is missing, to the organisation's owners, once each time it has been missing for 7 days; after 14 days the domain stops being verified",
		],
		"../app/invoices/mail.server.ts": [
			"an invoice or an estimate, as a PDF, to the billing contacts of a client",
			"a reminder of an overdue invoice, with its PDF, to the client's billing contacts",
		],
		"../app/onboarding/onboarding.server.ts": [
			`an invitation sent with others, from Invite many or a CSV import of people, to each address an owner or admin invites, with the same content, at most ${MAIL_BATCH} a minute`,
		],
		"../app/platform/brand.server.ts": [
			"a test of Timesifier's brand, to the platform owner who asked for it",
		],
		"../app/platform/mail.server.ts": [
			"a product announcement, to every account that has not turned them off, and the newsletter, to those who asked for it",
		],
		"../app/platform/step-up.server.ts": [
			"a code that opens the platform console, to the platform owner who asked for it",
		],
		"../app/routes/platform/account.tsx": [
			"a link to download your data, when you ask Timesifier for it",
			"an invitation sent again by a platform owner, at your request",
		],
	};
	expect(senders).toEqual(Object.keys(said).sort());

	const text = words(await page(PRIVACY_PATH));
	for (const sentence of Object.values(said).flat()) expect(text).toContain(sentence);
	expect(text).toContain(`at most ${DOCUMENT_EMAILS.max} invoice and estimate emails in 24 hours`);
	expect(text).toContain(
		`Invitations sent with others share one cap with product announcements and the newsletter: at most ${DAILY_MAIL_CAP} of them a day`,
	);
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

it("the pages say receipts, logos and exports are kept in the EU because their buckets have the EU jurisdiction", async () => {
	const buckets = [...(wrangler ?? "").matchAll(/\{ "binding": "(?:RECEIPTS|BRAND)",[^}]*\}/g)].map(
		([b]) => b,
	);
	expect(buckets.length).toBe(4);
	for (const bucket of buckets) expect(bucket).toContain('"jurisdiction": "eu"');
	// The exports of everything (TS-126) are in the receipts' bucket.
	expect(source("../app/exports/job.server.ts")).toContain(
		"env.RECEIPTS.createMultipartUpload(exportKey(",
	);
	for (const path of [PRIVACY_PATH, SECURITY_PATH, DPA_PATH]) {
		expect(words(await page(path)), path).toContain(
			`Cloudflare R2 holds the ${R2_HOLDS}, in buckets restricted to the EU`,
		);
	}
	expect(words(await page(PRIVACY_PATH))).toContain(`Cloudflare R2 holds the ${R2_HOLDS}.`);
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
	// The notice and the security page say it in the same words (app/landing/WhoSees.tsx).
	const pages = [PRIVACY_PATH, SECURITY_PATH];
	for (const path of pages) {
		const html = await page(path);
		for (const term of [...Object.values(rows), "Managers", "Account managers", "Contractors"]) {
			expect(html, `${path}: ${term}`).toContain(
				`<dt class="text-title-medium wrap-anywhere">${term}</dt>`,
			);
		}
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

	// An account manager creates that client's projects and no other's (decision 42).
	expect(mayCreateProject("member", ["globex"], "globex")).toBe(true);
	expect(mayCreateProject("member", ["globex"], "initech")).toBe(false);
	expect(mayCreateProject("finance", [], "globex")).toBe(false);

	for (const path of pages) {
		const text = words(await page(path));
		expect(text, path).toContain("Nobody changes another person's time entries or expenses");
		expect(text, path).toContain(
			"That a colleague is on leave, but not which kind, unless Finance manages their team",
		);
		expect(text, path).toContain("never their own. A manager sees no rate, invoice or estimate.");
		expect(text, path).toContain(`grants support access, for ${SUPPORT_HOURS.join(" or ")} hours`);
		expect(text, path).toContain(
			"names as a client's account manager creates that client's projects",
		);
	}
	const notice = words(await page(PRIVACY_PATH));
	expect(notice).toContain("An owner or admin can give Timesifier an address");
	expect(notice).toContain("An owner or admin can make a token");
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

/** What the privacy notice says of the email with a code (TS-100). */
const CODE_EMAIL =
	"Nothing is fetched when an email is opened, and nothing tells Timesifier it was. The email with a code holds no link.";

it("the privacy notice says the email with a code fetches nothing, and it does not", async () => {
	expect(words(await page(PRIVACY_PATH))).toContain(CODE_EMAIL);

	// The platform's brand as migration 0020 starts it (test/brand/platform-brand.test.ts).
	const message = signInCodeEmail("40817263", builtInPlatformBrand());
	for (const body of [message.text, message.html]) {
		expect(body).not.toMatch(/https?:|<a\b|href=|srcset=|url\(|<link|<script/i);
	}
	// One image, the logo, and it is the one file attached, inline, by its Content-ID.
	const sources = [...message.html.matchAll(/\ssrc="([^"]*)"/g)].map(([, src]) => src);
	expect(sources).toEqual(["cid:timesifier-logo"]);
	expect(
		message.attachments?.map(({ disposition, contentId }) => ({ disposition, contentId })),
	).toEqual([{ disposition: "inline", contentId: "timesifier-logo" }]);
});

// What search engines read (TS-103): the sitemap, each page's canonical address
// and description, and the structured data. They are claims like any other.

/** The pages the sitemap lists, in its order. */
async function sitemap(): Promise<string[]> {
	const response = await exports.default.fetch(`${ORIGIN}/sitemap.xml`);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
	return [...(await response.text()).matchAll(/<loc>([^<]*)<\/loc>/g)].map(([, loc]) => loc);
}

/** A tag's attribute, read from the tag's markup. */
const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

it("the sitemap lists exactly the public pages, which link to one another and nowhere else", async () => {
	const listed = await sitemap();
	expect(listed).toEqual(PUBLIC_PAGES.map((path) => `${ORIGIN}${path}`));

	// Every page the home page leads to, through every link on every page reached.
	// A link to another site is allowed only to an address in OUTSIDE_LINKS, and is not followed.
	// A file a page offers for download (`PUBLIC_FILES`) is not a page: it is
	// answered, and not followed.
	const outside = new Set<string>(Object.values(OUTSIDE_LINKS).map(({ href }) => href));
	const reached = new Set<string>();
	const files = new Set<string>();
	const outsideReached = new Set<string>();
	const queue = [`${ORIGIN}/`];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		if (reached.has(next)) continue;
		reached.add(next);
		const html = await page(new URL(next).pathname);
		for (const [tag] of html.matchAll(/<a\b[^>]*>/g)) {
			const href = attribute(tag, "href") ?? "";
			if (href.startsWith("mailto:")) continue;
			const url = new URL(href, next);
			if (url.origin !== ORIGIN) {
				// Another site: one of the named few, by its whole address.
				expect(outside.has(url.href), `${next}: ${href} is not in OUTSIDE_LINKS`).toBe(true);
				outsideReached.add(url.href);
				continue;
			}
			// Of our own pages, only the public ones and the files they offer: not the application.
			if ((PUBLIC_FILES as readonly string[]).includes(url.pathname)) files.add(url.pathname);
			else queue.push(`${url.origin}${url.pathname}`);
		}
	}
	expect([...reached].sort()).toEqual([...listed].sort());
	expect([...files].sort()).toEqual([...PUBLIC_FILES].sort());
	for (const file of files) {
		expect((await exports.default.fetch(`${ORIGIN}${file}`)).status, file).toBe(200);
	}
	// Every outside link that is allowed is used: none is left in the list for later.
	expect([...outsideReached].sort()).toEqual([...outside].sort());

	// And every page that describes itself to search engines is one of them.
	const routes = import.meta.glob<string>("../app/routes/**/*.tsx", {
		eager: true,
		query: "?raw",
		import: "default",
	});
	const described = Object.values(routes).filter((source) => /\bpageMeta\(/.test(source));
	expect(described).toHaveLength(listed.length);

	const robots = await exports.default.fetch(`${ORIGIN}/robots.txt`);
	expect(robots.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
	expect((await robots.text()).split("\n")).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
});

it("each public page names itself as its canonical address, and describes itself in its own words", async () => {
	const descriptions = new Set<string>();
	for (const url of await sitemap()) {
		const path = new URL(url).pathname;
		const html = await page(`${path}?from=elsewhere`);
		const canonical = [...html.matchAll(/<link\b[^>]*\srel="canonical"[^>]*>/g)];
		expect(
			canonical.map(([tag]) => attribute(tag, "href")),
			path,
		).toEqual([url]);
		expect(html, path).toContain(`<meta property="og:url" content="${url}"/>`);

		const description = html.match(/<meta name="description" content="([^"]*)"\/>/)?.[1] ?? "";
		expect(description.length, path).toBeGreaterThan(50);
		descriptions.add(description);
	}
	expect(descriptions.size).toBe(PUBLIC_PAGES.length);
});

it("the structured data parses, and says no more than who and what Timesifier is", async () => {
	const blocks = (html: string) =>
		[...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(
			([, json]) => json,
		);
	for (const path of PUBLIC_PAGES.filter((path) => path !== "/")) {
		expect(blocks(await page(path)), path).toEqual([]);
	}

	const html = await page("/");
	const [json, ...more] = blocks(html);
	expect(more).toEqual([]);
	const data = JSON.parse(json ?? "");
	expect(data["@context"]).toBe("https://schema.org");
	const byType = Object.fromEntries(
		(data["@graph"] as { "@type": string }[]).map((node) => [node["@type"], node]),
	);
	expect(Object.keys(byType).sort()).toEqual(["Organization", "SoftwareApplication"]);

	// The brand, its address and its mark, with the registered name and number of
	// the company that runs it, from the same settings as the foot of the page.
	const { logo, ...organisation } = byType.Organization as Record<string, unknown>;
	expect(organisation).toEqual({
		"@type": "Organization",
		name: "Timesifier",
		url: `${ORIGIN}/`,
		legalName: env.OPERATOR_NAME,
		identifier: {
			"@type": "PropertyValue",
			propertyID: "Company number",
			value: env.OPERATOR_COMPANY_NUMBER,
		},
	});
	// Where no company is named, the brand alone.
	const [brandOnly] = homeStructuredData(ORIGIN, "")["@graph"];
	expect(brandOnly).toEqual({
		"@type": "Organization",
		name: "Timesifier",
		url: `${ORIGIN}/`,
		logo: `${ORIGIN}/icon-512.png`,
	});
	const logoUrl = new URL(String(logo));
	expect(logoUrl.origin).toBe(ORIGIN);
	const files = import.meta.glob("../public/*.png");
	expect(Object.keys(files)).toContain(`../public${logoUrl.pathname}`);

	// The application, in the words of the page's own description.
	const description = html.match(/<meta name="description" content="([^"]*)"\/>/)?.[1];
	expect(byType.SoftwareApplication).toEqual({
		"@type": "SoftwareApplication",
		name: "Timesifier",
		url: `${ORIGIN}/`,
		description,
		applicationCategory: "BusinessApplication",
		operatingSystem: "Web",
	});
	// No price and no rating, under any name: Timesifier has neither to state.
	const keys: string[] = [];
	JSON.parse(json ?? "", (key, value) => {
		keys.push(key);
		return value;
	});
	expect(
		keys.filter((key) => /^(offers?|price\w*|aggregateRating|reviews?|award)$/.test(key)),
	).toEqual([]);
});

// The buyer pages (TS-106): what Timesifier does, what it costs, what it
// connects to, its API reference and how to reach the company. Each sentence
// that names a capability, a number or a price is held to the code it is about.

it("every capability on the features page is a destination of the application", async () => {
	const html = await page(FEATURES_PATH);
	const text = words(html);
	// Each destination is a route below an organisation (app/routes.ts makes one a destination).
	const organisationRoutes = Object.values(builtRoutes).filter(
		(route) => route?.parentId === "routes/app/organisation",
	);
	for (const capability of CAPABILITIES) {
		expect(html, capability.id).toContain(`id="${capability.id}"`);
		expect(text, capability.id).toContain(capability.title);
		expect(capability.places.length, capability.id).toBeGreaterThan(0);
		for (const place of capability.places) {
			const { label, segment } = destination(place);
			expect(destinations.map(({ id }) => id)).toContain(place);
			expect(
				organisationRoutes.some((route) =>
					segment === "" ? route?.index === true : route?.path === segment,
				),
				`${capability.id}: ${place}`,
			).toBe(true);
			expect(text, capability.id).toContain(label);
		}
		for (const point of capability.points) expect(text, capability.id).toContain(point);
	}
});

it("the features page counts and lists what the application holds", async () => {
	const text = words(await page(FEATURES_PATH));
	// The leave an organisation starts with, the expense categories, the roles and the reports.
	expect(text).toContain(
		`starts with ${KIND_KEYS.length} kinds of leave: ${inWords(KIND_KEYS.map((key) => DEFAULT_KINDS[key].name))}.`,
	);
	expect(text).toContain(`starts with ${USUAL_CATEGORIES.length} categories: Travel,`);
	expect(text).toContain(`${Role.options.length} roles: Owner, Admin, Finance and Member.`);
	expect(Role.options).toEqual(["owner", "admin", "finance", "member"]);
	for (const { id, label } of REPORT_VIEWS) {
		if (id !== "saved") expect(text).toContain(label.toLowerCase());
	}
	// What locks an entry, as the locks name it.
	expect(text).toContain(
		"while it is submitted, approved and invoiced, or before the organisation's lock date",
	);
	expect(Object.keys(LOCK_LABELS).sort()).toEqual([
		"approved",
		"invoiced",
		"locked-through",
		"submitted",
	]);
	// The API's scopes and the webhooks' events.
	expect(text).toContain(`${API_SCOPES.length} scopes`);
	expect(text).toContain(inWords(Object.values(EVENT_LABELS).map((label) => label.toLowerCase())));
	// Mileage at HMRC's rate, in pounds.
	expect(MILEAGE_RATE_CURRENCY).toBe("GBP");
	expect(text).toContain("at HMRC's approved rate for an organisation that works in pounds");
	// The activity log keeps where each change came from.
	expect(ActivitySource.options).toEqual(expect.arrayContaining(["web", "api", "import"]));
});

it("the pricing page's seats are the plans' seats, and its prices the plans' prices", async () => {
	const text = words(await page(PRICING_PATH));
	for (const plan of PLANS) {
		const { label, seats } = PLAN_DETAILS[plan];
		const { monthly, billedYearly } = PRICES[plan];
		expect(text, plan).toContain(`${label} Up to ${seats} people ${pounds(monthly)}`);
		if (monthly > 0) expect(text, plan).toContain(`or ${pounds(billedYearly)} billed yearly`);
	}
	// The owner's answer 9: £0, £6 or £5, £10 or £8, in pounds, before VAT.
	expect(PRICES).toEqual({
		free: { monthly: 0, billedYearly: 0 },
		team: { monthly: 600, billedYearly: 500 },
		business: { monthly: 1000, billedYearly: 800 },
	});
	expect(PRICE_CURRENCY).toBe("GBP");
	expect(text).toContain("Prices are in pounds sterling and exclude VAT.");
	expect(text).toContain(`told at least ${NOTICE_DAYS} days before its first charge`);
	// A person, as a seat counts them (app/plans/plans.ts).
	expect(text).toContain("its members, and the people invited who have not yet joined");
	// No badge and no discount theatre.
	expect(text).not.toMatch(/popular|recommended|best value|save \d|% off/i);
});

it("each line on the pricing page names a built capability, and what is not built says so", async () => {
	const html = await page(PRICING_PATH);
	const features = await page(FEATURES_PATH);
	for (const { id, title } of CAPABILITIES) {
		expect(html).toContain(`href="${FEATURES_PATH}#${id}"`);
		expect(words(html)).toContain(title);
		expect(features).toContain(`id="${id}"`);
	}
	// SAML is not built: the page names it once, on request, under company sign-in.
	const text = words(html);
	const section = text.slice(text.indexOf("Company sign-in, available soon."));
	expect(section).toContain("On Business SAML single sign-on, on request");
	expect(text.indexOf("SAML")).toBe(text.indexOf("SAML single sign-on, on request"));
});

it("the pricing page's company sign-in is what this deployment offers, and available soon where it offers none", async () => {
	const SOON = "Company sign-in, available soon.";
	const OFFERED = "Company sign-in.";
	const EVERY_PLAN = "Require company sign-in for an organisation Verified email domains";
	const BUSINESS = "On Business SAML single sign-on, on request";

	// No provider configured, as in production until one is (decision 64).
	const none = words(await page(PRICING_PATH));
	expect(none).not.toContain(OFFERED);
	expect(none).not.toContain("being built");
	const soon = none.slice(none.indexOf(SOON));
	expect(soon).toContain("Today a person signs in with a code sent to their email address.");
	expect(soon).toContain(
		`On every plan Sign in with Google or with a Microsoft work or school account ${EVERY_PLAN} ${BUSINESS}`,
	);
	expect(none.indexOf("Google")).toBeGreaterThan(none.indexOf(SOON));

	// One provider: the section names it, and only it.
	configureProviders("microsoft");
	const microsoft = words(await page(PRICING_PATH));
	expect(microsoft).not.toContain(SOON);
	const offered = microsoft.slice(microsoft.indexOf(OFFERED));
	expect(offered).toContain("or with their company's account");
	expect(offered).toContain(
		`On every plan Sign in with a Microsoft work or school account ${EVERY_PLAN} ${BUSINESS}`,
	);
	expect(microsoft).not.toContain("Google");

	// Both.
	configureProviders("google");
	const both = words(await page(PRICING_PATH));
	expect(both).not.toContain(SOON);
	expect(both.slice(both.indexOf(OFFERED))).toContain(
		`On every plan Sign in with Google or with a Microsoft work or school account ${EVERY_PLAN} ${BUSINESS}`,
	);
});

it("the integrations page states the limits the code enforces", async () => {
	const text = words(await page(INTEGRATIONS_PATH));
	for (const label of Object.values(SCOPE_LABELS)) expect(text).toContain(label);
	expect(text).toContain(
		`A token may make ${API_RATE_LIMIT.max} requests in any ${API_RATE_LIMIT.seconds} seconds.`,
	);
	expect(BACKOFF_MINUTES.length + 1).toBe(7);
	expect(text).toContain(
		`tried seven times in all, over ${Math.round(BACKOFF_MINUTES.reduce((sum, minutes) => sum + minutes, 0) / 60)} hours`,
	);
	expect(SWITCH_OFF_AFTER).toBe(3);
	expect(text).toContain("After three failed deliveries in a row the webhook is switched off");
	expect(text).toContain(`their entries of the last ${ENTRY_DAYS_BACK} days`);
	expect(text).toContain(`up to ${IMPORT_MAX_ROWS.toLocaleString("en-GB")} rows at a time`);
	expect(text).toContain(`in Xero's ${XERO_COLUMNS.length} columns`);
	expect(text).toContain("There is no live connection to Xero.");
	// The API and webhooks are an owner's or an admin's to set up.
	for (const role of Role.options) {
		expect(mayManageIntegrations(role), role).toBe(role === "owner" || role === "admin");
	}
});

const apiReference = import.meta.glob<string>("../docs/api.md", {
	eager: true,
	query: "?raw",
	import: "default",
})["../docs/api.md"];

it("the published API reference is docs/api.md", async () => {
	const html = await page(API_DOCS_PATH);
	// The page's words with no spaces at all, its entities read: the marks of a
	// line put tags inside it, and a tag leaves a space where the file has none.
	const text = words(html)
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s/g, "");
	const blocks = parseMarkdown(apiReference ?? "");
	expect(blocks.length).toBeGreaterThan(20);
	/** A line of Markdown as the page reads it, its marks and spaces gone. */
	const plain = (line: string) =>
		line
			.replace(/\[(.+?)\]\([^)]+\)/g, "$1")
			.replace(/[`*]/g, "")
			.replace(/\s/g, "");
	for (const block of blocks) {
		if (block.kind === "heading") {
			if (block.level > 1) expect(html).toContain(`id="${block.id}"`);
			expect(text).toContain(plain(block.text));
		} else if (block.kind === "paragraph") {
			expect(text).toContain(plain(block.text));
		} else if (block.kind === "list") {
			for (const item of block.items) expect(text).toContain(plain(item));
		} else if (block.kind === "table") {
			for (const cell of [...block.head, ...block.rows.flat()]) expect(text).toContain(plain(cell));
		} else {
			// A block of code as React writes text into the markup.
			expect(html).toContain(
				block.text.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
			);
		}
	}
	// What the file keeps for the repository is not on the page.
	expect(apiReference).toContain("<!--");
	expect(text).not.toContain("TS-081");
	// Its link to the description leads to the one the application serves.
	expect(html).toContain(`href="${OPENAPI_PATH}"`);
});

it("the contact page gives the company's details and its addresses, with no form and no promised time", async () => {
	const html = await page(CONTACT_PATH);
	const text = words(html);
	for (const email of [HELLO_EMAIL, PRIVACY_EMAIL, SECURITY_EMAIL]) {
		expect(html).toContain(`href="mailto:${email}"`);
	}
	const { name, companyNumber, registeredIn, registeredOffice } = deploymentOperator(env);
	expect(text).toContain(
		`Timesifier is operated by ${name}, a company registered in ${registeredIn} with company number ${companyNumber}. Its registered office is ${registeredOffice}.`,
	);
	expect(html).not.toContain("<form");
	expect(text).not.toMatch(/within \d|working days?|hours? to (answer|reply)|respond/i);
});

// The trust pages (TS-105): /security and /accessibility. Each statement is read
// against the code, the configuration or the test that makes it so.

/** Files read as text, for what they say: nothing in them is run. */
const sources = import.meta.glob<string>(
	[
		"../BOARD.md",
		"../docs/security.md",
		"../playwright.config.ts",
		"../e2e/axe.ts",
		"../e2e/*-keyboard.spec.ts",
		"../e2e/landing.spec.ts",
		"../app/db/platform.ts",
		"../app/**/*.server.ts",
		"../workers/scheduled.ts",
		"../workers/security-headers.ts",
	],
	{ eager: true, query: "?raw", import: "default" },
);
const source = (path: string) => {
	const text = sources[path];
	expect(text, path).toBeDefined();
	return text ?? "";
};

/** One part of a page, by its id, as a person reads it. */
async function part(path: string, id: string): Promise<string> {
	const html = await page(path);
	const section = html.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`))?.[0];
	expect(section, `${path}#${id}`).toBeDefined();
	return words(section ?? "");
}

it("both pages state the restore window from one constant, and no restore is claimed until one is rehearsed", async () => {
	expect(TIME_TRAVEL_DAYS).toBe(30);
	for (const path of [PRIVACY_PATH, SECURITY_PATH]) {
		const text = words(await page(path));
		expect(text, path).toContain(`any minute of the last ${TIME_TRAVEL_DAYS} days`);
		// No other window is stated.
		expect(text.match(/any minute of the last \d+ days/g), path).toEqual([
			`any minute of the last ${TIME_TRAVEL_DAYS} days`,
		]);
	}
	// TS-022a rehearses the restore. Until its line is ticked, /security says none has been.
	const rehearsal = source("../BOARD.md")
		.split("\n")
		.find((line) => line.includes("Time Travel restore has been rehearsed"));
	expect(rehearsal).toBeDefined();
	const security = words(await page(SECURITY_PATH));
	if (rehearsal?.startsWith("- [ ]")) {
		expect(security).toContain("A restore has not been rehearsed yet.");
		expect(security).toContain("No restore of the database has been rehearsed.");
	}
	expect(security).not.toMatch(/restore (has been|was) (tested|rehearsed)/i);
});

it("the security page says how long each thing is kept from the constant that keeps it", async () => {
	// Sign-ins: the daily job deletes by SIGN_IN_DAYS, and both pages say it.
	expect(source("../app/db/platform.ts")).toContain("SIGN_IN_DAYS * DAY");
	expect(words(await page(PRIVACY_PATH))).toContain(
		`Each is deleted ${SIGN_IN_DAYS} days after it was made, by a job that runs every day.`,
	);
	const retention = await part(SECURITY_PATH, "retention");
	expect(retention).toContain(`Sign-ins Each is deleted ${SIGN_IN_DAYS} days after it was made.`);
	// Notifications (TS-049): the daily job deletes by NOTIFICATION_RETENTION_DAYS.
	expect(source("../app/notifications/bell.server.ts")).toContain("NOTIFICATION_RETENTION_DAYS *");
	expect(retention).toContain(
		`Notifications Each is deleted ${NOTIFICATION_RETENTION_DAYS} days after it was made, read or not.`,
	);
	// Logs and traces: kept by Cloudflare for WORKERS_LOGS_DAYS, and both are on.
	expect(wrangler).toMatch(/"logs": \{ "enabled": true/);
	expect(wrangler).toMatch(/"traces": \{ "enabled": true/);
	expect(retention).toContain(`Cloudflare's logs and traces At most ${WORKERS_LOGS_DAYS} days.`);
	expect(retention).toContain(`gone for good ${TIME_TRAVEL_DAYS} days later`);
	// Exports of everything (TS-126): each expires EXPORT_KEEP_DAYS after it is
	// made, and the hourly trigger deletes it.
	expect(R2_HOLDS).toContain(`each export for ${EXPORT_KEEP_DAYS} days`);
	expect(source("../app/exports/job.server.ts")).toContain(
		"expiresAt: new Date(now.getTime() + EXPORT_KEEP_DAYS * DAY_MS)",
	);
	expect(wrangler).toContain(`"${HOURLY}"`);
	expect(source("../workers/scheduled.ts").match(/cron === HOURLY\) \{[^}]*\}/)?.[0]).toContain(
		"deleteExpiredExports(",
	);
	expect(retention).toContain(
		`Exports of everything Each is deleted ${EXPORT_KEEP_DAYS} days after it is made, by a job that runs every hour.`,
	);
	const copies = `Timesifier keeps no other copy of the database, a receipt or a logo, besides the export of everything an owner asks for, which is deleted ${EXPORT_KEEP_DAYS} days after it is made.`;
	expect(words(await page(SECURITY_PATH))).toContain(copies);
	expect(words(await page(PRIVACY_PATH))).toContain(copies);
});

it("the security page's hashed secrets are the ones docs/security.md lists, and the code hashes them so", async () => {
	const code = Object.entries(sources)
		.filter(([path]) => path.startsWith("../app/"))
		.map(([, text]) => text)
		.join("\n");
	// Each is stored as `keyedHash` under its purpose, never as itself.
	for (const purpose of ["sign-in-code", "api-token", "calendar-feed", "webhook-secret-hash"]) {
		expect(code, purpose).toMatch(new RegExp(`keyedHash\\(.*"${purpose}"`));
	}
	const documented = source("../docs/security.md");
	expect(documented).toContain("It is stored as an HMAC-SHA-256 under `BETTER_AUTH_SECRET`");
	expect(documented).toContain(
		"the database holds a keyed hash of it under `BETTER_AUTH_SECRET` with the purpose `api-token`",
	);
	expect(documented).toContain(
		"the database keeps a keyed hash of it with the purpose `calendar-feed`",
	);
	expect(documented).toMatch(/A webhook's secret .*never stored/);

	const encryption = await part(SECURITY_PATH, "encryption");
	expect(encryption).toContain(
		"Sign-in codes, API tokens and calendar feed addresses are kept only as keyed hashes: HMAC-SHA-256",
	);
	expect(encryption).toContain("A webhook's signing secret is never stored");
	// HTTPS for two years: the header every answer carries (test/browser-policy.test.ts).
	expect(source("../workers/security-headers.ts")).toContain(
		`const STRICT_TRANSPORT_SECURITY = "max-age=${2 * 365 * 24 * 60 * 60}";`,
	);
	expect(encryption).toContain("to use nothing but HTTPS on this host for two years");
	expect(encryption).toContain("with AES-256");
});

it("the sub-processors on /security and /dpa are the ones the notice names, and every binding in wrangler.jsonc belongs to one of them", async () => {
	// Every part of the configuration that sends data to a provider is one sub-processor's.
	const NOT_DATA = new Set([
		"$schema",
		"name",
		"main",
		"compatibility_date",
		"compatibility_flags",
		"placement",
		"workers_dev",
		"vars",
		"preview_urls",
		"previews",
		"upload_source_maps",
		"secrets",
		"triggers",
	]);
	const keys = [...(wrangler ?? "").matchAll(/^\t"([$\w]+)":/gm)].map(([, key]) => key);
	const bindings = keys.filter((key) => !NOT_DATA.has(key));
	expect(bindings.sort()).toEqual([
		"d1_databases",
		"observability",
		"r2_buckets",
		"ratelimits",
		"send_email",
	]);
	const covered = new Set(SUB_PROCESSORS.flatMap(({ bindings }) => bindings));
	for (const binding of bindings) expect(covered, binding).toContain(binding);

	// /security and /dpa list exactly them, from the one constant, each with its agreement.
	for (const path of [SECURITY_PATH, DPA_PATH]) {
		const html = await page(path);
		const section = html.match(/<section id="sub-processors"[\s\S]*?<\/section>/)?.[0] ?? "";
		const terms = [...section.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map(([, term]) => term);
		expect(terms, path).toEqual(SUB_PROCESSORS.map(({ name }) => name));
		for (const each of SUB_PROCESSORS) {
			expect(section, `${path}: ${each.name}`).toContain(`href="${each.dpa.href}"`);
			if (each.list) expect(section, `${path}: ${each.name}`).toContain(`href="${each.list.href}"`);
			for (const what of each.receives) expect(words(section), `${path}: ${what}`).toContain(what);
		}
		const count = COUNT[SUB_PROCESSORS.length] ?? "";
		expect(words(section), path).toContain(
			`${count.charAt(0).toUpperCase()}${count.slice(1)} companies process personal data for Timesifier, and no others.`,
		);
	}
	// And the notice names each, under "Who else handles it", and the mailbox's addresses.
	const who = await part(PRIVACY_PATH, "who");
	for (const { name } of SUB_PROCESSORS) expect(who, name).toContain(name);
	expect(who).toContain(`${SECURITY_EMAIL} is received by Microsoft`);
});

it("the data processing agreement gives the owner's notice periods from their constants", async () => {
	// The owner's answer 2, 23 November 2026 (research/corporate/cards.md).
	expect(BREACH_NOTICE_HOURS).toBe(48);
	expect(SUB_PROCESSOR_NOTICE_DAYS).toBe(30);
	const processor = await part(DPA_PATH, "processor");
	expect(processor).toContain(
		`at the latest ${BREACH_NOTICE_HOURS} hours after it becomes aware of it`,
	);
	expect(processor).toContain(`at least ${SUB_PROCESSOR_NOTICE_DAYS} days before a new one starts`);
	expect(await part(DPA_PATH, "changes")).toContain(
		`A new sub-processor is told ${SUB_PROCESSOR_NOTICE_DAYS} days ahead`,
	);
	// No other figure is stated for either.
	const text = words(await page(DPA_PATH));
	expect(text.match(/\d+ hours after it becomes aware/g)).toEqual([
		`${BREACH_NOTICE_HOURS} hours after it becomes aware`,
	]);
	expect(text.match(/\d+ days (?:before a new one starts|ahead)/g)).toEqual([
		`${SUB_PROCESSOR_NOTICE_DAYS} days before a new one starts`,
		`${SUB_PROCESSOR_NOTICE_DAYS} days ahead`,
	]);
});

it("the security page says what is not done, and where to report a vulnerability", async () => {
	const notDone = await part(SECURITY_PATH, "not-done");
	for (const gap of [
		"No independent penetration test has been done.",
		"Timesifier holds no certification of its own, such as SOC 2 or ISO 27001.",
		"Cloudflare's logs are not restricted to the EU.",
		"there is no second factor yet",
	]) {
		expect(notDone).toContain(gap);
	}
	// Two-factor is still a gap in docs/security.md, so the page may not claim it.
	expect(source("../docs/security.md")).toContain("Optional two-factor is not built yet.");
	expect(await part(SECURITY_PATH, "reporting")).toContain(`Write to ${SECURITY_EMAIL}`);
});

it("the accessibility statement names the browsers and the standard the tests use", async () => {
	const text = words(await page(ACCESSIBILITY_PATH));

	// The rules axe is run with, and none turned off (e2e/axe.ts).
	const axe = source("../e2e/axe.ts");
	expect(axe).toContain(
		'const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];',
	);
	expect(axe).not.toContain("disableRules");
	expect(text).toContain("Web Content Accessibility Guidelines (WCAG) 2.2 at level AA");
	expect(text).toContain(
		"against its rules for WCAG 2.0, 2.1 and 2.2 at levels A and AA, with no rule turned off",
	);

	// The browsers are the projects' (playwright.config.ts): Chromium for every test,
	// WebKit again for the public pages and the components.
	const config = source("../playwright.config.ts");
	expect(config).toContain('devices["Desktop Chrome"]');
	expect(config).toMatch(
		/testMatch: IN_WEBKIT_TOO,\s*use: \{ \.\.\.devices\["Desktop Safari"\] \}/,
	);
	const webkit = config.match(/const IN_WEBKIT_TOO =\s*\/(.*)\/;/)?.[1] ?? "";
	for (const spec of ["landing", "documents", "components"]) expect(webkit, spec).toContain(spec);
	expect(text).toContain("The tests run in Chromium.");
	expect(text).toContain("The public pages and the components are tested again in WebKit");

	// The browser tests gate every deploy.
	expect(ci).toMatch(/deploy:[\s\S]*?needs: \[[^\]]*browser-tests/);
	expect(text).toContain("is deployed only when they pass");

	// The keyboard walks, and reduced motion.
	expect(source("../e2e/auth-keyboard.spec.ts")).toContain("with the keyboard alone");
	expect(source("../e2e/organisations-keyboard.spec.ts")).toContain(
		"the members and invitations: every control, the menu and every sheet, with the keyboard alone",
	);
	expect(text).toContain(
		"Keyboard tests sign in and out, and manage an organisation's members and invitations, with the keyboard alone",
	);
	expect(source("../e2e/landing.spec.ts")).toContain(
		'test.describe("with reduced motion asked for"',
	);

	// What is not done, whom to ask, and when it was last reviewed.
	expect(text).toContain("No audit by an independent auditor, and no testing by disabled people");
	expect(await page(ACCESSIBILITY_PATH)).toContain(`href="mailto:${SECURITY_EMAIL}"`);
	expect(text).toMatch(/It was last reviewed on \d{1,2} \w+ \d{4} ?\./);
});

// What a browser reports of an error in a page (TS-107d). The notice's
// sentence is drawn from the same lists of fields the endpoint reads with.
it("the notice names exactly the fields a browser error report carries", async () => {
	// The endpoint accepts exactly these fields (test/browser-errors.test.ts holds
	// what it keeps of a CSP report to CSP_REPORT_FIELDS).
	expect(Object.keys(BrowserErrorReportSchema.shape)).toEqual([...BROWSER_ERROR_FIELDS]);
	// The notice names each of them, and nothing else.
	expect(Object.keys(BROWSER_ERROR_FIELD_WORDS)).toEqual([...BROWSER_ERROR_FIELDS]);
	expect(Object.keys(CSP_REPORT_FIELD_WORDS)).toEqual([...CSP_REPORT_FIELDS]);
	const text = words(await page(PRIVACY_PATH));
	const sentence = browserErrorNotice(new URL(ORIGIN).host).replace(/’/g, "'");
	expect(text).toContain(sentence);
	for (const field of BROWSER_ERROR_FIELDS)
		expect(sentence).toContain(BROWSER_ERROR_FIELD_WORDS[field]);
	for (const field of CSP_REPORT_FIELDS) expect(sentence).toContain(CSP_REPORT_FIELD_WORDS[field]);
});
