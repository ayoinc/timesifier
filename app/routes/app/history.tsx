import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { Link } from "react-router";

import { logRows, subjectRecords } from "~/activity/log.server";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { organisationScope } from "~/db";
import { activityScopeOf } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { zoneOfMember } from "~/time/zones.server";
import { dayPath } from "~/timesheet/views";

import type { Route } from "./+types/history";

// The history of one time entry (TS-072): every record of it, oldest first,
// with what changed each time. It is how a member reads the log of their own
// entries, from the entry's menu on the Day view; anybody who reads the
// entry's person's records may open it too (`activityScopeOf`). An entry
// nobody here may read, or one with no record, is the organisation's 404.

export function meta() {
	return [{ title: "Entry history · Timesifier" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation, user } = membership;
	const entryId = new URL(request.url).searchParams.get("entry");
	// With no entry named, the page says where to choose one.
	if (!entryId) return { entry: false as const, timesheet: dayPath(organisation.slug) };
	if (entryId.length > 64) throw notFound();
	const scope = organisationScope(env.DB, organisation.id);
	const [access, zone, [entry]] = await Promise.all([
		accessOf(membership),
		zoneOfMember(membership),
		scope.timeEntries.select((e) => eq(e.id, entryId), { limit: 1 }),
	]);
	const visible = activityScopeOf(access);
	if (entry && !visible.everyone && !visible.people.includes(entry.userId)) throw notFound();
	const records = await subjectRecords(scope, visible, { type: "time_entry", id: entryId });
	if (records.length === 0) throw notFound();
	const rows = await logRows(scope, records, zone);
	const [project] = entry
		? await scope.projects.select((p) => eq(p.id, entry.projectId), { limit: 1 })
		: [];
	return {
		entry: true as const,
		rows,
		project: project?.name ?? null,
		deleted: !entry,
		owner: rows.find((row) => row.owner)?.owner ?? null,
		/** The Day view of the entry, for the person whose entry it is. */
		back: entry && entry.userId === user.id ? dayPath(organisation.slug, entry.spentOn) : null,
	};
}

export default function History({ loaderData }: Route.ComponentProps) {
	if (!loaderData.entry) {
		return (
			<>
				<PageHeading>Entry history</PageHeading>
				<PageLead>Every change to one of your entries, oldest first.</PageLead>
				<p className="mt-6">
					<Link to={loaderData.timesheet} className={ACTION_LINK}>
						Go to your timesheet
					</Link>
				</p>
			</>
		);
	}
	const { rows, project, deleted, owner, back } = loaderData;
	return (
		<>
			<PageHeading>Entry history</PageHeading>
			<PageLead>
				{[project ? `An entry of ${project}` : "An entry", owner ? `by ${owner}` : null]
					.filter(Boolean)
					.join(" ")}
				{deleted ? ", since deleted" : ""}: every change to it, oldest first.
			</PageLead>
			<div className="mt-8 max-w-200">
				<Ledger heading="Changes" note={rows.length}>
					<LedgerRows label="Changes, oldest first">
						{rows.map((row) => (
							<LedgerRow
								key={row.id}
								title={row.what}
								detail={
									<>
										<span className="block">
											{row.when} · {row.actor}
										</span>
										{row.changesText && (
											<span className="block wrap-anywhere">{row.changesText}</span>
										)}
									</>
								}
							/>
						))}
					</LedgerRows>
				</Ledger>
				{back && (
					<p className="mt-4">
						<Link to={back} className={ACTION_LINK}>
							Back to the day
						</Link>
					</p>
				)}
			</div>
		</>
	);
}
