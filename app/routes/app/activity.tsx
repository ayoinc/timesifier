import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { SubjectType } from "~/activity/actions";
import { KIND_LABELS, PAGE_RECORDS, SYSTEM } from "~/activity/log";
import { type LogRow, logRecords, logRequest, logRows, parseLogQuery } from "~/activity/log.server";
import { activityExportPath, entryHistoryPath } from "~/activity/paths";
import { FilterBar, useApplyFilters } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { membershipContext } from "~/organisations/membership.server";
import { destination } from "~/shell/destinations";
import { ACTION_LINK, TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { peopleOf } from "~/teams/people.server";
import { addDays } from "~/time/calendar";
import { formatRange } from "~/time/format";

import type { Route } from "./+types/activity";

// Review > Activity log (TS-072): who created, changed or deleted what, and
// when, for a range of days, narrowed by kind, project, who performed it and
// whose it is, with the same records as CSV. Shown to owners, admins, Finance
// and team managers (the destination's audience); what each reads is
// `activityScopeOf`. A member reads the history of their own entries on the
// entry (routes/app/history.tsx). Records are kept two years.

const { label } = destination("activity");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** Any filter. */
const ANY = "";

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const url = new URL(request.url);
	const now = Date.now();
	const query = parseLogQuery(url.searchParams) ?? {};
	const log =
		(await logRequest(membership, query, now, scope)) ??
		(await logRequest(membership, {}, now, scope));
	if (!log) throw new Error("The default range is always a range.");
	const [records, people, projects] = await Promise.all([
		logRecords(log, PAGE_RECORDS + 1),
		log.visible.everyone
			? peopleOf(scope, organisation)
			: peopleOf(scope, organisation, log.visible.people),
		scope.projects.select(),
	]);
	const rows = await logRows(scope, records.slice(0, PAGE_RECORDS), log.zone);
	const search = url.searchParams.toString();
	return {
		query: { ...log.query, from: log.first, to: log.last },
		range: formatRange(log.first, log.last),
		zone: log.zone,
		rows,
		more: records.length > PAGE_RECORDS,
		people: people.map(({ id, name }) => ({ id, name })),
		projects: projects
			.map(({ id, name }) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name, "en")),
		everyone: log.visible.everyone,
		slug: organisation.slug,
		exportPath: activityExportPath(organisation.slug, search ? `?${search}` : ""),
		/** A year back, the empty state's way to look further. */
		yearBack: `?from=${addDays(log.last, -365)}&to=${log.last}`,
	};
}

export default function Activity({ loaderData }: Route.ComponentProps) {
	const { query, rows, people, projects, everyone } = loaderData;

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				Who changed what, and when,{" "}
				{everyone ? "across the organisation" : "for you and your teams"}, in {loaderData.zone}.
			</PageLead>

			<div className="mt-8 max-w-200">
				<FilterBar name="Choose records">
					<RecordFields query={query} people={people} projects={projects} />
				</FilterBar>
			</div>

			<div className="mt-10 max-w-200">
				<Ledger
					heading={loaderData.range}
					note={rows.length === 0 ? undefined : `${rows.length}${loaderData.more ? "+" : ""}`}
				>
					{rows.length > 0 ? (
						<LedgerRows label="Records, newest first">
							{rows.map((row) => (
								<RecordRow key={row.id} row={row} slug={loaderData.slug} />
							))}
						</LedgerRows>
					) : (
						<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
							No records in this range.{" "}
							<Link to={loaderData.yearBack} className={TEXT_LINK}>
								Look back a year
							</Link>
						</p>
					)}
				</Ledger>
				{loaderData.more && (
					<p className="mt-4 max-w-160 text-body-medium text-on-surface-variant">
						The newest {PAGE_RECORDS} are listed here. Narrow the range or the filters, or export
						them all.
					</p>
				)}
				<p className="mt-2">
					<a href={loaderData.exportPath} download className={ACTION_LINK}>
						Export as CSV
					</a>
				</p>
			</div>
		</>
	);
}

