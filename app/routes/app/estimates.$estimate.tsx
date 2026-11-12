import { eq } from "drizzle-orm";
import { Link, redirect } from "react-router";
import * as z from "zod";

import { Checkbox } from "~/components/Checkbox";
import { TextField } from "~/components/TextField";
import {
	addEstimateLine,
	changeEstimate,
	deleteEstimate,
	ESTIMATE_LABELS,
	EstimateStatus,
	estimateLinesOf,
	estimateSentStatement,
	estimateToken,
	findEstimate,
	invoiceEstimate,
	printedEstimate,
	projectFromEstimate,
	recordDecision,
	removeEstimateLine,
	revertDecision,
} from "~/estimates/estimates.server";
import { ActionForm, LineFields } from "~/invoices/ActionForm";
import { billingOf } from "~/invoices/context.server";
import { PrintedSheet } from "~/invoices/DocumentParts";
import { percentField, percentText, taxesOf } from "~/invoices/documents.server";
import { lineRefusal, outcomeOf, readForm, refuse } from "~/invoices/form.server";
import { LineFields as LineFieldSchema, parseLine } from "~/invoices/line-input";
import { addContact, contactsOf, EMAIL_ADDRESS, sendDocument } from "~/invoices/mail.server";
import { estimateLinkPath, estimatePdfPath, estimatesPath, invoicePath } from "~/invoices/paths";
import { parsePercent } from "~/money/typed";
import { notFound } from "~/organisations/membership.server";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { Day } from "~/time/calendar";
import { formatDayAndTime } from "~/time/format";

import type { Route } from "./+types/estimates.$estimate";

// An estimate (TS-077): its lines and details while undecided, sending it
// with its PDF and the link where the client accepts or declines, recording
// a decision the client gave some other way or taking one back, and making an
// accepted estimate an invoice or a fixed-fee project.

export function meta({ loaderData }: Route.MetaArgs) {
	return [{ title: `Estimate ${loaderData?.estimate.number ?? ""} · Timesifier` }];
}

