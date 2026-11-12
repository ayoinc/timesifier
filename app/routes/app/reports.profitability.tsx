import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { useState } from "react";
import { data } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import { formatMoney } from "~/money/money";
import { moneyText, parseMoney } from "~/money/typed";
import { isAdministrator, mayManageRates, maySeeRates } from "~/organisations/access";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { organisationMoney } from "~/projects/money.server";
import { dayLabel, hoursAndMinutes } from "~/reports/format";
import {
	personCostRates,
	profitabilityReport,
	setCostRate,
	setProjectDates,
} from "~/reports/profitability.server";
import { Headline, RangeSteps } from "~/reports/RangeSteps";
import { ReportChoice } from "~/reports/ReportChoice";
import { ReportTabs } from "~/reports/ReportTabs";
import { reportRequest } from "~/reports/reports.server";
import { SaveReport } from "~/reports/SaveReport";
import { percentLabel } from "~/reports/utilisation";
import { openedFrom, viewAction, viewFrame, viewsFor } from "~/reports/view.server";
import { destination } from "~/shell/destinations";
import { DEFAULT_LOCALE } from "~/shell/locale";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { Day } from "~/time/calendar";
import type { Route } from "./+types/reports.profitability";
import { FormSheet } from "./FormSheet";

// The Profitability view of Reports (TS-071, B6): each project's revenue,
// cost and profit for a range, with its margin, as Harvest counts them
// (app/reports/profitability.ts); and the cost rates behind it, which an
// owner, admin or Finance gives each person, from a date, in the
// organisation's currency. Only those who see rates are shown it; anyone
// else, a manager included, gets the same 404 as at any address not theirs.

const { label } = destination("reports");

export function meta() {
	return [{ title: `Profitability · ${label} · Timesifier` }];
}

const Id = z.string().min(1).max(64);

const ProfitForm = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("cost-rate"), userId: Id, amount: z.string(), effectiveFrom: Day }),
	z.object({ intent: z.literal("project-dates"), projectId: Id, startsOn: Day, endsOn: Day }),
]);

