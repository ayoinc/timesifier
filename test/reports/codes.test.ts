import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganisationScope, organisationScope } from "~/db";
import { createDraft, linesOf } from "~/invoices/invoices.server";
import { sourcesFor } from "~/invoices/sources.server";
import { uninvoicedOf } from "~/invoices/uninvoiced.server";
import { dayOf } from "~/time/calendar";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation } from "../organisations/harness";
import { open, type Person, pageBody, person, textOf } from "../pages/harness";
import { parseCsv } from "./csv";

// Codes in reports, exports and invoices (TS-115a): a project and a client are
// shown by code and name, code first ("ACME-001 · Site"); every CSV that names
// them has their codes in the column before; a line made from time names the
// project by its code; and an organisation of internal work reads its own word
// for projects on Reports, and nothing of clients.

const REPORTS = "/app/acme/reports";
const EXPORT = "/app/acme/reports/export";
/** Monday 5 to Sunday 11 October 2026: a week in the past, so the clock does not move it. */
const WEEK = "range=custom&from=2026-10-05&to=2026-10-11";
const NOW = Date.parse("2026-11-02T12:00:00Z");
const ORGANISATION = { timeZone: "UTC", currency: "GBP" };

let scope: OrganisationScope;
let acmeId: string;
let ada: Person;
let clientId: string;
let site: string;
let billing: string;

async function track(projectId: string, from: string, to: string) {
	await scope.timeEntries.insert({
		userId: ada.user.id,
		projectId,
		description: "Work",
		billable: true,
		startedAt: new Date(from),
		spentOn: dayOf(Date.parse(from), "UTC"),
		endedAt: new Date(to),
	});
}

beforeEach(async () => {
	await freshDatabase();
	ada = await person(captureEmail(), "ada@example.com");
	const acme = await createOrganisation(ada.cookie, "Acme");
	acmeId = acme.id;
	scope = organisationScope(env.DB, acme.id);
	const [initech] = await scope.clients.insert({
		name: "Initech",
		nameKey: "initech",
		code: "INI",
		codeKey: "ini",
	});
	if (!initech) throw new Error("seed failed");
	clientId = initech.id;
	const [p1, p2] = await scope.projects.insert([
		{ name: "Site", nameKey: "site", clientId, code: "ACME-001", codeKey: "acme-001" },
		{ name: "Billing", nameKey: "billing" },
	]);
	if (!p1 || !p2) throw new Error("seed failed");
	site = p1.id;
	billing = p2.id;
	await scope.rates.insert({
		kind: "billable",
		projectId: site,
		userId: null,
		taskId: null,
		amountMinor: 6000,
		currency: "GBP",
		effectiveFrom: "2026-01-01",
	});
	await track(site, "2026-10-05T09:00:00Z", "2026-10-05T10:00:00Z");
	await track(billing, "2026-10-06T09:00:00Z", "2026-10-06T11:00:00Z");
	// The first request to the Worker loads the whole application, which takes
	// longer than a hook is given by default.
}, 60_000);

/** The visible words of the page at `path`: its tags, scripts and data left out. */
async function pageText(path: string): Promise<string> {
	const response = await open(path, ada);
	expect(response.status).toBe(200);
	return textOf(await pageBody(response));
}

describe("a report", () => {
	it("groups by project and by client with each one's code first", async () => {
		expect(await pageText(`${REPORTS}?${WEEK}&group=project`)).toMatch(
			/By project .*ACME-001 · Site 1:00 .*Billing 2:00 .*Total 3:00/,
		);
		expect(await pageText(`${REPORTS}?${WEEK}&group=client`)).toMatch(
			/By client .*INI · Initech 1:00 .*No client 2:00 .*Total 3:00/,
		);
	});

	it("lists each entry with its project's and client's codes", async () => {
		expect(await pageText(`${REPORTS}?${WEEK}`)).toContain("ACME-001 · Site · INI · Initech");
	});

	it("draws a week's timetable by code and name", async () => {
		const text = await pageText(`${REPORTS}?range=week&from=2026-10-05&to=2026-10-11`);
		expect(text).toMatch(/Project .*ACME-001 · Site/);
	});
});

describe("the export", () => {
	it("has client_code and project_code just before the names, empty for none", async () => {
		const response = await open(`${EXPORT}?${WEEK}`, ada);
		expect(response.status).toBe(200);
		const [header, ...rows] = parseCsv((await response.text()).replace(/^\uFEFF/, ""));
		expect(header?.slice(2, 7)).toEqual([
			"project_code",
			"project",
			"work_package_code",
			"client_code",
			"client",
		]);
		expect(rows.map((cells) => cells.slice(2, 7))).toEqual([
			["ACME-001", "Site", "", "INI", "Initech"],
			["", "Billing", "", "", ""],
		]);
	});
});

describe("an invoice made from time", () => {
	it("names the project by its code on its line, as stored, and in the Uninvoiced view", async () => {
		const sources = await sourcesFor(
			scope,
			ORGANISATION,
			{ clientId, days: null, projectIds: [], grouping: "project", fixedMinor: new Map() },
			NOW,
		);
		const made = await createDraft(scope, ada.user.id, {
			clientId,
			currency: "GBP",
			issuedOn: "2026-11-02",
			lines: sources.lines,
		});
		if (!made.ok) throw new Error(made.problem);
		expect((await linesOf(scope, made.id)).map((line) => line.description)).toEqual([
			"ACME-001 · Site",
		]);
	});

	it("shows the client and project by code in the Uninvoiced view", async () => {
		const rows = await uninvoicedOf(scope, ORGANISATION, null, NOW);
		expect(rows.map((row) => [row.clientName, row.projectName])).toEqual([
			["INI · Initech", "ACME-001 · Site"],
		]);
	});
});

describe("under internal work", () => {
	beforeEach(async () => {
		await env.DB.prepare("update organisations set work_model = 'internal' where id = ?")
			.bind(acmeId)
			.run();
	});

	it.each([
		["the time report by project", `${REPORTS}?${WEEK}&group=project`],
		["the time report asked by client", `${REPORTS}?${WEEK}&group=client`],
		["the time report by day", `${REPORTS}?${WEEK}&group=day`],
		["a week's timetable", `${REPORTS}?range=week&from=2026-10-05&to=2026-10-11`],
		["Profitability", `${REPORTS}/profitability?${WEEK}`],
		["Expenses by project", `${REPORTS}/expenses?${WEEK}&group=project`],
	])("%s says the organisation's term, never project or client", async (_, path) => {
		const text = await pageText(path);
		expect(text).not.toMatch(/\bprojects?\b/i);
		expect(text).not.toMatch(/\bclients?\b/i);
	});

	it("groups by its term for projects, the codes first", async () => {
		expect(await pageText(`${REPORTS}?${WEEK}&group=project`)).toMatch(
			/By work code .*ACME-001 · Site 1:00 .*Billing 2:00/,
		);
	});
});
