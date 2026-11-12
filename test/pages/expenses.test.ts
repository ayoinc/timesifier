import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { organisationScope } from "~/db";
import { receiptKey } from "~/expenses/receipts.server";

import { captureEmail, type Mailbox, ORIGIN } from "../auth/harness";
import { freshDatabase } from "../db/database";
import {
	createOrganisation,
	type Role,
	row,
	seedMembership,
	seedTeam,
	value,
} from "../organisations/harness";
import { dataAddress, open, type Person, pageBody, person, submit, textOf } from "./harness";

// Expenses (TS-070, B9) through the pages' own actions, for each role: the
// categories in Workspace settings, recording and changing an expense with its
// receipt, the locks of a submitted or approved week, the lock date and an
// invoice, who sees whose, Approvals, and the Expenses view of Reports.
// Ada owns Acme, Hedy is an admin, Fay is Finance, Mona manages Design, which
// holds Grace, and Bob is in no team.

const EXPENSES = "/app/acme/expenses";
const SETTINGS = "/app/acme/settings";
const APPROVALS = "/app/acme/approvals";
const REPORT = "/app/acme/reports/expenses";
/** A Wednesday: the server's clock for every test here. Its week is 9 to 15 November. */
const T0 = Date.parse("2026-11-11T10:00:00Z");
const WEEK = "2026-11-09";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%stub\n");

let mailbox: Mailbox;
let ada: Person;
let acme: { id: string };

beforeEach(async () => {
	await freshDatabase();
	mailbox = captureEmail();
	ada = await person(mailbox, "ada@example.com");
	acme = await createOrganisation(ada.cookie, "Acme");
}, 30_000);

afterEach(() => {
	vi.restoreAllMocks();
});

async function memberOfAcme(role: Role, email: string): Promise<Person> {
	const who = await person(mailbox, email);
	await seedMembership(acme.id, who.user.id, role);
	return who;
}

/** Everyone, Acme's projects and categories, and the clock at T0. */
async function seed() {
	const hedy = await memberOfAcme("admin", "hedy@example.com");
	const fay = await memberOfAcme("finance", "fay@example.com");
	const mona = await memberOfAcme("member", "mona@example.com");
	const grace = await memberOfAcme("member", "grace@example.com");
	const bob = await memberOfAcme("member", "bob@example.com");
	await seedTeam(acme.id, "Design", { members: [grace.user.id], managers: [mona.user.id] });
	const scope = organisationScope(env.DB, acme.id);
	const [apex, kyoto, internal] = await scope.projects.insert([
		{ name: "Apex", nameKey: "apex" },
		{ name: "Kyoto", nameKey: "kyoto", currency: "JPY" },
		{ name: "Internal", nameKey: "internal", billingType: "non_billable" },
	]);
	if (!apex || !kyoto || !internal) throw new Error("seed failed");
	vi.spyOn(Date, "now").mockReturnValue(T0);
	expect((await ask(ada, { intent: "add-category", name: "Travel" }, SETTINGS)).status).toBe(200);
	expect(
		(
			await ask(
				ada,
				{
					intent: "add-category",
					name: "Mileage",
					unitName: "mile",
					unitPrice: "0.45",
					from: "2026-11-01",
				},
				SETTINGS,
			)
		).status,
	).toBe(200);
	const travel =
		(await value<string>("select id from expense_categories where name = 'Travel'")) ?? "";
	const mileage =
		(await value<string>("select id from expense_categories where name = 'Mileage'")) ?? "";
	return { hedy, fay, mona, grace, bob, apex, kyoto, internal, travel, mileage };
}

/** What a page's action answered a form sent by script. */
async function ask(who: Person, fields: Record<string, string>, path = EXPENSES) {
	const response = await submit(path, fields, who, { byScript: true });
	return { status: response.status, said: await response.text() };
}