export async function action({ request, context }: Route.ActionArgs) {
	const membership = context.get(membershipContext);
	if (!maySeeRates(membership.role)) throw notFound();
	const intent = (await request.clone().formData()).get("intent");
	if (intent === "save-report" || intent === "update-saved") {
		return viewAction(request, membership, "profitability");
	}
	const input = await parseRequest(request, ProfitForm);
	const scope = organisationScope(env.DB, membership.organisation.id);
	if (input.intent === "cost-rate") {
		if (!mayManageRates(membership.role)) return declined(NOT_ALLOWED, 403);
		const [member] = await scope.memberships.select((m) => eq(m.userId, input.userId), {
			limit: 1,
		});
		if (!member) throw notFound();
		const { currency } = await organisationMoney(membership.organisation.id);
		const amountMinor = parseMoney(input.amount, currency);
		if (amountMinor === null)
			return declined(`Enter an amount an hour in ${currency}, such as 45.00.`);
		await setCostRate(scope, membership.user.id, {
			userId: input.userId,
			amountMinor,
			currency,
			effectiveFrom: input.effectiveFrom,
		});
		return done(
			`Cost rate set: ${formatMoney(amountMinor, currency, DEFAULT_LOCALE)} an hour from ${dayLabel(input.effectiveFrom)}.`,
		);
	}
	if (!isAdministrator(membership.role)) return declined(NOT_ALLOWED, 403);
	if (input.endsOn < input.startsOn) return declined("The last day is before the first.");
	const set = await setProjectDates(scope, input.projectId, {
		startsOn: input.startsOn,
		endsOn: input.endsOn,
	});
	if (!set) throw notFound();
	return done(`Dates set: ${dayLabel(input.startsOn)} to ${dayLabel(input.endsOn)}.`);
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	if (!maySeeRates(membership.role)) throw notFound();
	const url = new URL(request.url);
	const report = await reportRequest(membership, url, Date.now());
	const scope = report.scope;
	const [profit, opened, fixedFee, money] = await Promise.all([
		// A custom range that makes no report: the fields again, with the reason (TS-091, W05).
		"problem" in report ? null : profitabilityReport(report),
		openedFrom(membership, url),
		scope.projects.select((p) => and(eq(p.billingType, "fixed_fee"), isNull(p.archivedAt))),
		organisationMoney(membership.organisation.id),
	]);
	const { currency } = money;
	const amount = (minor: number) => formatMoney(minor, currency, DEFAULT_LOCALE);
	const costRates = await personCostRates(scope, report.choices, currency, report.today);
	const figures = profit && {
		totals: {
			profit: amount(profit.totals.profitMinor),
			revenue: amount(profit.totals.revenueMinor),
			cost: amount(profit.totals.costMinor),
			margin: percentLabel(profit.totals.margin),
		},
		projects: profit.lines.map((line) => ({
			id: line.projectId,
			name: line.project,
			client: line.client,
			type:
				line.billingType === "fixed_fee"
					? "Fixed fee"
					: line.billingType === "hourly"
						? "Hourly"
						: "Non-billable",
			revenue:
				line.revenueMinor === null
					? "Revenue unknown: the fee or the dates are missing"
					: `Revenue ${formatMoney(line.revenueMinor, line.currency, DEFAULT_LOCALE)}`,
			cost: `Cost ${amount(line.costMinor)}`,
			margin: percentLabel(line.margin),
			profit: line.profitMinor === null ? "—" : amount(line.profitMinor),
			otherCurrency: line.currency !== currency ? line.currency : null,
			missingRate: line.missingRateSeconds > 0 ? hoursAndMinutes(line.missingRateSeconds) : null,
		})),
		missingCost: profit.missingCost.map((p) => ({
			id: p.id,
			name: p.name,
			time: hoursAndMinutes(p.seconds),
		})),
	};
	return data(
		{
			...viewFrame(report, { grouped: false }),
			// Profitability is about every project: it is not narrowed to a person.
			choices: [],
			views: viewsFor(membership.role),
			opened,
			slug: membership.organisation.slug,
			currency,
			mayManageRates: mayManageRates(membership.role),
			maySetDates: isAdministrator(membership.role),
			today: report.today,
			figures,
			people: costRates.map((p) => ({
				id: p.id,
				name: p.name,
				address: p.address,
				current: p.current
					? `${amount(p.current.amountMinor)} an hour from ${dayLabel(p.current.effectiveFrom)}`
					: "No cost rate",
				amount: p.current ? moneyText(p.current.amountMinor, currency) : "",
				later: p.rates
					.filter((r) => r.effectiveFrom > report.today)
					.map((r) => `${amount(r.amountMinor)} from ${dayLabel(r.effectiveFrom)}`),
			})),
			fixedFee: fixedFee.map((p) => ({
				id: p.id,
				name: p.name,
				startsOn: p.startsOn ?? "",
				endsOn: p.endsOn ?? "",
				dates:
					p.startsOn && p.endsOn
						? `${dayLabel(p.startsOn)} to ${dayLabel(p.endsOn)}`
						: "No dates: its fee is not spread",
			})),
		},
		{ status: figures ? 200 : 400 },
	);
}

type Data = Route.ComponentProps["loaderData"];

