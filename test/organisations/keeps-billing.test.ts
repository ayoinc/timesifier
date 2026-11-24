import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";

import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { open, type Person, pageBody, person } from "../pages/harness";
import { createOrganisation } from "./harness";

// Under Internal work the navigation keeps Invoices and Estimates while the
// organisation holds an invoice or an estimate (TS-115a, decision 67). Whether
// it holds one is two EXISTS in the statement the layout already makes for the
// organisation (`keepsBillingColumn`, app/db/billing.ts), so the check costs
// no statement of its own: a page reads the same statements whatever the
// organisation works as and whatever it holds, as request-memo.test.ts counts
// them.

/** The statements D1 is asked to prepare while `run` runs. */
async function statementsWhile(run: () => Promise<unknown>): Promise<string[]> {
	const prepare = vi.spyOn(env.DB, "prepare");
	try {
		await run();
		return prepare.mock.calls.map(([sql]) => String(sql));
	} finally {
		prepare.mockRestore();
	}
}

let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	ada = await person(captureEmail(), "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const setModel = (model: string) =>
	env.DB.prepare("update organisations set work_model = ? where id = ?").bind(model, acme.id).run();

async function holdInvoice() {
	const scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Globex", nameKey: "globex" });
	if (!client) throw new Error("seed failed");
	await scope.invoices.insert({
		number: "1",
		clientId: client.id,
		status: "draft",
		currency: "GBP",
		issuedOn: "2026-11-02",
		dueOn: "2026-12-02",
		subtotalMinor: 10_000,
		totalMinor: 10_000,
	});
}

/** The statements the owner's Timesheet reads, and whether its navigation links to Invoices. */
async function timesheet() {
	let html = "";
	const sql = await statementsWhile(async () => {
		const response = await open("/app/acme", ada);
		expect(response.status).toBe(200);
		html = await pageBody(response);
	});
	return { sql, invoices: html.includes('href="/app/acme/invoices"') };
}

describe("the navigation's check for invoices and estimates under Internal work", () => {
	it("adds no statement: under Internal work the Timesheet reads the same statements holding an invoice or not, and none that Client projects does not", async () => {
		await setModel("client_projects");
		const clientProjects = await timesheet();
		await setModel("internal");
		const holdingNone = await timesheet();
		await holdInvoice();
		const holdingOne = await timesheet();

		expect([clientProjects.invoices, holdingNone.invoices, holdingOne.invoices]).toEqual([
			true,
			false,
			true,
		]);
		// The same statements whether it holds one or not; and those of Client
		// projects but the clients, which Internal work has none of to read.
		expect(holdingOne.sql).toEqual(holdingNone.sql);
		expect(holdingNone.sql).toEqual(clientProjects.sql.filter((s) => !/from "clients"/.test(s)));
	});

	it("is the organisation's own statement: the one that reads the organisation, and no other, asks about invoices and estimates", async () => {
		await setModel("internal");
		const { sql } = await timesheet();

		const asking = sql.filter((s) => /(from|join) "(invoices|estimates)"/.test(s));
		expect(asking).toHaveLength(1);
		expect(asking[0]).toMatch(/from "organisations"/);
		expect(asking[0]).toContain(
			'exists (select 1 from "invoices" where "invoices"."organisation_id" = "organisations"."id")',
		);
		expect(asking[0]).toContain(
			'exists (select 1 from "estimates" where "estimates"."organisation_id" = "organisations"."id")',
		);
	});
});