/** The same, as multipart form data, which can carry a receipt. */
async function send(who: Person, fields: Record<string, string | File>, path = EXPENSES) {
	const body = new FormData();
	for (const [name, field] of Object.entries(fields)) body.append(name, field);
	const response = await exports.default.fetch(
		new Request(`${ORIGIN}${dataAddress(path)}`, {
			method: "POST",
			headers: { Cookie: who.cookie, "CF-Connecting-IP": who.client, Origin: ORIGIN },
			body,
			redirect: "manual",
		}),
	);
	return { status: response.status, said: await response.text() };
}

/** Records an expense as `who` and returns the answer and the id of the expense made, if any. */
async function record(who: Person, fields: Record<string, string | File>) {
	const before = await value<number>("select count(*) from expenses");
	const answer = await send(who, { intent: "record", ...fields });
	const made = (await value<number>("select count(*) from expenses")) !== before;
	const id = made
		? await value<string>(
				"select id from expenses where user_id = ? order by created_at desc, id desc limit 1",
				who.user.id,
			)
		: null;
	return { ...answer, id };
}

const expense = (id: string | null) =>
	row<{
		amount_minor: number;
		currency: string;
		quantity_milli: number | null;
		unit_price_minor: number | null;
		billable: number;
		reimbursable: number;
		notes: string | null;
		spent_on: string;
		receipt_key: string | null;
		receipt_name: string | null;
	}>("select * from expenses where id = ?", id);

async function textAt(path: string, who: Person) {
	const response = await open(path, who);
	expect(response.status, path).toBe(200);
	return textOf(await pageBody(response));
}

describe("expense categories in Workspace settings", () => {
	it("an owner or admin adds, renames, archives and restores them; nobody else is shown them", async () => {
		const { hedy, fay, mona, grace, apex, travel } = await seed();
		expect((await ask(hedy, { intent: "add-category", name: "Meals" }, SETTINGS)).status).toBe(200);
		for (const who of [fay, mona, grace]) {
			expect((await ask(who, { intent: "add-category", name: "Hotels" }, SETTINGS)).status).toBe(
				404,
			);
		}
		expect(await value("select count(*) from expense_categories where name = 'Hotels'")).toBe(0);

		const taken = await ask(ada, { intent: "add-category", name: "travel" }, SETTINGS);
		expect(taken.status).toBe(409);
		expect(taken.said).toContain("A category with this name already exists.");

		const renamed = await ask(
			hedy,
			{ intent: "change-category", categoryId: travel, name: "Trains and taxis" },
			SETTINGS,
		);
		expect(renamed.status).toBe(200);
		expect(await value("select name from expense_categories where id = ?", travel)).toBe(
			"Trains and taxis",
		);

		await ask(ada, { intent: "archive-category", categoryId: travel }, SETTINGS);
		const archived = await record(grace, {
			spentOn: "2026-11-10",
			projectId: apex.id,
			categoryId: travel,
			amount: "12.50",
		});
		expect(archived.status).toBe(400);
		expect(archived.said).toContain("Choose an active category.");
		expect(await textAt(SETTINGS, ada)).toContain("Archived");

		await ask(ada, { intent: "restore-category", categoryId: travel }, SETTINGS);
		expect(
			(
				await record(grace, {
					spentOn: "2026-11-10",
					projectId: apex.id,
					categoryId: travel,
					amount: "12.50",
				})
			).status,
		).toBe(200);
	});

	it("a unit and its price come together", async () => {
		await seed();
		const half = await ask(
			ada,
			{ intent: "add-category", name: "Hotels", unitName: "night" },
			SETTINGS,
		);
		expect(half.status).toBe(400);
		expect(half.said).toContain("Give both the unit");
	});

	it("a new unit price applies to expenses dated from its day, and leaves those before alone", async () => {
		const { grace, apex, mileage } = await seed();
		const before = await record(grace, {
			spentOn: "2026-11-10",
			projectId: apex.id,
			categoryId: mileage,
			quantity: "12.5",
		});
		expect(before.status).toBe(200);
		// 12.5 miles at 45p is 562.5p, rounded half up once.
		expect(await expense(before.id)).toMatchObject({
			amount_minor: 563,
			quantity_milli: 12_500,
			unit_price_minor: 45,
			currency: "GBP",
		});

		const changed = await ask(
			ada,
			{
				intent: "change-category",
				categoryId: mileage,
				name: "Mileage",
				unitName: "mile",
				unitPrice: "0.50",
				from: "2026-11-11",
			},
			SETTINGS,
		);
		expect(changed.status).toBe(200);
		expect(await value("select count(*) from expense_category_prices")).toBe(2);

		const earlier = await record(grace, {
			spentOn: "2026-11-10",
			projectId: apex.id,
			categoryId: mileage,
			quantity: "10",
		});
		const later = await record(grace, {
			spentOn: "2026-11-12",
			projectId: apex.id,
			categoryId: mileage,
			quantity: "10",
		});
		expect((await expense(earlier.id))?.amount_minor).toBe(450);
		expect((await expense(later.id))?.amount_minor).toBe(500);
		expect((await expense(before.id))?.amount_minor).toBe(563);
	});
});

