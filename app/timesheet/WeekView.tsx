import { useEffect, useRef, useState, ViewTransition } from "react";
import { Link, useFetcher } from "react-router";

import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import { Select } from "~/components/Select";
import type { Outcome } from "~/organisations/problems";
import { periodAfter } from "~/periods/periods";
import { TRANSITION, useTravel } from "~/shell/transitions";

import { cellText, formatDuration } from "./durations";
import { dayNumber, useDayFormat, usePeriodFormat } from "./format";
import { PeriodLinks } from "./PeriodLinks";
import { Submission } from "./Submission";
import { type GridCell, isTypable, PERIOD_STATE_LABELS, weekSheet } from "./sheets";
import type { WeekData } from "./timesheet.server";
import { dayPath, weekPath } from "./views";

/**
 * The Week view (TS-013, TS-052, TS-046): the period's seven days as a grid of
 * projects by days, hours typed into a cell, a total per day, per project and
 * for the week, and "Submit week" at its foot (`Submission`, which the Day
 * view's foot shares). Its header says where the
 * period stands; a returned one shows why.
 */
export function WeekView({ data, slug }: { data: WeekData; slug: string }) {
	const { period, days, lockedDays, projects, state, comment, today } = data;
	const formatPeriod = usePeriodFormat();
	const travel = useTravel(dayNumber(period.startsOn));
	const [said, setSaid] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);

	// Rows added with no time yet, which the server does not know of: kept here,
	// for each week visited, until hours are typed into them.
	const [addedByWeek, setAddedByWeek] = useState<Record<string, string[]>>({});
	const added = addedByWeek[period.startsOn] ?? [];
	const sheet = weekSheet([], days, data.zone, data.now, { addedRows: added });
	const rows = [
		...data.sheet.rows,
		...sheet.rows.filter((row) => !data.sheet.rows.some((r) => r.projectId === row.projectId)),
	];
	const inGrid = new Set(rows.map((row) => row.projectId));
	const addable = projects.filter((p) => !p.archived && !inGrid.has(p.id));
	const editable = lockedDays.length === 0;
	const thisWeek = period.startsOn <= today && today <= period.endsOn;

	return (
		<>
			<PeriodLinks
				label="Weeks"
				previous={{ to: weekPath(slug, periodAfter(period, -1).startsOn), label: "Previous week" }}
				current={{ to: weekPath(slug), label: "Today", isCurrent: thisWeek }}
				next={{ to: weekPath(slug, periodAfter(period, 1).startsOn), label: "Next week" }}
			/>

			<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
				<div className="mt-6">
					<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
						<h2 className="text-title-large">{formatPeriod(period.startsOn, period.endsOn)}</h2>
						<p className="text-label-large text-on-surface-variant">
							<span className="sr-only">Status: </span>
							{PERIOD_STATE_LABELS[state]}
						</p>
					</div>
					{state === "returned" && (
						<p className="mt-2 max-w-160 text-body-large">
							Returned{comment ? `: ${comment}` : "."} Correct the week and submit it again.
						</p>
					)}

					<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
						{said}
					</p>
					<p role="alert" className="mt-2 text-body-medium text-error empty:hidden">
						{problem}
					</p>

					<Grid
						data={data}
						rows={rows}
						slug={slug}
						onSaved={(text) => {
							setProblem(null);
							setSaid(text);
						}}
						onProblem={setProblem}
					/>

					{editable && (
						<AddRows
							addable={addable}
							lastWeek={data.lastWeekProjects.filter((id) => !inGrid.has(id))}
							onAdd={(ids) => {
								setAddedByWeek((all) => ({
									...all,
									[period.startsOn]: [...added, ...ids.filter((id) => !added.includes(id))],
								}));
								setSaid(
									ids.length === 1
										? `${projects.find((p) => p.id === ids[0])?.name} added.`
										: `${ids.length} rows added.`,
								);
							}}
						/>
					)}

					<Submission submission={data} onSaid={setSaid} />
				</div>
			</ViewTransition>
		</>
	);
}

