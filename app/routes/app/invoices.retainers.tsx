import { asc, inArray, isNull } from "drizzle-orm";
import { Link, redirect } from "react-router";
import * as z from "zod";

import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { ActionForm } from "~/invoices/ActionForm";
import { BillingTabs } from "~/invoices/BillingTabs";
import { billingOf } from "~/invoices/context.server";
import { readForm, refuse } from "~/invoices/form.server";
import { invoicePath } from "~/invoices/paths";
import { invoiceFunds, openRetainer, retainersOf } from "~/invoices/retainers.server";
import { CurrencyCode, formatMoney } from "~/money/money";
import { parseMoney } from "~/money/typed";
import { notFound } from "~/organisations/membership.server";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { formatDay } from "~/time/format";

import type { Route } from "./+types/invoices.retainers";

// Retainers (TS-078): money a client pays ahead and the organisation holds
// for them, for all their work or one project. A funds invoice adds to the
// balance once it is paid; an invoice's page draws from it. Each retainer's
// history is its deposits and draws.

export function meta() {
	return [{ title: "Retainers · Timesifier" }];
}

/** The value of the project field for a retainer that covers all the client's work. */
const ALL_WORK = "all";
const Id = z.string().min(1).max(64);

const Form = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("open"),
		clientId: z.string().min(1, "Choose a client.").max(64),
		projectId: Id,
		currency: z.string().trim().toUpperCase().pipe(CurrencyCode),
	}),
	z.object({
		intent: z.literal("funds"),
		retainerId: Id,
		amount: z.string().trim().min(1, "Enter an amount, such as 2000.00.").max(40),
	}),
]);

export async function loader({ request, context }: Route.LoaderArgs) {
	const { scope, organisation, locale } = await billingOf(context, request);
	const [retainers, clients, projects] = await Promise.all([
		retainersOf(scope),
		scope.clients.select((c) => isNull(c.archivedAt), { orderBy: (c) => [asc(c.name)] }),
		scope.projects.select((p) => isNull(p.archivedAt), { orderBy: (p) => [asc(p.name)] }),
	]);
	const ids = retainers.map((r) => r.id);
	const movements =
		ids.length === 0
			? []
			: await scope.retainerMovements.select((m) => inArray(m.retainerId, ids), {
					orderBy: (m) => [asc(m.occurredOn), asc(m.createdAt)],
				});
	const clientName = new Map(clients.map((c) => [c.id, c.name]));
	return {
		slug: organisation.slug,
		currency: organisation.currency,
		clients: clients.map((c) => ({ id: c.id, label: c.name })),
		projects: [
			{ id: ALL_WORK, label: "All the client's work" },
			...projects
				.filter((p) => p.clientId !== null && clientName.has(p.clientId))
				.map((p) => ({ id: p.id, label: `${clientName.get(p.clientId ?? "")} · ${p.name}` })),
		],
		retainers: retainers.map((retainer) => ({
			id: retainer.id,
			name: retainer.projectName
				? `${retainer.clientName} · ${retainer.projectName}`
				: retainer.clientName,
			currency: retainer.currency,
			balance: formatMoney(retainer.balanceMinor, retainer.currency, locale),
			history: movements
				.filter((m) => m.retainerId === retainer.id)
				.reverse()
				.map((m) => ({
					id: m.id,
					title: m.kind === "deposit" ? "Funds paid in" : "Drawn for an invoice",
					detail: formatDay(m.occurredOn, "short"),
					amount: formatMoney(
						m.kind === "deposit" ? m.amountMinor : -m.amountMinor,
						retainer.currency,
						locale,
					),
					invoice: m.invoiceId ? invoicePath(organisation.slug, m.invoiceId) : null,
				})),
		})),
	};
}

export async function action({ request, context }: Route.ActionArgs) {
	const { scope, organisation, membership, today } = await billingOf(context, request);
	const form = await readForm(request, Form);
	if ("refusal" in form) return form.refusal;
	const { input } = form;
	if (input.intent === "open") {
		const opened = await openRetainer(
			scope,
			input.clientId,
			input.projectId === ALL_WORK ? null : input.projectId,
			input.currency,
		);
		if (!opened?.ok) {
			const problem = opened?.problem ?? "That retainer could not be opened.";
			return refuse(problem, { projectId: [problem] });
		}
		return { ok: true as const, said: "Retainer opened. Invoice funds into it to start." };
	}
	const [retainer] = (await retainersOf(scope)).filter((r) => r.id === input.retainerId);
	if (!retainer) throw notFound();
	const amountMinor = parseMoney(input.amount, retainer.currency);
	if (amountMinor === null || amountMinor <= 0) {
		const problem = "Enter an amount above 0, such as 2000.00.";
		return refuse(problem, { amount: [problem] });
	}
	const made = await invoiceFunds(scope, membership.user.id, retainer.id, amountMinor, today);
	if (made === null) throw notFound();
	if (!made.ok) return refuse(made.problem);
	return redirect(invoicePath(organisation.slug, made.id));
}

export default function Retainers({ loaderData }: Route.ComponentProps) {
	const { slug, retainers, clients, projects } = loaderData;
	return (
		<>
			<PageHeading>Retainers</PageHeading>
			<PageLead>Money clients pay ahead, held for their work.</PageLead>
			<BillingTabs slug={slug} current="retainers" />

			<div className="mt-8 flex max-w-200 flex-col gap-6">
				{retainers.length === 0 ? (
					<Ledger heading="Retainers" note={0}>
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							No retainers yet.
						</p>
					</Ledger>
				) : (
					retainers.map((retainer) => (
						<Ledger
							key={retainer.id}
							heading={<span className="wrap-anywhere">{retainer.name}</span>}
							note={retainer.balance}
						>
							{retainer.history.length > 0 ? (
								<LedgerRows label={`${retainer.name}'s history`}>
									{retainer.history.map((each) => (
										<LedgerRow
											key={each.id}
											title={
												each.invoice ? (
													<Link to={each.invoice} className="underline-offset-2 hover:underline">
														{each.title}
													</Link>
												) : (
													each.title
												)
											}
											detail={each.detail}
											value={each.amount}
										/>
									))}
								</LedgerRows>
							) : (
								<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
									Nothing paid in or drawn yet.
								</p>
							)}
							<LedgerTotal label="Balance" value={retainer.balance} />
							<div className="border-t border-outline-variant px-4 py-4 @sm:px-5">
								<ActionForm
									intent="funds"
									hidden={{ retainerId: retainer.id }}
									submitLabel="Invoice funds"
									variant="outlined"
									submitName={`Invoice funds into ${retainer.name}`}
								>
									{(field) => (
										<TextField
											label={`Amount (${retainer.currency})`}
											inputMode="decimal"
											isRequired
											{...field("amount")}
										/>
									)}
								</ActionForm>
							</div>
						</Ledger>
					))
				)}
			</div>

			<Section id="new-retainer" heading="New retainer">
				{clients.length === 0 ? (
					<p className="mt-4 text-body-large text-on-surface-variant">Add a client first.</p>
				) : (
					<ActionForm intent="open" submitLabel="Open retainer" className="mt-4 max-w-120">
						{(field) => (
							<>
								<Select label="Client" options={clients} isRequired {...field("clientId")} />
								<Select
									label="For"
									options={projects}
									defaultValue="all"
									isRequired
									{...field("projectId")}
								/>
								<TextField
									label="Currency"
									defaultValue={loaderData.currency}
									isRequired
									{...field("currency")}
								/>
							</>
						)}
					</ActionForm>
				)}
			</Section>
		</>
	);
}