describe("recording an expense", () => {
	it("is stored in minor units of its project's currency, with what the person said of it", async () => {
		const { grace, apex, kyoto, travel } = await seed();
		const pounds = await record(grace, {
			spentOn: "2026-11-10",
			projectId: apex.id,
			categoryId: travel,
			amount: "1,234.5",
			notes: "Train to Leeds",
			billable: "on",
			reimbursable: "on",
		});
		expect(pounds.status).toBe(200);
		expect(pounds.said).toContain("Expense recorded.");
		expect(await expense(pounds.id)).toMatchObject({
			amount_minor: 123_450,
			currency: "GBP",
			billable: 1,
			reimbursable: 1,
			notes: "Train to Leeds",
			spent_on: "2026-11-10",
		});

		const yen = await record(grace, {
			spentOn: "2026-11-10",
			projectId: kyoto.id,
			categoryId: travel,
			amount: "1500",
		});
		expect(await expense(yen.id)).toMatchObject({ amount_minor: 1500, currency: "JPY" });

		const fraction = await record(grace, {
			spentOn: "2026-11-10",
			projectId: kyoto.id,
			categoryId: travel,
			amount: "15.5",
		});
		expect(fraction.status).toBe(400);
		expect(fraction.said).toContain("Enter an amount in JPY");

		expect(
			await value("select count(*) from activity_records where action = 'expense.created'"),
		).toBe(2);
	});

	it("is billable as its project bills, and never on a non-billable project", async () => {
		const { grace, internal, travel } = await seed();
		const made = await record(grace, {
			spentOn: "2026-11-10",
			projectId: internal.id,
			categoryId: travel,
			amount: "3",
			billable: "on",
		});
		expect(made.status).toBe(200);
		expect((await expense(made.id))?.billable).toBe(0);
		expect(await textAt(EXPENSES, grace)).toContain("Not billable");
	});

	it("refuses a unit-priced category on a project billed in another currency", async () => {
		const { grace, kyoto, mileage } = await seed();
		const refused = await record(grace, {
			spentOn: "2026-11-10",
			projectId: kyoto.id,
			categoryId: mileage,
			quantity: "4",
		});
		expect(refused.status).toBe(400);
		expect(refused.said).toContain("Mileage is priced in GBP");
	});

	it("only its person changes or deletes it", async () => {
		const { grace, apex, travel } = await seed();
		const made = await record(grace, {
			spentOn: "2026-11-10",
			projectId: apex.id,
			categoryId: travel,
			amount: "10",
		});
		const change = {
			intent: "change",
			expenseId: made.id ?? "",
			spentOn: "2026-11-10",
			projectId: apex.id,
			categoryId: travel,
			amount: "99",
		};
		expect((await send(ada, change)).status).toBe(404);
		expect((await ask(ada, { intent: "delete", expenseId: made.id ?? "" })).status).toBe(404);
		expect((await expense(made.id))?.amount_minor).toBe(1000);

		expect((await send(grace, change)).status).toBe(200);
		expect((await expense(made.id))?.amount_minor).toBe(9900);
		expect((await ask(grace, { intent: "delete", expenseId: made.id ?? "" })).status).toBe(200);
		expect(await expense(made.id)).toBeNull();
		expect(
			await value("select count(*) from activity_records where subject_type = 'expense'"),
		).toBe(3);
	});
});

