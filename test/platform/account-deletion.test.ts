import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organisationScope } from "~/db";
import { changeExpense } from "~/expenses/expenses.server";
import { receiptKey } from "~/expenses/receipts.server";
import { deletePersonAccount } from "~/platform/account-deletion.server";
import {
	captureEmail,
	codeCookie,
	type Mailbox,
	post,
	requestCode,
	signIn,
	whoIs,
} from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	row,
	seedInvitation,
	seedMember,
	seedMembership,
	value,
} from "../organisations/harness";
import { seedLeave } from "../pages/leave-seed";

// Deleting an account on request (TS-099, docs/decisions.md entry 36): the
// person's own data goes, their organisations' records stay under "Deleted
// person", their receipts go unless an issued invoice holds them, and an
// organisation they were alone in goes with them. Nothing at all happens while
// they are the only owner of an organisation with other members.

const HOUR = 3_600_000;
const PDF = new TextEncoder().encode("%PDF-1.7 a receipt");

let mailbox: Mailbox;

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Ada owns Acme, with Bola a member, and Solo, alone. In Acme she has an
 * entry, leave, an invitation she sent, and three expenses with receipts: one
 * on no invoice, one on a draft and one on an invoice that was sent.
 */
async function ada() {
	const signedIn = await signIn(mailbox, "ada@example.com");
	const userId = signedIn.user.id;
	const acme = await createOrganisation(signedIn.cookie, "Acme");
	const solo = await createOrganisation(signedIn.cookie, "Solo");
	const bola = await seedMember(acme.id, "member", "bola@example.com");
	const invitation = await seedInvitation(acme.id, userId, "grace@example.com");
	await seedLeave(acme.id, userId, "annual", "2026-12-01", "2026-12-02");

	const scope = organisationScope(env.DB, acme.id);
	const [client] = await scope.clients.insert({ name: "Initech", nameKey: "initech" });
	const [project] = await scope.projects.insert({ name: "Site", nameKey: "site" });
	const [category] = await scope.expenseCategories.insert({ name: "Taxis", nameKey: "taxis" });
	if (!client || !project || !category) throw new Error("seed failed");
	const [entry] = await scope.timeEntries.insert({
		userId,
		projectId: project.id,
		description: "Survey",
		startedAt: new Date(Date.now() - 2 * HOUR),
		endedAt: new Date(Date.now() - HOUR),
	});
	if (!entry) throw new Error("seed failed");

	async function expenseWithReceipt(notes: string) {
		const [expense] = await scope.expenses.insert({
			userId,
			projectId: project?.id ?? "",
			categoryId: category?.id ?? "",
			spentOn: "2026-11-02",
			amountMinor: 1250,
			currency: "GBP",
			notes,
		});
		if (!expense) throw new Error("seed failed");
		const key = receiptKey(acme.id, expense.id);
		await env.RECEIPTS.put(key, PDF, { httpMetadata: { contentType: "application/pdf" } });
		await scope.expenses.update(
			{ receiptKey: key, receiptName: `${notes}.pdf`, receiptType: "application/pdf" },
			(e) => eq(e.id, expense.id),
		);
		return { id: expense.id, key };
	}
	const loose = await expenseWithReceipt("Loose");
	const drafted = await expenseWithReceipt("Drafted");
	const sent = await expenseWithReceipt("Sent");

	async function invoiceOf(expenseId: string, number: string) {
		const [invoice] = await scope.invoices.insert({
			number,
			clientId: client?.id ?? "",
			currency: "GBP",
			issuedOn: "2026-11-30",
			dueOn: "2026-12-30",
		});
		if (!invoice) throw new Error("seed failed");
		const [line] = await scope.invoiceLines.insert({
			invoiceId: invoice.id,
			position: 0,
			kind: "expense",
			description: "Travel",
			quantityMilli: 1000,
			unitPriceMinor: 1250,
			amountMinor: 1250,
		});
		if (!line) throw new Error("seed failed");
		await scope.invoiceLineSources.insert({ lineId: line.id, expenseId });
		return invoice.id;
	}
	await invoiceOf(drafted.id, "1");
	const issued = await invoiceOf(sent.id, "2");
	await scope.invoices.update({ status: "sent", sentAt: new Date() }, (i) => eq(i.id, issued));

	return { ...signedIn, userId, acme, solo, bola, invitation, entry, loose, drafted, sent };
}

