import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { createEstimate } from "~/estimates/estimates.server";
import { NOTHING_BILLED_INTERNALLY } from "~/invoices/makes.server";
import {
	estimatePath,
	estimatesPath,
	invoicePath,
	invoicesPath,
	newInvoicePath,
	recurringListPath,
	recurringPath,
	retainersPath,
	uninvoicedPath,
} from "~/invoices/paths";
import { openRetainer } from "~/invoices/retainers.server";
import worker from "../../workers/app";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";
import { createOrganisation } from "../organisations/harness";
import { open, type Person, pageBody, person, submit, textOf } from "./harness";

// An organisation that works as Both and holds an invoice, an estimate, a
// recurring invoice and a retainer switches to Internal work (TS-115a,
// decision 67). What it holds stays where it was, every page of it answering;
// nothing new is billed: no page offers to make an invoice, an estimate, a
// recurring invoice or a retainer, the server refuses each and stores nothing,
// and the hourly schedule issues none of its recurring invoices.

const SETTINGS = "/app/acme/settings";
/** 09:00 on 31 October 2026 in London (UTC+0 that day). */
const NOW = Date.parse("2026-10-31T09:00:00Z");

let ada: Person;
let acme: { id: string };
let held: {
	client: string;
	project: string;
	invoice: string;
	estimate: string;
	recurring: string;
	retainer: string;
};