describe("receipts", () => {
	it("are stored under the organisation's key and served only to whoever may see the expense", async () => {
		// Signing in reads the real clock, so Ivy of Initech comes first.
		const ivy = await person(mailbox, "ivy@example.com");
		await createOrganisation(ivy.cookie, "Initech");
		const { hedy, fay, mona, grace, bob, apex, travel } = await seed();
		const made = await record(grace, {
			spentOn: "2026-11-10",
			projectId: apex.id,
			categoryId: travel,
			amount: "8.20",
			receipt: new File([PNG], "taxi.png", { type: "image/png" }),
		});
		expect(made.status).toBe(200);
		const id = made.id ?? "";
		expect(await expense(id)).toMatchObject({
			receipt_key: `org/${acme.id}/receipts/${id}`,
			receipt_name: "taxi.png",
		});
		expect(await env.RECEIPTS.head(receiptKey(acme.id, id))).not.toBeNull();

		const address = `${EXPENSES}/${id}/receipt`;
		for (const who of [grace, mona, ada, hedy, fay]) {
			const served = await open(address, who);
			expect(served.status, who.user.email).toBe(200);
			expect(served.headers.get("Content-Type")).toBe("image/png");
			expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
		}
		// Bob may not see Grace's time, and so not her receipt.
		expect((await open(address, bob)).status).toBe(404);

		// Someone in another organisation, at Acme's address or their own.
		expect((await open(address, ivy)).status).toBe(404);
		expect((await open(`/app/initech/expenses/${id}/receipt`, ivy)).status).toBe(404);
	});

	it("is a PDF, PNG or JPEG of up to 10 MB, judged by its bytes", async () => {
		const { grace, apex, travel } = await seed();
		const fields = { spentOn: "2026-11-10", projectId: apex.id, categoryId: travel, amount: "1" };
		const notAnImage = await record(grace, {
			...fields,
			receipt: new File([new TextEncoder().encode("hello")], "x.png", { type: "image/png" }),
		});
		expect(notAnImage.status).toBe(400);
		expect(notAnImage.said).toContain("A receipt is a PDF, PNG or JPEG file of up to 10 MB.");

		const tooLarge = new Uint8Array(10 * 1024 * 1024 + 1);
		tooLarge.set(PDF);
		const large = await record(grace, {
			...fields,
			receipt: new File([tooLarge], "big.pdf", { type: "application/pdf" }),
		});
		expect(large.status).toBe(400);
		expect(await value("select count(*) from expenses")).toBe(0);

		const pdf = await record(grace, {
			...fields,
			receipt: new File([PDF], "invoice.pdf", { type: "application/pdf" }),
		});
		expect(pdf.status).toBe(200);
	});

	it("goes with its expense, and can be removed", async () => {
		const { grace, apex, travel } = await seed();
		const fields = { spentOn: "2026-11-10", projectId: apex.id, categoryId: travel, amount: "1" };
		const receipt = () => new File([PNG], "taxi.png", { type: "image/png" });
		const kept = await record(grace, { ...fields, receipt: receipt() });
		const keptId = kept.id ?? "";
		expect(
			(await send(grace, { intent: "change", expenseId: keptId, ...fields, removeReceipt: "on" }))
				.status,
		).toBe(200);
		expect((await expense(keptId))?.receipt_key).toBeNull();
		expect(await env.RECEIPTS.head(receiptKey(acme.id, keptId))).toBeNull();

		const deleted = await record(grace, { ...fields, receipt: receipt() });
		const deletedId = deleted.id ?? "";
		await ask(grace, { intent: "delete", expenseId: deletedId });
		expect(await env.RECEIPTS.head(receiptKey(acme.id, deletedId))).toBeNull();
	});
});