/** What a person's sign-in answers, the whole journey through the Worker. */
async function signingIn(email: string) {
	const asked = await requestCode(email, { client: "198.51.100.200" });
	if (asked.status !== 200) return asked;
	return post(
		"/sign-in/email-otp",
		{ email, otp: await mailbox.codeFor(email) },
		{ client: "198.51.100.200", cookie: codeCookie(asked) },
	);
}

/** The rows a deletion would take, counted, to show a refused one took none. */
const TOTALS =
	"select (select count(*) from sessions) s, (select count(*) from memberships) m, (select count(*) from invitations) i, (select count(*) from sign_ins) si, (select count(*) from organisations) o";

describe("deleting an account", () => {
	it("is refused while the person is the only owner of an organisation with others, and changes nothing", async () => {
		const seeded = await ada();
		const before = await env.DB.prepare(TOTALS).first();

		const deleted = await deletePersonAccount(seeded.userId);

		expect(deleted).toEqual({ ok: false, blocking: [{ id: seeded.acme.id, name: "Acme" }] });
		expect(await env.DB.prepare(TOTALS).first()).toEqual(before);
		expect(await row("select email, closed_at from users where id = ?", seeded.userId)).toEqual({
			email: "ada@example.com",
			closed_at: null,
		});
		expect(await env.RECEIPTS.head(seeded.loose.key)).not.toBeNull();
		expect(await whoIs(seeded.cookie)).toMatchObject({ id: seeded.userId });
	});

	it("takes the person's own data, keeps their organisations' records, and their receipts but those an issued invoice holds", async () => {
		const seeded = await ada();
		await seedMembership(
			seeded.acme.id,
			(await signIn(mailbox, "cy@example.com")).user.id,
			"owner",
		);

		const deleted = await deletePersonAccount(seeded.userId);

		expect(deleted).toEqual({ ok: true, receiptsDeleted: 2, organisationsDeleted: 1 });
		expect(
			await row(
				"select name, email, newsletter, announcements from users where id = ?",
				seeded.userId,
			),
		).toEqual({
			name: "Deleted person",
			email: `${seeded.userId}@deleted.invalid`,
			newsletter: 0,
			announcements: 0,
		});
		expect(await value("select closed_at from users where id = ?", seeded.userId)).not.toBeNull();
		for (const table of ["sessions", "sign_ins", "memberships"]) {
			expect(await value(`select count(*) from ${table} where user_id = ?`, seeded.userId)).toBe(0);
		}
		expect(
			await value("select count(*) from invitations where inviter_id = ?", seeded.userId),
		).toBe(0);
		expect(
			await value("select count(*) from leave_requests where user_id = ?", seeded.userId),
		).toBe(0);
		// The organisation Ada was alone in is gone; Acme and its people stay.
		expect(await value("select count(*) from organisations where id = ?", seeded.solo.id)).toBe(0);
		expect(await value("select count(*) from organisations where id = ?", seeded.acme.id)).toBe(1);
		expect(
			await value("select count(*) from memberships where user_id = ?", seeded.bola.userId),
		).toBe(1);

		// Acme's records keep Ada's id and amounts.
		expect(await value("select user_id from time_entries where id = ?", seeded.entry.id)).toBe(
			seeded.userId,
		);
		expect(
			await value(
				"select count(*) from expenses where user_id = ? and amount_minor = 1250",
				seeded.userId,
			),
		).toBe(3);

		// Receipts on no invoice and on a draft go, from R2 and from their expense.
		for (const { id, key } of [seeded.loose, seeded.drafted]) {
			expect(await env.RECEIPTS.head(key)).toBeNull();
			expect(
				await row("select receipt_key, receipt_name, receipt_type from expenses where id = ?", id),
			).toEqual({ receipt_key: null, receipt_name: null, receipt_type: null });
		}
		// The one on a sent invoice is a financial record, and stays whole.
		expect(await env.RECEIPTS.head(seeded.sent.key)).not.toBeNull();
		expect(await value("select receipt_key from expenses where id = ?", seeded.sent.id)).toBe(
			seeded.sent.key,
		);
	});

	it("leaves an account nobody can sign in to", async () => {
		const seeded = await ada();
		await seedMembership(
			seeded.acme.id,
			(await signIn(mailbox, "cy@example.com")).user.id,
			"owner",
		);
		expect((await deletePersonAccount(seeded.userId)).ok).toBe(true);

		expect(await whoIs(seeded.cookie)).toBeNull();
		// The address it had is free: signing in with it is a new, empty account.
		const again = await signIn(mailbox, "ada@example.com");
		expect(again.user.id).not.toBe(seeded.userId);
		expect(await value("select count(*) from memberships where user_id = ?", again.user.id)).toBe(
			0,
		);
		// And the deleted account's own address starts no session.
		const deletedAddress = `${seeded.userId}@deleted.invalid`;
		const refused = await signingIn(deletedAddress);
		expect(refused.status).not.toBe(200);
		expect(await value("select count(*) from sessions where user_id = ?", seeded.userId)).toBe(0);
	});
});