/** One record: what was done, by whom, about whom and when, and what changed. */
function RecordRow({ row, slug }: { row: LogRow; slug: string }) {
	const by = row.source === "web" ? row.actor : `${row.actor}, ${SOURCE_WORDS[row.source]}`;
	return (
		<LedgerRow
			title={<span className="wrap-anywhere">{row.what}</span>}
			detail={
				<>
					<span className="block">
						{row.when} · {by}
						{row.owner && row.owner !== row.actor ? ` · for ${row.owner}` : ""}
					</span>
					{row.changesText && <span className="block wrap-anywhere">{row.changesText}</span>}
				</>
			}
			action={
				row.subjectType === "time_entry" && (
					<Link
						to={entryHistoryPath(slug, row.subjectId)}
						className={ACTION_LINK}
						aria-label={`History of this entry, ${row.when}`}
					>
						History
					</Link>
				)
			}
		/>
	);
}

/** Each field of the choice grows to share its row, as on Reports. */
const FIELD = "min-w-0 grow basis-44";

/** A date field's value once a whole date is in it. */
const WHOLE_DATE = /^\d{4}-\d{2}-\d{2}$/;

type FieldsProps = Pick<Route.ComponentProps["loaderData"], "query" | "people" | "projects">;

/** The fields' values for the records the address asks for; no filter is `ANY`. */
function fieldsOf(query: FieldsProps["query"]) {
	return {
		from: query.from,
		to: query.to,
		kind: query.kind ?? ANY,
		project: query.project ?? ANY,
		actor: query.actor ?? ANY,
		owner: query.owner ?? ANY,
	};
}

/**
 * The fields that choose the records, sent in the address, so a view of the
 * log is a link. Each list applies as soon as it changes; the days apply once
 * both hold a whole date, or on Enter, as on Reports.
 */
function RecordFields({ query, people, projects }: FieldsProps) {
	const apply = useApplyFilters();
	// The hidden selects and the inputs hold the new value once React has drawn it.
	const applySoon = () => setTimeout(apply, 0);
	const [fields, setFields] = useState(() => fieldsOf(query));
	// The address changed (applied, Back, a link): show what it holds. The
	// loader's data is a new object only when it was read again.
	useEffect(() => setFields(fieldsOf(query)), [query]);

	const choose = (name: "kind" | "project" | "actor" | "owner") => (id: string | null) => {
		setFields((now) => ({ ...now, [name]: id ?? ANY }));
		applySoon();
	};
	const setDay = (name: "from" | "to") => (value: string) => {
		const next = { ...fields, [name]: value };
		setFields(next);
		if (WHOLE_DATE.test(next.from) && WHOLE_DATE.test(next.to)) applySoon();
	};
	const others = people.map(({ id, name }) => ({ id, label: name }));

	return (
		<>
			<div className={FIELD}>
				<TextField
					label="First day"
					name="from"
					type="date"
					value={fields.from}
					onChange={setDay("from")}
				/>
			</div>
			<div className={FIELD}>
				<TextField
					label="Last day"
					name="to"
					type="date"
					value={fields.to}
					min={WHOLE_DATE.test(fields.from) ? fields.from : undefined}
					onChange={setDay("to")}
				/>
			</div>
			<div className={FIELD}>
				<Select
					label="Kind"
					name="kind"
					options={[
						{ id: ANY, label: "Every kind" },
						...SubjectType.options.map((id) => ({ id, label: KIND_LABELS[id] })),
					]}
					value={fields.kind}
					onChange={choose("kind")}
				/>
			</div>
			<div className={FIELD}>
				<Select
					label="Project"
					name="project"
					options={[
						{ id: ANY, label: "Every project" },
						...projects.map(({ id, name }) => ({ id, label: name })),
					]}
					value={fields.project}
					onChange={choose("project")}
				/>
			</div>
			<div className={FIELD}>
				<Select
					label="Performed by"
					name="actor"
					options={[
						{ id: ANY, label: "Anyone" },
						...others,
						{ id: SYSTEM, label: "Timesifier (automatic)" },
					]}
					value={fields.actor}
					onChange={choose("actor")}
				/>
			</div>
			<div className={FIELD}>
				<Select
					label="Owned by"
					name="owner"
					options={[{ id: ANY, label: "Anyone" }, ...others]}
					value={fields.owner}
					onChange={choose("owner")}
				/>
			</div>
		</>
	);
}

/** Through which door a record came, besides a page. */
const SOURCE_WORDS: Record<LogRow["source"], string> = {
	web: "on a page",
	api: "through the API",
	import: "through an import",
	system: "automatically",
};