describe("locks", () => {
	it("are submitted, withdrawn, approved and returned with the week's time", async () => {
		const { mona, grace, apex, travel } = await seed();
		const fields = { spentOn: "2026-11-10", projectId: apex.id, categoryId: travel, amount: "5" };
		const made = await record(grace, fields);
		const change = { intent: "change", expenseId: made.id ?? "", ...fields, amount: "6" };

		expect((await ask(grace, { intent: "submit", startsOn: WEEK })).status).toBe(200);
		const submitted = await send(grace, change);
		expect(submitted.status).toBe(409);
		expect(submitted.said).toContain("That week is submitted");
		expect((await record(grace, { ...fields, spentOn: "2026-11-12" })).status).toBe(409);
		expect(await textAt(EXPENSES, grace)).toContain("Locked while the week is submitted");

		expect((await ask(grace, { intent: "withdraw", startsOn: WEEK })).status).toBe(200);
		expect((await send(grace, change)).status).toBe(200);

		await ask(grace, { intent: "submit", startsOn: WEEK });
		const periodId = await value<string>("select id from periods where user_id = ?", grace.user.id);
		expect(
			(await ask(mona, { intent: "approve", periodId: periodId ?? "" }, APPROVALS)).status,
		).toBe(200);
		expect((await send(grace, change)).status).toBe(409);
		expect((await ask(grace, { intent: "delete", expenseId: made.id ?? "" })).status).toBe(409);

		// Returned: the person can change it again.
		await env.DB.prepare("update periods set status = 'submitted' where id = ?")
			.bind(periodId)
			.run();
		expect(
			(
				await ask(
					mona,
					{ intent: "return", periodId: periodId ?? "", comment: "Add the receipt" },
					APPROVALS,
				)
			).status,
		).toBe(200);
		expect((await send(grace, { ...change, amount: "7" })).status).toBe(200);
		expect((await expense(made.id))?.amount_minor).toBe(700);
	});

	it("the lock date locks the expenses on and before it", async () => {
		const { grace, apex, travel } = await seed();
		const fields = { spentOn: "2026-11-11", projectId: apex.id, categoryId: travel, amount: "5" };
		const made = await record(grace, fields);
		await env.DB.prepare("update organisations set locked_through = '2026-11-10' where id = ?")
			.bind(acme.id)
			.run();
		const before = await record(grace, { ...fields, spentOn: "2026-11-10" });
		expect(before.status).toBe(409);
		expect(before.said).toContain("lock date");
		const moved = await send(grace, {
			intent: "change",
			expenseId: made.id ?? "",
			...fields,
			spentOn: "2026-11-09",
		});
		expect(moved.status).toBe(409);
		expect(
			(await send(grace, { intent: "change", expenseId: made.id ?? "", ...fields })).status,
		).toBe(200);
	});

	it("an expense on an invoice is locked", async () => {
		const { grace, apex, travel } = await seed();
		const fields = { spentOn: "2026-11-10", projectId: apex.id, categoryId: travel, amount: "5" };
		const made = await record(grace, fields);
		const scope = organisationScope(env.DB, acme.id);
		const [client] = await scope.clients.insert({ name: "Apex Ltd", nameKey: "apex ltd" });
		const [invoice] = await scope.invoices.insert({
			number: "1",
			clientId: client?.id ?? "",
			currency: "GBP",
			issuedOn: "2026-11-30",
			dueOn: "2026-12-30",
		});
		const [line] = await scope.invoiceLines.insert({
			invoiceId: invoice?.id ?? "",
			position: 0,
			kind: "expense",
			description: "Travel",
			projectId: apex.id,
			quantityMilli: 1000,
			unitPriceMinor: 500,
			amountMinor: 500,
		});
		await scope.invoiceLineSources.insert({ lineId: line?.id ?? "", expenseId: made.id ?? "" });

		const refused = await send(grace, {
			intent: "change",
			expenseId: made.id ?? "",
			...fields,
			amount: "6",
		});
		expect(refused.status).toBe(409);
		expect(refused.said).toContain("on an invoice");
		expect(await textAt(EXPENSES, grace)).toContain("Locked: it is on an invoice");
	});
});

