import { env } from "cloudflare:workers";
import { inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { useState } from "react";
import { Link, redirect } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { users } from "~/db";
import { BillingTabs } from "~/invoices/BillingTabs";
import { billingOf } from "~/invoices/context.server";
import { LineFieldsInSheet, NEW_LINE, PrintedSheet } from "~/invoices/DocumentParts";
import { sendInvoice } from "~/invoices/deliver.server";
import { percentField, percentText } from "~/invoices/documents.server";
import {
	addLine,
	changeDraft,
	changeLine,
	deleteDraft,
	deleteLine,
	deletePayment,
	issueInvoice,
	type Result,
	recordPayment,
	voidInvoice,
} from "~/invoices/invoices.server";
import { LineFields, NO_TAX, parseLine } from "~/invoices/line-input";
import { quantityText } from "~/invoices/lines";
import { addContact, contactsOf, EMAIL_ADDRESS } from "~/invoices/mail.server";
import { invoicePdfPath, invoicesPath } from "~/invoices/paths";
import { drawFromRetainer, retainersFor } from "~/invoices/retainers.server";
import { STATE_LABELS } from "~/invoices/status";
import { historyOf, invoiceView } from "~/invoices/view.server";
import { parseRequest } from "~/lib/validate";
import { formatMoney } from "~/money/money";
import { moneyText, parseMoney, parsePercent } from "~/money/typed";
import { notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { Day } from "~/time/calendar";
import { formatDay, formatDayAndTime } from "~/time/format";

import type { Route } from "./+types/invoices.$invoice";
import { FormSheet } from "./FormSheet";

// One invoice (TS-073, TS-074): the document as its PDF prints it, and what
// can be done with it in its state. A draft's details and lines change, and it
// is issued or sent; an issued invoice's lines are fixed, and it is paid,
// written off, drawn from a retainer, sent again, or voided. Every action is
// recorded on its history, shown below it.

export function meta({ loaderData }: Route.MetaArgs) {
	return [{ title: `Invoice ${loaderData?.invoice.number ?? ""} · Timesifier` }];
}

const PAYMENT_METHODS = [
	{ id: "bank_transfer", label: "Bank transfer" },
	{ id: "card", label: "Card" },
	{ id: "cash", label: "Cash" },
	{ id: "cheque", label: "Cheque" },
	{ id: "other", label: "Other" },
] as const;

/** What the history says each action was. */
const HISTORY_WORDS: Record<string, string> = {
	"invoice.created": "Created",
	"invoice.updated": "Changed",
	"invoice.sent": "Sent",
	"invoice.voided": "Voided",
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
	const { scope, organisation, today, locale } = await billingOf(context, request);
	const view = await invoiceView(scope, organisation.name, params.invoice, { locale, today });
	if (!view) throw notFound();
	const { invoice } = view;
	const [taxes, contacts, retainers, history] = await Promise.all([
		scope.taxes.select((t) => isNull(t.archivedAt)),
		contactsOf(scope, invoice.clientId),
		retainersFor(scope, invoice.id),
		historyOf(scope, invoice.id),
	]);
	const actorIds = [...new Set(history.flatMap((h) => (h.actorId ? [h.actorId] : [])))];
	const actors =
		actorIds.length === 0
			? []
			: await drizzle(env.DB)
					.select({ id: users.id, name: users.name })
					.from(users)
					.where(inArray(users.id, actorIds));
	const actorName = new Map(actors.map((a) => [a.id, a.name]));
	const money = (minor: number) => formatMoney(minor, invoice.currency, locale);
	return {
		slug: organisation.slug,
		invoice: {
			id: invoice.id,
			number: invoice.number,
			status: invoice.status,
			state: view.state,
			stateLabel: STATE_LABELS[view.state],
			client: view.clientName,
			currency: invoice.currency,
			issuedOn: invoice.issuedOn,
			dueOn: invoice.dueOn,
			poNumber: invoice.poNumber ?? "",
			subject: invoice.subject ?? "",
			notes: invoice.notes ?? "",
			discount: percentField(invoice.discountBasisPoints),
			isFunds: invoice.retainerId !== null,
			total: money(invoice.totalMinor),
			balance: money(view.balanceMinor),
			balanceText: moneyText(view.balanceMinor, invoice.currency),
			owed:
				view.balanceMinor > 0 && (invoice.status === "sent" || invoice.status === "partially_paid"),
		},
		printed: view.printed,
		lines: view.lines.map((line) => ({
			id: line.id,
			description: line.description,
			quantity: quantityText(line.quantityMilli),
			unitPrice: moneyText(line.unitPriceMinor, invoice.currency),
			tax: line.taxId ?? NO_TAX,
			secondTax: line.secondTaxId ?? NO_TAX,
			fromTracked: line.kind === "time" || line.kind === "expense",
		})),
		taxes: taxes.map((t) => ({ id: t.id, label: `${t.name} (${percentText(t.rateBasisPoints)})` })),
		payments: view.payments.map((p) => ({
			id: p.id,
			title:
				p.kind === "write_off"
					? "Written off"
					: (PAYMENT_METHODS.find((m) => m.id === p.method)?.label ?? "Payment"),
			detail: [formatDay(p.paidOn), p.note].filter(Boolean).join(" · "),
			amount: money(p.amountMinor),
		})),
		contacts: contacts.map((c) => ({
			id: c.id,
			label: c.name ? `${c.name} (${c.email})` : c.email,
			email: c.email,
		})),
		retainers: retainers.map((r) => ({
			id: r.id,
			label: `${formatMoney(r.balanceMinor, r.currency, locale)} held`,
			balanceMinor: r.balanceMinor,
		})),
		history: history.map((h) => ({
			id: h.id,
			what:
				h.action === "invoice.sent" && h.summary.after?.reminder === true
					? "Reminder sent"
					: h.action === "invoice.updated" && h.summary.after?.status === "open"
						? "Issued"
						: (HISTORY_WORDS[h.action] ?? h.action),
			who: h.actorId ? (actorName.get(h.actorId) ?? "Someone") : "Timesifier",
			when: formatDayAndTime(h.createdAt.getTime(), organisation.timeZone),
			recipients:
				typeof h.summary.after?.recipients === "number" ? h.summary.after.recipients : null,
		})),
		today,
	};
}

const Id = z.string().min(1).max(64);
const Text = z.string().max(2000);

/** The things this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("details"),
		issuedOn: Day,
		dueOn: Day,
		poNumber: z.string().max(100),
		subject: z.string().max(200),
		notes: Text,
		discount: z.string().max(10),
	}),
	z.object({ intent: z.literal("add-line"), ...LineFields }),
	z.object({ intent: z.literal("change-line"), lineId: Id, ...LineFields }),
	z.object({ intent: z.literal("delete-line"), lineId: Id }),
	z.object({ intent: z.literal("issue") }),
	z.object({
		intent: z.literal("send"),
		to: z.union([z.string().max(254), z.array(z.string().max(254)).max(20)]).optional(),
		address: z.string().max(254).optional(),
		note: z.string().max(1000).optional(),
	}),
	z.object({
		intent: z.literal("payment"),
		kind: z.enum(["payment", "write_off"]),
		amount: z.string().max(40),
		paidOn: Day,
		method: z.enum(["bank_transfer", "card", "cash", "cheque", "other"]).optional(),
		note: z.string().max(500).optional(),
	}),
	z.object({ intent: z.literal("delete-payment"), paymentId: Id }),
	z.object({ intent: z.literal("draw"), retainerId: Id, amount: z.string().max(40) }),
	z.object({ intent: z.literal("void") }),
	z.object({ intent: z.literal("delete") }),
]);

/** What the page is told: what was done, why nothing was, or 404 for something that is not here. */
function answer<T>(result: Result<T>, said: (result: { ok: true } & T) => string) {
	if (result === null) throw notFound();
	return result.ok ? done(said(result)) : declined(result.problem);
}

const optional = (text: string | undefined) => (text?.trim() ? text.trim() : null);

export async function action({ request, context, params }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const { scope, organisation, today, locale, now, membership } = await billingOf(context, request);
	const actor = membership.user.id;
	const id = params.invoice;
	const [invoice] = await scope.invoices.select((i) => inArray(i.id, [id]), { limit: 1 });
	if (!invoice) throw notFound();

	switch (input.intent) {
		case "details": {
			const discount = parsePercent(input.discount || "0");
			if (discount === null) return declined("Enter a discount from 0 to 100 per cent.");
			return answer(
				await changeDraft(scope, actor, id, {
					issuedOn: input.issuedOn,
					dueOn: input.dueOn,
					poNumber: optional(input.poNumber),
					subject: optional(input.subject),
					notes: optional(input.notes),
					discountBasisPoints: discount,
				}),
				() => "The invoice's details are saved.",
			);
		}
		case "add-line":
		case "change-line": {
			const parsed = parseLine(input, invoice.currency);
			if (!parsed.ok) return declined(parsed.problem);
			return input.intent === "add-line"
				? answer(await addLine(scope, actor, id, parsed.line), () => "Line added.")
				: answer(
						await changeLine(scope, actor, id, input.lineId, parsed.line),
						() => "Line saved.",
					);
		}
		case "delete-line":
			return answer(
				await deleteLine(scope, actor, id, input.lineId),
				() => "Line removed. What it billed for is uninvoiced again.",
			);
		case "issue":
			return answer(
				await issueInvoice(scope, actor, id),
				({ number }) => `Invoice ${number} is issued. Its lines are fixed now.`,
			);
		case "send": {
			const to = [...new Set([input.to ?? []].flat().map((each) => each.trim()))].filter(Boolean);
			const typed = optional(input.address);
			if (typed !== null) {
				if (!EMAIL_ADDRESS.test(typed))
					return declined("Enter an email address, such as accounts@example.com.");
				await addContact(scope, actor, invoice.clientId, { name: null, email: typed });
				to.push(typed);
			}
			const contacts = (await contactsOf(scope, invoice.clientId)).map((c) => c.email);
			const chosen = [...new Set(to)].filter((each) => contacts.includes(each));
			if (chosen.length === 0) return declined("Choose who to send it to, or add an address.");
			return answer(
				await sendInvoice(scope, actor, id, {
					organisationName: organisation.name,
					to: chosen,
					note: optional(input.note),
					locale,
					today,
					now: new Date(now),
				}),
				({ number }) =>
					`Invoice ${number} is sent to ${chosen.length === 1 ? chosen[0] : `${chosen.length} people`}.`,
			);
		}
		case "payment": {
			const amountMinor = parseMoney(input.amount, invoice.currency);
			if (amountMinor === null || amountMinor === 0)
				return declined("Enter an amount above 0, such as 250.00.");
			return answer(
				await recordPayment(
					scope,
					actor,
					id,
					{
						kind: input.kind,
						amountMinor,
						paidOn: input.paidOn,
						method: input.kind === "payment" ? (input.method ?? null) : null,
						note: optional(input.note),
					},
					today,
				),
				() =>
					input.kind === "write_off"
						? `${formatMoney(amountMinor, invoice.currency, locale)} written off.`
						: `Payment of ${formatMoney(amountMinor, invoice.currency, locale)} recorded.`,
			);
		}
		case "delete-payment":
			return answer(
				await deletePayment(scope, actor, id, input.paymentId, today),
				() => "Payment deleted. Its amount is owed again.",
			);
		case "draw": {
			const amountMinor = parseMoney(input.amount, invoice.currency);
			if (amountMinor === null || amountMinor === 0) return declined("Enter an amount above 0.");
			return answer(
				await drawFromRetainer(scope, actor, id, input.retainerId, amountMinor, today),
				() => `${formatMoney(amountMinor, invoice.currency, locale)} paid from the retainer.`,
			);
		}
		case "void":
			return answer(
				await voidInvoice(scope, actor, id, new Date(now)),
				({ number }) => `Invoice ${number} is void. Its time and expenses can be invoiced again.`,
			);
		case "delete": {
			const result = await deleteDraft(scope, actor, id);
			if (result === null) throw notFound();
			if (!result.ok) return declined(result.problem);
			return redirect(`${invoicesPath(organisation.slug)}?show=draft`);
		}
	}
}

/** The sheets of this page. One is open at a time. */
type Task =
	| "details"
	| "add-line"
	| "change-line"
	| "delete-line"
	| "issue"
	| "send"
	| "payment"
	| "write-off"
	| "delete-payment"
	| "draw"
	| "void"
	| "delete";

export default function Invoice({ loaderData }: Route.ComponentProps) {
	const { slug, invoice, printed, lines, taxes, payments, contacts, retainers, history, today } =
		loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [chosen, setChosen] = useState<string | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const open = (next: Task, id: string | null = null) => {
		setChosen(id);
		setTask(next);
	};
	const isDraft = invoice.status === "draft";
	const isVoid = invoice.status === "void";
	const line = lines.find((each) => each.id === chosen);
	const payment = payments.find((each) => each.id === chosen);

	// The one filled action of the page: send a draft, take a payment on an open one.
	const primary = isDraft ? (
		<Button onPress={() => open("send")}>Send invoice</Button>
	) : invoice.owed ? (
		<Button onPress={() => open("payment")}>Record payment</Button>
	) : null;

	return (
		<>
			<PageHeading>Invoice {invoice.number}</PageHeading>
			<PageLead>
				{invoice.client} · {invoice.stateLabel} · {invoice.total}
				{!isDraft && !isVoid && ` · ${invoice.balance} owed`}
			</PageLead>
			<BillingTabs slug={slug} current="invoices" />
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<div className="mt-8 flex max-w-200 flex-wrap items-center gap-4">
				{primary}
				<a href={invoicePdfPath(slug, invoice.id)} download className={ACTION_LINK}>
					Download PDF
				</a>
				<MenuTrigger>
					<Button variant="outlined" aria-label={`More actions for invoice ${invoice.number}`}>
						More
					</Button>
					<Menu onAction={(id) => open(id as Task)}>
						{isDraft ? (
							<>
								<MenuItem id="details">Edit details</MenuItem>
								<MenuItem id="add-line">Add a line</MenuItem>
								<MenuItem id="issue">Issue without sending</MenuItem>
								<MenuItem id="delete">Delete draft</MenuItem>
							</>
						) : (
							<>
								{!isVoid && <MenuItem id="send">Send again</MenuItem>}
								{invoice.owed && <MenuItem id="write-off">Write off</MenuItem>}
								{invoice.owed && retainers.length > 0 && (
									<MenuItem id="draw">Pay from retainer</MenuItem>
								)}
								{!isVoid && <MenuItem id="void">Void</MenuItem>}
							</>
						)}
					</Menu>
				</MenuTrigger>
				<Link to={invoicesPath(slug)} className={ACTION_LINK}>
					All invoices
				</Link>
			</div>

			<Section id="document" heading={invoice.stateLabel}>
				<PrintedSheet
					printed={printed}
					lineAction={
						isDraft
							? (index) => {
									const each = lines[index];
									if (!each) return null;
									return (
										<MenuTrigger>
											<Button variant="text" aria-label={`Actions for ${each.description}`}>
												Actions
											</Button>
											<Menu onAction={(id) => open(id as Task, each.id)}>
												<MenuItem id="change-line">Edit</MenuItem>
												<MenuItem id="delete-line">Remove</MenuItem>
											</Menu>
										</MenuTrigger>
									);
								}
							: undefined
					}
				/>
			</Section>

			{!isDraft && (
				<Section
					id="payments"
					heading="Payments"
					lead="Payments and write-offs recorded against it."
				>
					<div className="max-w-200">
						<Ledger heading="Payments" note={payments.length}>
							{payments.length === 0 ? (
								<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
									Nothing has been paid yet.
								</p>
							) : (
								<LedgerRows label="Payments">
									{payments.map((each) => (
										<LedgerRow
											key={each.id}
											title={each.title}
											detail={<span className="wrap-anywhere">{each.detail}</span>}
											value={each.amount}
											action={
												<Button
													variant="text"
													onPress={() => open("delete-payment", each.id)}
													aria-label={`Delete ${each.title.toLowerCase()} of ${each.amount}`}
												>
													Delete
												</Button>
											}
										/>
									))}
								</LedgerRows>
							)}
						</Ledger>
					</div>
				</Section>
			)}

			<Section id="history" heading="History" lead="Everything done to this invoice, newest first.">
				<div className="max-w-200">
					<Ledger heading="History" note={history.length}>
						<LedgerRows label="History">
							{history.map((each) => (
								<LedgerRow
									key={each.id}
									title={
										each.recipients === null
											? each.what
											: `${each.what} to ${each.recipients} ${each.recipients === 1 ? "person" : "people"}`
									}
									detail={each.who}
									aside={each.when}
								/>
							))}
						</LedgerRows>
					</Ledger>
				</div>
			</Section>

			<FormSheet
				title="Edit the invoice's details"
				intent="details"
				submitLabel="Save"
				isOpen={task === "details"}
				onClose={close}
				onDone={setSaid}
			>
				<div className="grid grid-cols-2 gap-4">
					<TextField
						label="Issue date"
						name="issuedOn"
						type="date"
						defaultValue={invoice.issuedOn}
						isRequired
					/>
					<TextField
						label="Due date"
						name="dueOn"
						type="date"
						defaultValue={invoice.dueOn}
						isRequired
					/>
				</div>
				<TextField
					label="PO number"
					name="poNumber"
					defaultValue={invoice.poNumber}
					maxLength={100}
				/>
				<TextField label="Subject" name="subject" defaultValue={invoice.subject} maxLength={200} />
				<TextField
					label="Discount (%)"
					name="discount"
					inputMode="decimal"
					defaultValue={invoice.discount}
					description="Taken off the subtotal before tax."
				/>
				<TextField label="Notes" name="notes" defaultValue={invoice.notes} maxLength={2000} />
			</FormSheet>

			<FormSheet
				title="Add a line"
				intent="add-line"
				submitLabel="Add the line"
				isOpen={task === "add-line"}
				onClose={close}
				onDone={setSaid}
			>
				<p>A free line changes the total, and puts no tracked time on the invoice.</p>
				<LineFieldsInSheet defaults={NEW_LINE} taxes={taxes} currency={invoice.currency} />
			</FormSheet>

			<FormSheet
				title="Edit the line"
				intent="change-line"
				submitLabel="Save"
				isOpen={task === "change-line"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="lineId" value={line?.id ?? ""} />
				{line?.fromTracked && <p>The time and expenses it bills for stay on it.</p>}
				{line && (
					<LineFieldsInSheet
						key={line.id}
						defaults={line}
						taxes={taxes}
						currency={invoice.currency}
					/>
				)}
			</FormSheet>

			<FormSheet
				title="Remove the line?"
				intent="delete-line"
				submitLabel="Remove line"
				isOpen={task === "delete-line"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="lineId" value={line?.id ?? ""} />
				<p>
					{line?.fromTracked
						? "The time and expenses it billed for go back to uninvoiced."
						: "It comes off the total."}
				</p>
			</FormSheet>

			<FormSheet
				title={`Issue invoice ${invoice.number}?`}
				intent="issue"
				submitLabel="Issue invoice"
				isOpen={task === "issue"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					Its number, dates and lines are fixed from now on. It can be paid, written off or voided,
					but not edited. Nothing is emailed.
				</p>
			</FormSheet>

			<FormSheet
				title={isDraft ? `Send invoice ${invoice.number}` : `Send invoice ${invoice.number} again`}
				intent="send"
				submitLabel="Send"
				isOpen={task === "send"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					{isDraft
						? "Sending issues it: its lines are fixed from now on. Each person gets it as a PDF."
						: "Each person gets it as a PDF."}
				</p>
				{contacts.length > 0 && (
					<fieldset className="flex flex-col gap-1">
						<legend className="text-title-small">To {invoice.client}'s billing contacts</legend>
						{contacts.map((contact) => (
							<Checkbox key={contact.id} name="to" value={contact.email} defaultSelected>
								{contact.label}
							</Checkbox>
						))}
					</fieldset>
				)}
				<TextField
					label={contacts.length > 0 ? "Another address" : "Email address"}
					name="address"
					type="email"
					autoComplete="off"
					description={`Kept as a billing contact of ${invoice.client}.`}
					isRequired={contacts.length === 0}
				/>
				<TextField label="A note to go with it" name="note" maxLength={1000} />
			</FormSheet>

			<FormSheet
				title="Record a payment"
				intent="payment"
				submitLabel="Record payment"
				isOpen={task === "payment"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="kind" value="payment" />
				<p>{invoice.balance} is owed.</p>
				<div className="grid grid-cols-2 gap-4">
					<TextField
						label={`Amount (${invoice.currency})`}
						name="amount"
						inputMode="decimal"
						defaultValue={invoice.balanceText}
						isRequired
					/>
					<TextField label="Paid on" name="paidOn" type="date" defaultValue={today} isRequired />
				</div>
				<Select
					label="How it was paid"
					name="method"
					options={PAYMENT_METHODS.map((m) => ({ id: m.id, label: m.label }))}
					defaultValue="bank_transfer"
				/>
				<TextField label="Note" name="note" maxLength={500} />
			</FormSheet>

			<FormSheet
				title="Write off"
				intent="payment"
				submitLabel="Write off"
				isOpen={task === "write-off"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="kind" value="write_off" />
				<p>
					What you no longer expect to be paid. {invoice.balance} is owed; write off part of it or
					all.
				</p>
				<div className="grid grid-cols-2 gap-4">
					<TextField
						label={`Amount (${invoice.currency})`}
						name="amount"
						inputMode="decimal"
						defaultValue={invoice.balanceText}
						isRequired
					/>
					<TextField label="On" name="paidOn" type="date" defaultValue={today} isRequired />
				</div>
				<TextField label="Why" name="note" maxLength={500} />
			</FormSheet>

			<FormSheet
				title="Delete the payment?"
				intent="delete-payment"
				submitLabel="Delete payment"
				isOpen={task === "delete-payment"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="paymentId" value={payment?.id ?? ""} />
				<p>
					{payment ? `${payment.title}, ${payment.amount}.` : ""} Its amount is owed on the invoice
					again.
				</p>
			</FormSheet>

			<FormSheet
				title="Pay from a retainer"
				intent="draw"
				submitLabel="Pay from retainer"
				isOpen={task === "draw"}
				onClose={close}
				onDone={setSaid}
			>
				<Select
					label="Retainer"
					name="retainerId"
					options={retainers.map((r) => ({ id: r.id, label: r.label }))}
					defaultValue={retainers[0]?.id ?? null}
				/>
				<TextField
					label={`Amount (${invoice.currency})`}
					name="amount"
					inputMode="decimal"
					defaultValue={invoice.balanceText}
					description="At most what the retainer holds and what the invoice owes."
					isRequired
				/>
			</FormSheet>

			<FormSheet
				title={`Void invoice ${invoice.number}?`}
				intent="void"
				submitLabel="Void invoice"
				isOpen={task === "void"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					It keeps its number and is marked void. The time and expenses on it can be invoiced again.
				</p>
			</FormSheet>

			<FormSheet
				title={`Delete draft ${invoice.number}?`}
				intent="delete"
				submitLabel="Delete draft"
				isOpen={task === "delete"}
				onClose={close}
			>
				<p>The time and expenses on it go back to uninvoiced. Its number is not used again.</p>
			</FormSheet>
		</>
	);
}