/** The grid of projects by days, with the totals of each. */
function Grid({
	data,
	rows,
	slug,
	onSaved,
	onProblem,
}: {
	data: WeekData;
	rows: WeekData["sheet"]["rows"];
	slug: string;
	onSaved: (said: string) => void;
	onProblem: (problem: string) => void;
}) {
	const { days, lockedDays, projects, sheet } = data;
	const formatDay = useDayFormat("short");
	const formatLong = useDayFormat();
	const nameOf = (id: string) => {
		const project = projects.find((p) => p.id === id);
		return project ? `${project.name}${project.archived ? " (archived)" : ""}` : "";
	};

	return (
		<div className="mt-6 overflow-x-auto rounded-large border-2 border-on-surface">
			<table className="w-full min-w-180 border-collapse text-body-large">
				<caption className="sr-only">Hours by project and day</caption>
				<thead>
					<tr className="border-b border-outline-variant text-label-large">
						<th scope="col" className="px-4 py-3 text-start">
							Project
						</th>
						{days.map((day) => (
							<th key={day} scope="col" className="px-2 py-3 text-end">
								<Link
									to={dayPath(slug, day)}
									className="rounded-extra-small underline-offset-4 outline-none hover:underline focus-visible:focus-indicator"
								>
									{formatDay(day)}
								</Link>
							</th>
						))}
						<th scope="col" className="px-4 py-3 text-end">
							Total
						</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-outline-variant">
					{rows.length === 0 && (
						<tr>
							<td colSpan={days.length + 2} className="px-4 py-3 text-on-surface-variant">
								Nothing tracked this week. Add a row to type hours.
							</td>
						</tr>
					)}
					{rows.map((row) => (
						<tr key={row.projectId}>
							<th scope="row" className="max-w-60 truncate px-4 py-2 text-start font-normal">
								{nameOf(row.projectId)}
							</th>
							{row.cells.map((cell) => (
								<td key={cell.day} className="px-1 py-1 text-end tabular-nums">
									<Cell
										cell={cell}
										projectId={row.projectId}
										label={`${nameOf(row.projectId)}, ${formatLong(cell.day)}`}
										locked={lockedDays.includes(cell.day)}
										slug={slug}
										onSaved={onSaved}
										onProblem={onProblem}
									/>
								</td>
							))}
							<td className="px-4 py-2 text-end text-title-medium tabular-nums">
								{formatDuration(row.total)}
							</td>
						</tr>
					))}
				</tbody>
				<tfoot>
					<tr className="border-t-2 border-on-surface">
						<th scope="row" className="px-4 py-3 text-start text-label-large">
							Day total
						</th>
						{sheet.days.map((each) => (
							<td key={each.day} className="px-2 py-3 text-end tabular-nums">
								{formatDuration(each.total)}
							</td>
						))}
						<td className="px-4 py-3 text-end text-title-large tabular-nums">
							<span className="sr-only">Week total </span>
							{formatDuration(sheet.total)}
						</td>
					</tr>
				</tfoot>
			</table>
		</div>
	);
}

/**
 * One cell. Hours typed into it are saved when the focus leaves it or Enter
 * is pressed. A cell of more than one entry, or of a running one, shows its
 * total and leads to the Day view; a cell of a locked day shows its total.
 */
function Cell({
	cell,
	projectId,
	label,
	locked,
	slug,
	onSaved,
	onProblem,
}: {
	cell: GridCell;
	projectId: string;
	label: string;
	locked: boolean;
	slug: string;
	onSaved: (said: string) => void;
	onProblem: (problem: string) => void;
}) {
	const fetcher = useFetcher<Outcome>();
	const shown = cellText(cell.total);
	const [value, setValue] = useState(shown);
	// The server's figure replaces what was typed once it has answered.
	useEffect(() => setValue(shown), [shown]);
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	const handled = useRef<Outcome | undefined>(undefined);
	useEffect(() => {
		if (!answer || handled.current === answer) return;
		handled.current = answer;
		if (answer.ok) onSaved(`${label}: ${answer.said}`);
		else onProblem(`${label}: ${answer.problem}`);
	}, [answer, label, onSaved, onProblem]);

	if (locked) return <span className="block px-2 py-2">{shown}</span>;
	if (!isTypable(cell, locked)) {
		return (
			<Link
				to={dayPath(slug, cell.day)}
				aria-label={`${label}: ${formatDuration(cell.total)}${cell.running ? ", running" : ""}. Change it in the Day view`}
				className="block rounded-extra-small px-2 py-2 underline underline-offset-4 outline-none focus-visible:focus-indicator"
			>
				{formatDuration(cell.total)}
			</Link>
		);
	}

	const save = () => {
		if (value.trim() === shown) return;
		fetcher.submit({ intent: "cell", projectId, day: cell.day, hours: value }, { method: "post" });
	};
	return (
		<input
			type="text"
			inputMode="decimal"
			autoComplete="off"
			aria-label={label}
			aria-invalid={answer && !answer.ok ? true : undefined}
			value={value}
			onChange={(event) => setValue(event.target.value)}
			onBlur={save}
			onKeyDown={(event) => {
				if (event.key === "Enter") save();
			}}
			className={cx(
				"h-10 w-16 rounded-extra-small border border-outline-variant bg-surface px-2 text-end tabular-nums outline-none focus-visible:focus-indicator",
				answer && !answer.ok && "border-error",
			)}
		/>
	);
}

/** "Add row" for a project with no time yet, and "Copy last week's rows" (TS-052). */
function AddRows({
	addable,
	lastWeek,
	onAdd,
}: {
	addable: WeekData["projects"];
	lastWeek: string[];
	onAdd: (ids: string[]) => void;
}) {
	const [chosen, setChosen] = useState<string | null>(null);
	const pick = chosen && addable.some((p) => p.id === chosen) ? chosen : (addable[0]?.id ?? null);
	return (
		<div className="mt-4 flex flex-wrap items-end gap-4">
			{addable.length > 0 && (
				<>
					<div className="w-72 max-w-full">
						<Select
							label="Project to add"
							options={addable.map((p) => ({ id: p.id, label: p.name }))}
							value={pick}
							onChange={setChosen}
						/>
					</div>
					<Button variant="outlined" onPress={() => pick && onAdd([pick])}>
						Add row
					</Button>
				</>
			)}
			{lastWeek.length > 0 && (
				<Button variant="text" onPress={() => onAdd(lastWeek)}>
					Copy last week's rows
				</Button>
			)}
		</div>
	);
}