const Id = z.string().min(1).max(64);
const Optional = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Use up to ${max} characters.`)
		.transform((value) => (value === "" ? null : value));

const Form = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("details"),
		issuedOn: Day,
		poNumber: Optional(100),
		subject: Optional(200),
		notes: Optional(2000),
		discount: z
			.string()
			.trim()
			.refine(
				(value) => value === "" || parsePercent(value) !== null,
				"Enter a discount from 0 to 100 per cent.",
			)
			.transform((value) => parsePercent(value || "0") ?? 0),
	}),
	z.object({ intent: z.literal("add-line"), ...LineFieldSchema }),
	z.object({ intent: z.literal("remove-line"), lineId: Id }),
	z.object({
		intent: z.literal("add-contact"),
		email: z
			.string()
			.trim()
			.max(254)
			.regex(EMAIL_ADDRESS, "Enter an email address, such as accounts@example.com."),
		name: Optional(200),
	}),
	z.object({
		intent: z.literal("send"),
		to: z.union([z.string().max(254), z.array(z.string().max(254)).max(20)]).optional(),
		note: Optional(1000),
	}),
	z.object({ intent: z.literal("decide"), decision: z.enum(["accepted", "declined"]) }),
	z.object({ intent: z.literal("revert") }),
	z.object({ intent: z.literal("invoice") }),
	z.object({ intent: z.literal("project") }),
	z.object({ intent: z.literal("delete") }),
]);

export async function loader({ request, context, params }: Route.LoaderArgs) {
	const { scope, organisation, locale } = await billingOf(context, request);
	const estimate = await findEstimate(scope, params.estimate);
	if (!estimate) throw notFound();
	const [printed, lines, taxes, contacts, [client]] = await Promise.all([
		printedEstimate(scope, organisation.name, estimate, locale),
		estimateLinesOf(scope, estimate.id),
		taxesOf(scope),
		contactsOf(scope, estimate.clientId),
		scope.clients.select((c) => eq(c.id, estimate.clientId), { limit: 1 }),
	]);
	const open = estimate.status === "draft" || estimate.status === "sent";
	return {
		slug: organisation.slug,
		estimate: {
			id: estimate.id,
			number: estimate.number,
			status: estimate.status,
			label: ESTIMATE_LABELS[EstimateStatus.parse(estimate.status)],
			currency: estimate.currency,
			issuedOn: estimate.issuedOn,
			poNumber: estimate.poNumber ?? "",
			subject: estimate.subject ?? "",
			notes: estimate.notes ?? "",
			discount: percentField(estimate.discountBasisPoints),
			invoice: estimate.invoiceId ? invoicePath(organisation.slug, estimate.invoiceId) : null,
			sentAt: estimate.sentAt
				? formatDayAndTime(estimate.sentAt.getTime(), organisation.timeZone)
				: null,
			decidedAt: estimate.decidedAt
				? formatDayAndTime(estimate.decidedAt.getTime(), organisation.timeZone)
				: null,
			open,
		},
		clientName: client?.name ?? "",
		printed,
		lines: lines.map((line) => ({ id: line.id, description: line.description })),
		taxes: taxes
			.filter((tax) => tax.archivedAt === null)
			.map((tax) => ({ id: tax.id, label: `${tax.name} (${percentText(tax.rateBasisPoints)})` })),
		contacts: contacts.map((c) => ({ email: c.email, name: c.name })),
		pdf: estimatePdfPath(organisation.slug, estimate.id),
	};
}

export async function action({ request, context, params }: Route.ActionArgs) {
	const { scope, organisation, membership, locale, today, now } = await billingOf(context, request);
	const form = await readForm(request, Form);
	if ("refusal" in form) return form.refusal;
	const { input } = form;
	const actor = membership.user.id;
	const id = params.estimate;
	const estimate = await findEstimate(scope, id);
	if (!estimate) throw notFound();

	switch (input.intent) {
		case "details": {
			const { intent: _, discount, ...details } = input;
			return outcomeOf(
				await changeEstimate(scope, actor, id, { ...details, discountBasisPoints: discount }),
				() => "The estimate's details are saved.",
			);
		}
		case "add-line": {
			const parsed = parseLine(input, estimate.currency);
			if (!parsed.ok) return lineRefusal(parsed.problem);
			return outcomeOf(await addEstimateLine(scope, actor, id, parsed.line), () => "Line added.");
		}
		case "remove-line":
			return outcomeOf(
				await removeEstimateLine(scope, actor, id, input.lineId),
				() => "Line removed.",
			);
		case "add-contact": {
			const added = await addContact(scope, actor, estimate.clientId, {
				name: input.name,
				email: input.email,
			});
			return added
				? { ok: true as const, said: `${input.email} added.` }
				: refuse("That address is one of the client's already.", {
						email: ["That address is one of the client's already."],
					});
		}
		case "send": {
			const contacts = (await contactsOf(scope, estimate.clientId)).map((c) => c.email);
			const chosen = [...new Set([input.to ?? []].flat().map((each) => each.trim()))].filter(
				(each) => contacts.includes(each),
			);
			if (chosen.length === 0) {
				return refuse("Choose who to send it to.", { to: ["Choose who to send it to."] });
			}
			if (estimate.status === "accepted" || estimate.status === "declined") {
				return refuse("That estimate has been decided. Revert the decision to send it again.");
			}
			const [clients, printed, token] = await Promise.all([
				scope.clients.select(),
				printedEstimate(scope, organisation.name, estimate, locale),
				estimateToken(id),
			]);
			const total = printed.totals.find(([label]) => label.startsWith("Total"))?.[1] ?? "";
			const sent = await sendDocument(
				scope,
				actor,
				{ type: "estimate", id },
				chosen,
				{
					kind: "estimate",
					organisationName: organisation.name,
					clientName: clients.find((c) => c.id === estimate.clientId)?.name ?? "",
					number: estimate.number,
					amount: total,
					note: input.note,
					link: new URL(estimateLinkPath(id, token), request.url).href,
				},
				printed,
				"web",
				[estimateSentStatement(scope, id, new Date(now))],
			);
			if (!sent.ok) return refuse(sent.problem, {}, 429);
			return {
				ok: true as const,
				said: `Estimate ${estimate.number} is sent to ${chosen.length === 1 ? chosen[0] : `${chosen.length} people`}.`,
			};
		}
		case "decide":
			return outcomeOf(
				await recordDecision(scope, actor, id, input.decision, new Date(now)),
				() => `Estimate ${estimate.number} is ${input.decision}.`,
			);
		case "revert":
			return outcomeOf(
				await revertDecision(scope, actor, id),
				() => "The decision is taken back. The estimate is sent and undecided.",
			);
		case "invoice": {
			const made = await invoiceEstimate(scope, actor, id, today);
			if (made === null) throw notFound();
			if (!made.ok) return refuse(made.problem);
			return redirect(invoicePath(organisation.slug, made.id));
		}
		case "project":
			return outcomeOf(
				await projectFromEstimate(scope, actor, id),
				({ name }) => `Project ${name} is started with the estimate's fee.`,
			);
		case "delete": {
			const deleted = await deleteEstimate(scope, actor, id);
			if (deleted === null) throw notFound();
			if (!deleted.ok) return refuse(deleted.problem);
			return redirect(estimatesPath(organisation.slug));
		}
	}
}