export default function Profitability({ loaderData }: Route.ComponentProps) {
	const { figures, steps, people, fixedFee } = loaderData;
	const [person, setPerson] = useState<Data["people"][number] | null>(null);
	const [project, setProject] = useState<Data["fixedFee"][number] | null>(null);
	const [said, setSaid] = useState<string | null>(null);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				What each project earned and cost in {loaderData.currency}: revenue from billable time or a
				fixed fee spread over its days, cost from each person's cost rate and every expense.
			</PageLead>
			<ReportTabs
				slug={loaderData.slug}
				current="profitability"
				views={loaderData.views}
				search={loaderData.tabSearch}
			/>
			<ReportChoice {...loaderData} />
			<RangeSteps range={loaderData.range} steps={steps} />
			{figures && (
				<>
					<Headline
						label="Profit"
						value={figures.totals.profit}
						beside={`on ${figures.totals.revenue} revenue, ${figures.totals.cost} cost · margin ${figures.totals.margin}`}
					/>
					<SaveReport opened={loaderData.opened} />
				</>
			)}
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			{figures && <ProjectProfits {...figures} range={loaderData.range} />}

			<Section
				id="cost-rates"
				heading="Cost rates"
				lead={`What an hour of each person costs, in ${loaderData.currency}. A new rate applies from its date; time before it keeps the rate it had.`}
			>
				<div className="max-w-200">
					<Ledger heading="People" note={people.length}>
						<LedgerRows label="Cost rates by person">
							{people.map((p) => (
								<LedgerRow
									key={p.id}
									title={<span className="wrap-anywhere">{p.name}</span>}
									detail={
										<>
											{p.address && <span className="block wrap-anywhere">{p.address}</span>}
											{p.current}
											{p.later.length > 0 && (
												<span className="block">Then {p.later.join(", ")}</span>
											)}
										</>
									}
									action={
										loaderData.mayManageRates && (
											<Button
												variant="text"
												aria-label={`Set rate for ${p.name}`}
												onPress={() => setPerson(p)}
											>
												Set rate
											</Button>
										)
									}
								/>
							))}
						</LedgerRows>
					</Ledger>
				</div>
			</Section>

			{fixedFee.length > 0 && (
				<Section
					id="fixed-fee"
					heading="Fixed-fee projects"
					lead="A fixed fee is spread evenly over the project's first to last day, both included."
				>
					<div className="max-w-200">
						<Ledger heading="Dates" note={fixedFee.length}>
							<LedgerRows label="Fixed-fee projects and their dates">
								{fixedFee.map((p) => (
									<LedgerRow
										key={p.id}
										title={<span className="wrap-anywhere">{p.name}</span>}
										detail={p.dates}
										action={
											loaderData.maySetDates && (
												<Button
													variant="text"
													aria-label={`Set dates of ${p.name}`}
													onPress={() => setProject(p)}
												>
													Set dates
												</Button>
											)
										}
									/>
								))}
							</LedgerRows>
						</Ledger>
					</div>
				</Section>
			)}

			<FormSheet
				title={`Cost rate for ${person?.name ?? "this person"}`}
				intent="cost-rate"
				submitLabel="Set rate"
				isOpen={person !== null}
				onClose={() => setPerson(null)}
				onDone={setSaid}
			>
				<input type="hidden" name="userId" value={person?.id ?? ""} />
				<TextField
					key={person?.id}
					label={`An hour, in ${loaderData.currency}`}
					name="amount"
					inputMode="decimal"
					defaultValue={person?.amount}
					autoComplete="off"
					autoFocus
					isRequired
				/>
				<TextField
					key={`${person?.id}/from`}
					label="From"
					name="effectiveFrom"
					type="date"
					defaultValue={loaderData.today}
					isRequired
				/>
			</FormSheet>

			<FormSheet
				title={`Dates of ${project?.name ?? "this project"}`}
				intent="project-dates"
				submitLabel="Set dates"
				isOpen={project !== null}
				onClose={() => setProject(null)}
				onDone={setSaid}
			>
				<input type="hidden" name="projectId" value={project?.id ?? ""} />
				<TextField
					key={project?.id}
					label="First day"
					name="startsOn"
					type="date"
					defaultValue={project?.startsOn}
					isRequired
				/>
				<TextField
					key={`${project?.id}/end`}
					label="Last day"
					name="endsOn"
					type="date"
					defaultValue={project?.endsOn}
					isRequired
				/>
			</FormSheet>
		</>
	);
}

/** Each project's profit over the range, and who has time with no cost rate. */
function ProjectProfits({
	totals,
	projects,
	missingCost,
	range,
}: NonNullable<Data["figures"]> & { range: string }) {
	return (
		<>
			{missingCost.length > 0 && (
				<p className="mt-6 max-w-160 text-body-medium text-on-surface-variant">
					Time with no cost rate counts as costing nothing:{" "}
					{missingCost.map((p) => `${p.name} (${p.time})`).join(", ")}. Give them a rate under Cost
					rates.
				</p>
			)}

			<div className="mt-10 max-w-200">
				<Ledger heading="By project" note={range}>
					{projects.length > 0 ? (
						<LedgerRows label="Profit by project">
							{projects.map((p) => (
								<LedgerRow
									key={p.id}
									title={<span className="wrap-anywhere">{p.name}</span>}
									detail={
										<>
											<span className="block wrap-anywhere">
												{[p.client, p.type].filter(Boolean).join(" · ")}
											</span>
											{`${p.revenue} · ${p.cost} · margin ${p.margin}`}
											{p.otherCurrency && (
												<span className="block">
													Billed in {p.otherCurrency}: no profit without a conversion.
												</span>
											)}
											{p.missingRate && (
												<span className="block">{p.missingRate} billable with no rate.</span>
											)}
										</>
									}
									value={p.profit}
								/>
							))}
						</LedgerRows>
					) : (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							No time, expenses or fees in this range.
						</p>
					)}
					<LedgerTotal label="Profit" value={totals.profit} />
				</Ledger>
			</div>
		</>
	);
}
