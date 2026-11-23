import { useId, useState } from "react";
import { Link, useFetcher } from "react-router";

import { LedgerRow, LedgerRows } from "~/components/Ledger";
import type { ReportPeople } from "~/routes/app/reports.people";
import { ACTION_LINK } from "~/shell/links";

import type { GroupPerson, PersonView } from "./people.server";

// A Time report draws its groups, and reads a group's people, or the People
// section of a report of many people, when it is opened (TS-113, D8). Each
// opens through a link to the page with `show` in the address, so it opens
// without script too; with script, the link reads the people alone
// (`routes/app/reports.people.ts`) and opens in place.

export interface ReportGroup {
	key: string;
	label: string;
	duration: string;
	overtime: string | null;
	/** Who tracked it, when the address opened it; null until it is opened. */
	people: GroupPerson[] | null;
}

/** One group of the report, with its people under it once opened. */
export function GroupRow({
	group,
	peoplePath,
	showSearch,
}: {
	group: ReportGroup;
	/** The report's people, at the report's query (`reportPeoplePath`). */
	peoplePath: string;
	/** The report's query, for the address that opens the group without script. */
	showSearch: string;
}) {
	const fetcher = useFetcher<ReportPeople>();
	const [open, setOpen] = useState(group.people !== null);
	const panel = useId();
	const read = fetcher.data && "group" in fetcher.data ? fetcher.data.group : null;
	const people = group.people ?? read;
	const show = new URLSearchParams(showSearch);
	show.set("show", group.key);
	return (
		<LedgerRow
			title={<span className="wrap-anywhere">{group.label}</span>}
			detail={group.overtime ?? undefined}
			value={group.duration}
			action={
				<Link
					to={`?${show}#people-of-${encodeURIComponent(group.key)}`}
					preventScrollReset
					aria-expanded={open}
					aria-controls={panel}
					className={ACTION_LINK}
					onClick={(event) => {
						event.preventDefault();
						setOpen(!open);
						if (!open && people === null && fetcher.state === "idle") {
							const inGroup = new URLSearchParams({ in: group.key });
							fetcher.load(`${peoplePath}&${inGroup}`);
						}
					}}
				>
					{open ? "Hide people" : "People"}
				</Link>
			}
		>
			{open && (
				<div id={panel} aria-busy={people === null}>
					<span id={`people-of-${group.key}`} />
					{people === null ? (
						<p className="pt-2 text-body-medium text-on-surface-variant">Reading who tracked it…</p>
					) : people.length === 0 ? (
						<p className="pt-2 text-body-medium text-on-surface-variant">Nobody tracked it.</p>
					) : (
						<ul aria-label={`People in ${group.label}`} className="pt-1">
							{people.map((person) => (
								<li
									key={person.id}
									className="flex items-baseline justify-between gap-4 py-1 text-body-medium"
								>
									<span className="min-w-0 wrap-anywhere">
										{person.name}
										{person.overtime && (
											<span className="block text-on-surface-variant">{person.overtime}</span>
										)}
									</span>
									<span className="tabular-nums">{person.duration}</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</LedgerRow>
	);
}

/** Each person's worked, expected and leave: drawn with the page, or read when opened. */
export function PeopleRows({
	people,
	count,
	peoplePath,
	showSearch,
}: {
	/** The people when the page holds them; null until the section is opened. */
	people: PersonView[] | null;
	count: number;
	peoplePath: string;
	showSearch: string;
}) {
	const fetcher = useFetcher<ReportPeople>();
	const read = fetcher.data && "people" in fetcher.data ? fetcher.data.people : null;
	const shown = people ?? read;
	if (shown === null) {
		const show = new URLSearchParams(showSearch);
		show.set("show", "people");
		return (
			<p className="px-4 py-3 @sm:px-5">
				<Link
					to={`?${show}#people`}
					preventScrollReset
					className={ACTION_LINK}
					aria-busy={fetcher.state !== "idle"}
					onClick={(event) => {
						event.preventDefault();
						if (fetcher.state === "idle") fetcher.load(peoplePath);
					}}
				>
					{fetcher.state === "idle" ? `Show all ${count} people` : `Reading ${count} people…`}
				</Link>
			</p>
		);
	}
	return (
		<LedgerRows label="Worked, expected and leave by person">
			{shown.map((person) => (
				<LedgerRow
					key={person.id}
					title={<span className="wrap-anywhere">{person.name}</span>}
					detail={
						<>
							{person.address && <span className="block wrap-anywhere">{person.address}</span>}
							{`${person.expected} expected · ${person.leave}`}
							{person.overtime && <span className="block">{person.overtime}</span>}
							{person.shortNotice && <span className="block">{person.shortNotice}</span>}
						</>
					}
					value={person.worked}
				/>
			))}
		</LedgerRows>
	);
}