export default function EstimatePage({ loaderData }: Route.ComponentProps) {
	const { estimate, printed, lines, taxes, contacts } = loaderData;
	return (
		<>
			<p>
				<Link to={estimatesPath(loaderData.slug)} className={ACTION_LINK}>
					Estimates
				</Link>
			</p>
			<PageHeading>Estimate {estimate.number}</PageHeading>
			<PageLead>
				For {loaderData.clientName}. {estimate.label}
				{estimate.sentAt && estimate.status === "sent" ? `, sent ${estimate.sentAt}` : ""}
				{estimate.decidedAt ? ` ${estimate.decidedAt}` : ""}.
			</PageLead>
			<p className="mt-4">
				<a href={loaderData.pdf} className={ACTION_LINK} download>
					Download PDF
				</a>
			</p>

			<Section id="document" heading={estimate.label}>
				<PrintedSheet
					printed={printed}
					lineAction={
						estimate.open
							? (index) => {
									const line = lines[index];
									if (!line) return null;
									return (
										<ActionForm
											intent="remove-line"
											hidden={{ lineId: line.id }}
											variant="text"
											submitLabel="Remove"
											submitName={`Remove ${line.description}`}
										/>
									);
								}
							: undefined
					}
				/>
			</Section>

			{estimate.open && (
				<>
					<Section id="add-line" heading="Add a line">
						<ActionForm intent="add-line" submitLabel="Add line" className="mt-4 max-w-120">
							{(field) => <LineFields field={field} taxes={taxes} currency={estimate.currency} />}
						</ActionForm>
					</Section>

					<Section id="details" heading="Details">
						<ActionForm intent="details" submitLabel="Save details" className="mt-4 max-w-120">
							{(field) => (
								<>
									<TextField
										label="Issue date"
										type="date"
										isRequired
										defaultValue={estimate.issuedOn}
										{...field("issuedOn")}
									/>
									<TextField
										label="PO number"
										defaultValue={estimate.poNumber}
										{...field("poNumber")}
									/>
									<TextField
										label="Subject"
										defaultValue={estimate.subject}
										{...field("subject")}
									/>
									<TextField label="Notes" defaultValue={estimate.notes} {...field("notes")} />
									<TextField
										label="Discount (%)"
										inputMode="decimal"
										defaultValue={estimate.discount}
										{...field("discount")}
									/>
								</>
							)}
						</ActionForm>
					</Section>

					<Section id="send" heading="Send">
						<p className="mt-2 max-w-120 text-body-medium text-on-surface-variant">
							Each address gets the PDF and a link where the client accepts or declines it, once.
						</p>
						{contacts.length > 0 && (
							<ActionForm intent="send" submitLabel="Send estimate" className="mt-4 max-w-120">
								{(field) => (
									<>
										<fieldset className="flex flex-col gap-1">
											<legend className="text-title-small">To</legend>
											{contacts.map((contact) => (
												<Checkbox key={contact.email} name="to" value={contact.email}>
													{contact.name ? `${contact.name} <${contact.email}>` : contact.email}
												</Checkbox>
											))}
											{field("to").errorMessage && (
												<p className="text-body-small text-error">{field("to").errorMessage}</p>
											)}
										</fieldset>
										<TextField label="Note" {...field("note")} />
									</>
								)}
							</ActionForm>
						)}
						<ActionForm
							intent="add-contact"
							submitLabel="Add address"
							variant="outlined"
							className="mt-6 max-w-120"
						>
							{(field) => (
								<>
									<TextField label="Email address" type="email" isRequired {...field("email")} />
									<TextField label="Name" {...field("name")} />
								</>
							)}
						</ActionForm>
					</Section>
				</>
			)}

			<Section id="decision" heading="Decision">
				<div className="mt-4 flex flex-wrap gap-4">
					{estimate.open && (
						<>
							<ActionForm
								intent="decide"
								hidden={{ decision: "accepted" }}
								submitLabel="Record accepted"
								variant="outlined"
							/>
							<ActionForm
								intent="decide"
								hidden={{ decision: "declined" }}
								submitLabel="Record declined"
								variant="outlined"
							/>
						</>
					)}
					{!estimate.open && !estimate.invoice && (
						<ActionForm intent="revert" submitLabel="Revert decision" variant="outlined" />
					)}
					{estimate.status === "accepted" &&
						(estimate.invoice ? (
							<Link to={estimate.invoice} className={ACTION_LINK}>
								Open its invoice
							</Link>
						) : (
							<ActionForm intent="invoice" submitLabel="Make invoice" />
						))}
					{estimate.status === "accepted" && (
						<ActionForm intent="project" submitLabel="Start fixed-fee project" variant="outlined" />
					)}
				</div>
			</Section>

			{!estimate.invoice && (
				<Section id="delete" heading="Delete">
					<ActionForm
						intent="delete"
						submitLabel="Delete estimate"
						variant="outlined-danger"
						className="mt-4"
					/>
				</Section>
			)}
		</>
	);
}
