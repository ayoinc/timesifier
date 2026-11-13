import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { platformData } from "~/db";
import { planInForce } from "~/plans/plans";
import { consoleDay } from "~/platform/console-words";
import { organisationConsolePath } from "~/platform/paths";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/organisations";

// Organisations in the platform console (TS-099): every organisation, newest
// first, or those whose name or address holds what was searched for, with its
// plan, its people against its seats, how much it holds and when anyone in it
// was last signed in. Counts only: nothing an organisation wrote is read.

const HEADING = "Organisations";

/** The most rows the page lists; a search narrows them. */
const SHOWN = 100;
/** The longest search kept: as long as an organisation's name may be. */
const QUERY_MAX_LENGTH = 200;

export function meta() {
	return [{ title: `${HEADING} · Timesifier` }];
}

const NUMBER = new Intl.NumberFormat("en-GB");

export async function loader({ request }: Route.LoaderArgs) {
	const query = (new URL(request.url).searchParams.get("q") ?? "")
		.trim()
		.slice(0, QUERY_MAX_LENGTH);
	const now = new Date();
	const rows = await platformData.platformOrganisations(env.DB, {
		query: query || undefined,
		limit: SHOWN,
	});
	return {
		query,
		organisations: rows.map((row) => {
			const plan = planInForce(row, now);
			return {
				id: row.id,
				name: row.name,
				plan: plan.trialEndsAt ? `${plan.label}, on trial` : plan.label,
				people: row.members + row.pendingInvitations,
				members: row.members,
				seats: plan.seats,
				lastActive: row.lastActiveAt ? consoleDay(row.lastActiveAt) : null,
				holds: `${NUMBER.format(row.projects)} projects, ${NUMBER.format(row.entries)} time entries, ${NUMBER.format(row.invoices)} invoices`,
			};
		}),
	};
}

export default function Organisations({ loaderData }: Route.ComponentProps) {
	const { query, organisations } = loaderData;
	const heading = query ? `Organisations matching “${query}”` : "Newest organisations";

	return (
		<>
			<PageHeading>{HEADING}</PageHeading>
			<PageLead>
				Every organisation on Timesifier, with its plan and how much it is used. Open one to change
				its plan or to read it while its owners have granted support access.
			</PageLead>

			<Form method="get" role="search" className="mt-6 flex max-w-200 flex-wrap items-end gap-4">
				<div className="min-w-64 flex-1">
					<TextField
						label="Name or web address"
						name="q"
						type="search"
						defaultValue={query}
						autoComplete="off"
						maxLength={QUERY_MAX_LENGTH}
					/>
				</div>
				<Button type="submit" variant="outlined">
					Search
				</Button>
			</Form>

			{organisations.length === 0 ? (
				<EmptySheet heading={heading}>
					{query
						? "No organisation has that in its name or web address."
						: "Nobody has made an organisation yet."}
				</EmptySheet>
			) : (
				<div className="mt-10 max-w-200">
					<Ledger
						heading={heading}
						note={
							organisations.length === SHOWN
								? `The first ${SHOWN}`
								: `${organisations.length} shown`
						}
					>
						<LedgerRows>
							{organisations.map((organisation) => (
								<LedgerRow
									key={organisation.id}
									title={
										<Link
											to={organisationConsolePath(organisation.id)}
											className={`${TEXT_LINK} wrap-anywhere`}
										>
											{organisation.name}
										</Link>
									}
									detail={
										<>
											{organisation.plan}. {NUMBER.format(organisation.members)}{" "}
											{organisation.members === 1 ? "member" : "members"}
											{organisation.people > organisation.members &&
												` and ${NUMBER.format(organisation.people - organisation.members)} invited`}
											. {organisation.holds}.{" "}
											{organisation.lastActive
												? `Last active ${organisation.lastActive}.`
												: "Nobody has signed in yet."}
										</>
									}
									value={`${NUMBER.format(organisation.people)} of ${NUMBER.format(organisation.seats)} seats`}
								/>
							))}
						</LedgerRows>
					</Ledger>
				</div>
			)}
		</>
	);
}