describe("who sees whose expenses", () => {
	it("a person their own, a manager their teams' people's, an owner, admin or Finance everyone's", async () => {
		const { hedy, fay, mona, grace, bob, apex, travel } = await seed();
		await record(grace, {
			spentOn: "2026-11-10",
			projectId: apex.id,
			categoryId: travel,
			amount: "12.50",
		});
		const graces = `${EXPENSES}?person=${grace.user.id}`;
		for (const who of [grace, mona, ada, hedy, fay]) {
			const text = await textAt(graces, who);
			expect(text, who.user.email).toContain("Travel · Apex");
			expect(text).toContain("£12.50");
		}
		// Only Grace is offered to change it.
		expect(await textAt(graces, grace)).toContain("Change");
		expect(await textAt(graces, mona)).not.toContain("Change");

		expect((await open(graces, bob)).status).toBe(404);
		expect((await open(`${EXPENSES}?person=${bob.user.id}`, grace)).status).toBe(404);
	});
});

describe("Approvals", () => {
	it("shows each submitted week's expenses with its time", async () => {
		const { mona, grace, apex, travel } = await seed();
		await record(grace, {
			spentOn: "2026-11-10",
			projectId: apex.id,
			categoryId: travel,
			amount: "12.50",
			billable: "on",
		});
		await ask(grace, { intent: "submit", startsOn: WEEK });
		const text = await textAt(`${APPROVALS}?week=${WEEK}`, mona);
		expect(text).toContain("Expenses: £12.50, £12.50 billable");
	});
});

describe("the Expenses view of Reports", () => {
	it("totals by category, project and person, billable and to pay back, and exports each expense", async () => {
		const { grace, bob, apex, kyoto, travel, mileage } = await seed();
		await record(grace, {
			spentOn: "2026-11-10",
			projectId: apex.id,
			categoryId: travel,
			amount: "12.50",
			billable: "on",
			reimbursable: "on",
		});
		await record(bob, {
			spentOn: "2026-11-11",
			projectId: apex.id,
			categoryId: mileage,
			quantity: "10",
		});
		await record(bob, {
			spentOn: "2026-11-11",
			projectId: kyoto.id,
			categoryId: travel,
			amount: "900",
		});

		const byCategory = await textAt(`${REPORT}?range=this-week&group=category`, ada);
		expect(byCategory).toContain("By category");
		expect(byCategory).toMatch(/Mileage .*£4\.50/);
		expect(byCategory).toContain("£12.50 + JP¥900");
		expect(byCategory).toContain("Billable £12.50");
		expect(byCategory).toContain("To pay back £12.50");
		expect(byCategory).toContain("£17.00 + JP¥900");

		const byPerson = await textAt(`${REPORT}?range=this-week&group=person`, ada);
		expect(byPerson).toContain("By person");
		expect(byPerson).toContain("grace@example.com");

		// Bob sees his own alone.
		const bobs = await textAt(`${REPORT}?range=this-week&group=project`, bob);
		expect(bobs).not.toContain("£12.50");
		expect(bobs).toContain("£4.50");

		const file = await open(`${REPORT}/export?range=this-week&group=category`, ada);
		expect(file.status).toBe(200);
		expect(file.headers.get("Content-Type")).toContain("text/csv");
		const lines = (await file.text()).trim().split("\r\n");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("Expense ID,Date,Person,Project,Client,Category");
		expect(lines.find((line) => line.includes("Travel") && line.includes("GBP"))).toContain(
			"12.50,GBP,Yes,Yes,No",
		);
		expect(lines.find((line) => line.includes("Mileage"))).toContain("10,mile,0.45,4.50,GBP");

		expect((await open(`${REPORT}?group=tag`, ada)).status).toBe(400);
	});
});
