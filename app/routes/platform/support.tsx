import { Link } from "react-router";

import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { formatMoney } from "~/money/money";
import { ROLE_LABELS } from "~/organisations/people";
import { consoleMoment } from "~/platform/console-words";
import { notFound, platformOwnerContext } from "~/platform/guard.server";
import { ORGANISATION_ID_PARAM, organisationConsolePath } from "~/platform/paths";
import { supportView } from "~/platform/support.server";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, Section } from "~/shell/PageHeading";
import { formatDuration } from "~/time/format";

import type { Route } from "./+types/support";

// The support view (TS-099, docs/decisions.md entry 36): what a platform
// owner reads of an organisation while its owners have granted support
// access, and only then. It reads; it has no action, so nothing here can
// change the organisation. Every reading is recorded in the organisation's
// activity log and in the platform's, which is why opening the page writes.

const HEADING = "Support view";

export function meta() {
	return [{ title: `${HEADING} · Timesifier` }];
}

/** What a person reads for an invoice's stored status. */
const INVOICE_STATUS: Record<string, string> = {
	draft: "Draft",
	sent: "Sent",
	partially_paid: "Partly paid",
	paid: "Paid",
	void: "Void",
};

export async function loader({ params, context }: Route.LoaderArgs) {
	const { user } = context.get(platformOwnerContext);
	const organisationId = params[ORGANISATION_ID_PARAM];
	const view = await supportView(organisationId, user.id, new Date());
	// No grant in force is the same 404 as an organisation that is not there.
	if (!view) throw notFound();
	return {
		organisationId,
		endsAt: consoleMoment(view.expiresAt),
		members: view.members.map((member) => ({
			...member,
			role: Object.hasOwn(ROLE_LABELS, member.role)
				? ROLE_LABELS[member.role as keyof typeof ROLE_LABELS]
				: member.role,
		})),
		projects: view.projects,
		entries: view.entries.map((entry) => ({
			id: entry.id,
			person: entry.person,
			project: entry.project,
			started: consoleMoment(entry.startedAt),
			length: entry.minutes === null ? "Running" : formatDuration(entry.minutes * 60),
			description: entry.description,
		})),
		invoices: view.invoices.map((invoice) => ({
			id: invoice.id,
			number: invoice.number,
			client: invoice.client,
			status: INVOICE_STATUS[invoice.status] ?? invoice.status,
			total: formatMoney(invoice.totalMinor, invoice.currency, "en-GB"),
		})),
	};
}

export default function Support({ loaderData }: Route.ComponentProps) {
	const { organisationId, endsAt, members, projects, entries, invoices } = loaderData;

	return (
		<>
			<p className="mb-2 text-body-medium">
				<Link to={organisationConsolePath(organisationId)} className={TEXT_LINK}>
					Back to the organisation
				</Link>
			</p>
			<PageHeading>{HEADING}</PageHeading>

			{/* Said first, and read out: whose leave this is, until when, and that it is on the record. */}
			<p
				role="note"
				className="mt-6 max-w-160 rounded-medium bg-secondary-container px-5 py-4 text-body-large text-on-secondary-container"
			>
				The organisation's owners granted support access, and it ends {endsAt}. This reading is
				recorded in their activity log and in the platform log. Nothing here can be changed.
			</p>

			<Section id="people" heading="People">
				<Ledger heading="Members" note={`${members.length}`}>
					<LedgerRows>
						{members.map((member) => (
							<LedgerRow
								key={member.id}
								title={<span className="wrap-anywhere">{member.name}</span>}
								detail={
									// The address too, as support may need to reach them; not twice for a person with no name.
									member.email !== member.name && (
										<span className="wrap-anywhere">{member.email}</span>
									)
								}
								value={member.role}
							/>
						))}
					</LedgerRows>
				</Ledger>
			</Section>

			<Section id="projects" heading="Projects">
				{projects.length === 0 ? (
					<p className="text-body-large">No projects.</p>
				) : (
					<Ledger heading="Projects, by name" note={`${projects.length} shown`}>
						<LedgerRows>
							{projects.map((project) => (
								<LedgerRow
									key={project.id}
									title={<span className="wrap-anywhere">{project.name}</span>}
									detail={[project.client ?? "No client", project.archived ? "archived" : null]
										.filter(Boolean)
										.join(", ")}
								/>
							))}
						</LedgerRows>
					</Ledger>
				)}
			</Section>

			<Section id="entries" heading="Latest time entries">
				{entries.length === 0 ? (
					<p className="text-body-large">No time entries.</p>
				) : (
					<Ledger heading="Newest first" note={`${entries.length} shown`}>
						<LedgerRows>
							{entries.map((entry) => (
								<LedgerRow
									key={entry.id}
									title={
										<span className="wrap-anywhere">
											{entry.person}, {entry.project}
										</span>
									}
									detail={
										<>
											{entry.started}.
											{entry.description && (
												<span className="block wrap-anywhere">{entry.description}</span>
											)}
										</>
									}
									value={entry.length}
								/>
							))}
						</LedgerRows>
					</Ledger>
				)}
			</Section>

			<Section id="invoices" heading="Invoices">
				{invoices.length === 0 ? (
					<p className="text-body-large">No invoices.</p>
				) : (
					<Ledger heading="Newest first" note={`${invoices.length} shown`}>
						<LedgerRows>
							{invoices.map((invoice) => (
								<LedgerRow
									key={invoice.id}
									title={
										<span className="wrap-anywhere">
											{invoice.number ? `Invoice ${invoice.number}` : "Draft invoice"},{" "}
											{invoice.client}
										</span>
									}
									detail={invoice.status}
									value={invoice.total}
								/>
							))}
						</LedgerRows>
					</Ledger>
				)}
			</Section>
		</>
	);
}