beforeEach(async () => {
	await freshDatabase();
	ada = await person(captureEmail(), "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
	await env.DB.prepare("update organisations set work_model = 'both' where id = ?")
		.bind(acme.id)
		.run();
	const scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Globex", nameKey: "globex" });
	if (!client) throw new Error("seed failed");
	const [project] = await scope.projects.insert({
		name: "Website",
		nameKey: "website",
		clientId: client.id,
		billingType: "hourly",
	});
	const [invoice] = await scope.invoices.insert({
		number: "INV-0001",
		clientId: client.id,
		status: "sent",
		currency: "GBP",
		issuedOn: "2026-10-01",
		dueOn: "2026-10-31",
		subtotalMinor: 10_000,
		totalMinor: 10_000,
	});
	const estimate = await createEstimate(scope, ada.user.id, {
		clientId: client.id,
		currency: "GBP",
		issuedOn: "2026-10-01",
		poNumber: null,
		subject: "Website",
		notes: null,
		discountBasisPoints: 0,
	});
	if (!project || !invoice || !estimate?.ok) throw new Error("seed failed");
	// Accepted, so its page would offer Make invoice under Both.
	await scope.estimates.update({ status: "accepted" }, (e) => eq(e.id, estimate.id));
	const [recurring] = await scope.recurringInvoices.insert({
		clientId: client.id,
		frequency: "monthly",
		startsOn: "2026-10-31",
		nextIssueOn: "2026-10-31",
		currency: "GBP",
		paymentTermsDays: 30,
	});
	if (!recurring) throw new Error("seed failed");
	await scope.recurringInvoiceLines.insert({
		recurringInvoiceId: recurring.id,
		position: 0,
		description: "Support",
		quantityMilli: 1000,
		unitPriceMinor: 50_000,
	});
	const retainer = await openRetainer(scope, ada.user.id, client.id, null, "GBP");
	if (!retainer?.ok) throw new Error("seed failed");
	held = {
		client: client.id,
		project: project.id,
		invoice: invoice.id,
		estimate: estimate.id,
		recurring: recurring.id,
		retainer: retainer.id,
	};
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

const switchTo = async (workModel: "internal" | "both") => {
	const response = await submit(
		SETTINGS,
		{ intent: "work-model", workModel, internalTerm: "Work codes" },
		ada,
		{ byScript: true },
	);
	expect(response.status).toBe(200);
};

/** The words of a page, which must answer. */
async function wordsOf(path: string) {
	const response = await open(path, ada);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
}

/** How many invoices, estimates, recurring invoices and retainers the organisation holds. */
async function counts() {
	const scope = organisationScope(env.DB, acme.id);
	const [invoices, estimates, recurring, retainers] = await Promise.all([
		scope.invoices.select(),
		scope.estimates.select(),
		scope.recurringInvoices.select(),
		scope.retainers.select(),
	]);
	return [invoices.length, estimates.length, recurring.length, retainers.length];
}

/** Runs the Worker's real `scheduled` handler as the hourly cron trigger would at `at`. */
async function runCron(at: number) {
	const controller = createScheduledController({ scheduledTime: at, cron: "0 * * * *" });
	const ctx = createExecutionContext();
	await worker.scheduled(controller, env, ctx);
	await waitOnExecutionContext(ctx);
}

/** What each page offers to make, by the words of its button or link. */
const OFFERS = () =>
	[
		[invoicesPath("acme"), "New invoice"],
		[estimatesPath("acme"), "Start estimate"],
		[estimatePath("acme", held.estimate), "Make invoice"],
		[recurringListPath("acme"), "New recurring invoice"],
		[retainersPath("acme"), "Open retainer"],
		[retainersPath("acme"), "Invoice funds"],
		[uninvoicedPath("acme"), "Invoice Globex"],
	] as const;

describe("switching from Both to Internal work while holding invoices and estimates", () => {
	it("under Both, each page offers to make one: what the switch takes away was there", async () => {
		// A billable hour, so Uninvoiced has Globex to invoice.
		const scope = organisationScope(env.DB, acme.id);
		const started = Date.now() - 2 * 3_600_000;
		await scope.timeEntries.insert({
			userId: ada.user.id,
			projectId: held.project,
			billable: true,
			description: null,
			startedAt: new Date(started),
			spentOn: new Date(started).toISOString().slice(0, 10),
			endedAt: new Date(started + 3_600_000),
		});
		for (const [path, offer] of OFFERS()) expect(await wordsOf(path), path).toContain(offer);
	});

	it("keeps everything it holds reachable: the navigation, the lists and each page", async () => {
		await switchTo("internal");

		const timesheet = await pageBody(await open("/app/acme", ada));
		expect(timesheet).toContain(`href="${invoicesPath("acme")}"`);
		expect(timesheet).toContain(`href="${estimatesPath("acme")}"`);
		expect(timesheet).not.toContain('href="/app/acme/clients"');
		expect(await wordsOf(invoicesPath("acme"))).toContain("INV-0001");
		expect(await wordsOf(invoicePath("acme", held.invoice))).toContain("INV-0001");
		expect(await wordsOf(estimatesPath("acme"))).toContain("Globex");
		expect(await wordsOf(estimatePath("acme", held.estimate))).toContain("Globex");
		expect(await wordsOf(recurringListPath("acme"))).toContain("Globex");
		expect(await wordsOf(recurringPath("acme", held.recurring))).toContain("Globex");
		expect(await wordsOf(retainersPath("acme"))).toContain("Globex");
	});

	it("offers to make none of them on any page", async () => {
		await switchTo("internal");

		for (const [path, offer] of OFFERS()) expect(await wordsOf(path), path).not.toContain(offer);
		expect((await open(newInvoicePath("acme"), ada)).status).toBe(404);
	});

	it("refuses each on the server and stores nothing", async () => {
		await switchTo("internal");
		const before = await counts();

		const attempts = [
			[newInvoicePath("acme"), { client: held.client, from: "2026-10-01", to: "2026-10-31" }, 404],
			[
				estimatesPath("acme"),
				{
					intent: "create",
					clientId: held.client,
					currency: "GBP",
					issuedOn: "2026-11-02",
					subject: "",
				},
				400,
			],
			[estimatePath("acme", held.estimate), { intent: "invoice" }, 400],
			[
				recurringListPath("acme"),
				{
					intent: "create",
					clientId: held.client,
					currency: "GBP",
					startsOn: "2026-11-02",
					frequency: "monthly",
					endsOn: "",
					paymentTermsDays: "30",
					subject: "",
					notes: "",
				},
				400,
			],
			[
				retainersPath("acme"),
				{ intent: "open", clientId: held.client, projectId: held.project, currency: "GBP" },
				400,
			],
			[
				retainersPath("acme"),
				{ intent: "funds", retainerId: held.retainer, amount: "2000.00" },
				400,
			],
		] as const;
		for (const [path, fields, status] of attempts) {
			const response = await submit(path, fields, ada, { byScript: true });
			expect(response.status, `${path} ${JSON.stringify(fields)}`).toBe(status);
			if (status === 400) expect(await response.text()).toContain(NOTHING_BILLED_INTERNALLY);
		}
		expect(await counts()).toEqual(before);
	});

	it("the hourly schedule issues none of its recurring invoices, and does again once it is back to Both", async () => {
		const scope = organisationScope(env.DB, acme.id);
		const issued = () => scope.invoices.select((i) => eq(i.recurringInvoiceId, held.recurring));
		await switchTo("internal");

		await runCron(NOW);
		expect(await issued()).toHaveLength(0);
		const [waiting] = await scope.recurringInvoices.select((r) => eq(r.id, held.recurring));
		expect(waiting?.nextIssueOn).toBe("2026-10-31");

		await switchTo("both");
		await runCron(NOW);
		expect(await issued()).toHaveLength(1);
	});
});