describe("an invoiced expense", () => {
	const changed = "an invoiced expense does not change";
	const update = (sql: string, ...values: unknown[]) =>
		env.DB.prepare(sql)
			.bind(...values)
			.run();

	it("keeps its receipt through the app, even on a draft", async () => {
		const seeded = await ada();
		const scope = organisationScope(env.DB, seeded.acme.id);
		const [before] = await scope.expenses.select((e) => eq(e.id, seeded.drafted.id));
		if (!before) throw new Error("seed failed");

		const replaced = await changeExpense(scope, seeded.userId, seeded.drafted.id, {
			spentOn: before.spentOn,
			projectId: before.projectId,
			categoryId: before.categoryId,
			amount: "12.50",
			quantity: "",
			notes: before.notes,
			billable: before.billable,
			reimbursable: before.reimbursable,
			receipt: new File([PDF], "another.pdf", { type: "application/pdf" }),
			removeReceipt: false,
		});

		expect(replaced).toMatchObject({
			ok: false,
			problem: "That expense is on an invoice, so it cannot change.",
		});
		expect(
			await row("select receipt_key, receipt_name from expenses where id = ?", seeded.drafted.id),
		).toEqual({ receipt_key: seeded.drafted.key, receipt_name: "Drafted.pdf" });
	});

	it("is refused by the database for every change but its receipt going", async () => {
		const seeded = await ada();
		for (const { id } of [seeded.drafted, seeded.sent]) {
			await expect(
				update("update expenses set amount_minor = 999 where id = ?", id),
			).rejects.toThrow(changed);
			await expect(
				update(
					"update expenses set receipt_key = ?, receipt_name = 'another.pdf' where id = ?",
					`${id}-another`,
					id,
				),
			).rejects.toThrow(changed);
			// Its receipt going and the amount changing in one statement is still a change.
			await expect(
				update(
					"update expenses set receipt_key = null, receipt_name = null, receipt_type = null, amount_minor = 999 where id = ?",
					id,
				),
			).rejects.toThrow(changed);
		}

		await update(
			"update expenses set receipt_key = null, receipt_name = null, receipt_type = null, updated_at = ? where id = ?",
			Date.now(),
			seeded.drafted.id,
		);
		expect(
			await value("select receipt_key from expenses where id = ?", seeded.drafted.id),
		).toBeNull();
		// Once gone, a receipt cannot be put back on it either.
		await expect(
			update(
				"update expenses set receipt_key = ?, receipt_name = 'Drafted.pdf', receipt_type = 'application/pdf' where id = ?",
				seeded.drafted.key,
				seeded.drafted.id,
			),
		).rejects.toThrow(changed);
	});
});
