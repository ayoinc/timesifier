import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope, uuidv7 } from "~/db";
import worker from "../../workers/app";
import { captureEmail } from "../auth/harness";
import { freshDatabase } from "../db/database";

// The hourly cron trigger (TS-074, TS-078): the Worker's `scheduled` handler
// issues the recurring invoices that are due and sends overdue reminders, and
// a second run in the same hour does nothing more.

/** 09:00 on 31 October 2026 in London (UTC+0 that day). */
const NOW = Date.parse("2026-10-31T09:00:00Z");

beforeEach(async () => {
	vi.restoreAllMocks();
	await freshDatabase();
});

async function seed() {
	const organisationId = uuidv7();
	await env.DB.prepare(
		"INSERT INTO organisations (id, name, slug, time_zone, currency, created_at, updated_at) VALUES (?, 'Acme', 'acme', 'Europe/London', 'GBP', ?, ?)",
	)
		.bind(organisationId, NOW, NOW)
		.run();
	const scope = organisationScope(env.DB, organisationId);
	await scope.invoiceSettings.insert({
		nextInvoiceNumber: 7,
		lateReminderAfterDays: 3,
		lateReminderEveryDays: null,
	});
	const [client] = await scope.clients.insert({ name: "Globex", nameKey: "globex" });
	if (!client) throw new Error("seed failed");
	await scope.clientContacts.insert({
		clientId: client.id,
		name: "Bola",
		email: "bola@globex.example",
		emailKey: "bola@globex.example",
	});
	const [template] = await scope.recurringInvoices.insert({
		clientId: client.id,
		frequency: "monthly",
		startsOn: "2026-10-31",
		nextIssueOn: "2026-10-31",
		currency: "GBP",
		paymentTermsDays: 30,
	});
	if (!template) throw new Error("seed failed");
	await scope.recurringInvoiceLines.insert({
		recurringInvoiceId: template.id,
		position: 0,
		description: "Support",
		quantityMilli: 1000,
		unitPriceMinor: 50_000,
	});
	const [overdue] = await scope.invoices.insert({
		number: "6",
		clientId: client.id,
		status: "sent",
		currency: "GBP",
		issuedOn: "2026-09-20",
		dueOn: "2026-10-20",
		subtotalMinor: 10_000,
		totalMinor: 10_000,
		sentAt: new Date(Date.parse("2026-09-20T09:00:00Z")),
	});
	if (!overdue) throw new Error("seed failed");
	return { scope, template, overdue };
}

/** Runs the Worker's real `scheduled` handler as the cron trigger would at `at`. */
async function runCron(at: number) {
	const controller = createScheduledController({ scheduledTime: at, cron: "0 * * * *" });
	const ctx = createExecutionContext();
	await worker.scheduled(controller, env, ctx);
	await waitOnExecutionContext(ctx);
}

describe("the hourly billing schedule", () => {
	it("makes the due recurring invoice with the next number and moves the template to the month's end", async () => {
		captureEmail();
		const { scope, template } = await seed();

		await runCron(NOW);

		const made = await scope.invoices.select((i) => eq(i.recurringInvoiceId, template.id));
		expect(made).toHaveLength(1);
		expect(made[0]).toMatchObject({ number: "7", issuedOn: "2026-10-31" });
		const [after] = await scope.recurringInvoices.select((r) => eq(r.id, template.id));
		expect(after?.nextIssueOn).toBe("2026-11-30");
	});

	it("sends an overdue invoice's reminder to the client's billing contact once", async () => {
		const mailbox = captureEmail();
		await seed();

		await runCron(NOW);

		const reminders = mailbox.sent().filter(({ to }) => to === "bola@globex.example");
		expect(reminders).toHaveLength(1);
	});

	it("sends no reminder for an invoice that has been paid", async () => {
		const mailbox = captureEmail();
		const { scope, overdue } = await seed();
		await scope.invoices.update({ status: "paid" }, (i) => eq(i.id, overdue.id));

		await runCron(NOW);

		expect(mailbox.sent().filter(({ to }) => to === "bola@globex.example")).toHaveLength(0);
	});

	it("does nothing more when it runs again in the same hour", async () => {
		const mailbox = captureEmail();
		const { scope } = await seed();

		await runCron(NOW);
		const sent = mailbox.sent().length;
		await runCron(NOW + 10 * 60_000);

		const invoices = await scope.invoices.select(undefined, { orderBy: (i) => [asc(i.number)] });
		expect(invoices.map((i) => i.number)).toEqual(["6", "7"]);
		expect(mailbox.sent()).toHaveLength(sent);
	});
});
