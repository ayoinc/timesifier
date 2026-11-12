import { useEffect, useRef, useState, ViewTransition } from "react";
import { Link, useFetcher } from "react-router";

import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import { Select } from "~/components/Select";
import { type DayRule, leftMessage, minutesLeft, overLabel, wholeMinutes } from "~/leave/rules";
import type { Outcome } from "~/organisations/problems";
import { periodAfter } from "~/periods/periods";
import { TRANSITION, useTravel } from "~/shell/transitions";

import { ClosedDays, RuleLine } from "./DayRules";
import { cellText, formatDuration, minutesToMs, TypedHours } from "./durations";
import { dayNumber, useDayFormat, usePeriodFormat } from "./format";
import { PeriodLinks } from "./PeriodLinks";
import { PeriodHeader } from "./Submission";
import { type GridCell, isTypable, weekSheet } from "./sheets";
import type { WeekData } from "./timesheet.server";
import { dayPath, weekPath } from "./views";

/**
 * The Week view (TS-013, TS-052, TS-046): the period's seven days as a grid of
 * projects by days, hours typed into a cell, a total per day, per project and
 * for the week. Its header row says where the period stands, with "Submit
 * week" at its end (`PeriodHeader`, which the Day and Calendar views share);
 * a returned one shows why. A day with a limit shows what is left of it, a
 * day that takes no time is read-only and says why, and a day over its limit
 * says by how much (TS-090).
 */
export function WeekView({ data, slug }: { data: WeekData; slug: string }) {
	const { period, days, lockedDays, projects, today } = data;
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
					<PeriodHeader
						title={formatPeriod(period.startsOn, period.endsOn)}
						submission={data}
						onSaid={setSaid}
					/>

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
				</div>
			</ViewTransition>
		</>
	);
}

/**
 * The grid of projects by days, with the totals of each. A day with a limit
 * says at its head what is left of it, or that it takes no time, and a day
 * over its limit says so by its total; the days that take no time are named
 * below the grid with why, and their cells are read-only (TS-090).
 */
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
	const { days, lockedDays, projects, sheet, away, rules } = data;
	const formatDay = useDayFormat("short");
	const formatLong = useDayFormat();
	const nameOf = (id: string) => {
		const project = projects.find((p) => p.id === id);
		return project ? `${project.name}${project.archived ? " (archived)" : ""}` : "";
	};
	const ruleOf = (day: string) => rules.find((rule) => rule.day === day);

	return (
		<>
			<div className="mt-6 overflow-x-auto rounded-large border-2 border-on-surface">
				<table className="w-full min-w-180 border-collapse text-body-large">
					<caption className="sr-only">Hours by project and day</caption>
					<thead>
						<tr className="border-b border-outline-variant text-label-large">
							<th scope="col" className="px-4 py-3 text-start">
								Project
							</th>
							{days.map((day, index) => {
								const marked = away.days[index];
								return (
									<th key={day} scope="col" className="px-2 py-3 text-end">
										<Link
											to={dayPath(slug, day)}
											className="rounded-extra-small underline-offset-4 outline-none hover:underline focus-visible:focus-indicator"
										>
											{formatDay(day)}
										</Link>
										{marked?.label && (
											<span className="block max-w-24 truncate text-label-small font-normal text-on-surface-variant ms-auto">
												{marked.label}
											</span>
										)}
										<span className="flex justify-end font-normal">
											<RuleLine rule={ruleOf(day)} />
										</span>
									</th>
								);
							})}
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
											rule={ruleOf(cell.day)}
											dayTotal={sheet.days.find((each) => each.day === cell.day)?.total ?? 0}
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
							{sheet.days.map((each) => {
								const over = ruleOf(each.day)?.overMinutes ?? 0;
								return (
									<td key={each.day} className="px-2 py-3 text-end tabular-nums">
										{formatDuration(each.total)}
										{over > 0 && (
											<span className="block text-label-small text-error">
												<span className="sr-only">, </span>
												{overLabel(over)}
											</span>
										)}
									</td>
								);
							})}
							<td className="px-4 py-3 text-end text-title-large tabular-nums">
								<span className="sr-only">Week total </span>
								{formatDuration(sheet.total)}
							</td>
						</tr>
						<tr className="text-on-surface-variant">
							<th scope="row" className="px-4 pb-3 text-start text-label-large font-normal">
								Expected
							</th>
							{away.days.map((each) => (
								<td key={each.day} className="px-2 pb-3 text-end tabular-nums">
									{formatDuration(each.expectedMinutes * 60_000)}
								</td>
							))}
							<td className="px-4 pb-3 text-end tabular-nums">
								<span className="sr-only">Week expected </span>
								{formatDuration(away.expectedMinutes * 60_000)}
							</td>
						</tr>
					</tfoot>
				</table>
			</div>
			<ClosedDays rules={rules} />
		</>
	);
}

/**
 * One cell. Hours typed into it are saved when the focus leaves it or Enter
 * is pressed; hours that would take its day past its limit are refused here,
 * before they are sent, and the server refuses them too (TS-090). A cell of
 * more than one entry, or of a running one, shows its total and leads to the
 * Day view; a cell of a locked day shows its total. A cell of a day that
 * takes no time is read-only and says why; any time on it leads to the Day
 * view, where it can be trimmed or moved.
 */
function Cell({
	cell,
	projectId,
	label,
	locked,
	rule,
	dayTotal,
	slug,
	onSaved,
	onProblem,
}: {
	cell: GridCell;
	projectId: string;
	label: string;
	locked: boolean;
	/** The day's limit; undefined for a row added before the server knows of it. */
	rule: DayRule | undefined;
	/** The time of the cell's day across every row, in milliseconds. */
	dayTotal: number;
	slug: string;
	onSaved: (said: string) => void;
	onProblem: (problem: string) => void;
}) {
	const fetcher = useFetcher<Outcome>();
	const shown = cellText(cell.total);
	const [value, setValue] = useState(shown);
	const [refused, setRefused] = useState(false);
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
	const reason = rule?.closedReason ?? null;
	if (reason !== null && cell.total === 0) {
		return (
			<span title={reason} className="block px-2 py-2">
				<span className="sr-only">{reason}</span>
			</span>
		);
	}
	if (reason !== null || !isTypable(cell, locked)) {
		const why = reason
			? ` ${reason} Trim or move it in the Day view`
			: " Change it in the Day view";
		return (
			<Link
				to={dayPath(slug, cell.day)}
				title={reason ?? undefined}
				aria-label={`${label}: ${formatDuration(cell.total)}${cell.running ? ", running" : ""}.${why}`}
				className="block rounded-extra-small px-2 py-2 underline underline-offset-4 outline-none focus-visible:focus-indicator"
			>
				{formatDuration(cell.total)}
			</Link>
		);
	}

	const save = () => {
		if (value.trim() === shown) return;
		// What the day can take, checked before anything is sent: a change that adds nothing always goes.
		const typed = TypedHours.safeParse(value);
		if (typed.success && rule && rule.limitMinutes !== null) {
			const afterMs = minutesToMs(typed.data);
			const othersMs = Math.max(0, dayTotal - cell.total);
			if (afterMs > cell.total && wholeMinutes(othersMs + afterMs) > rule.limitMinutes) {
				setRefused(true);
				onProblem(`${label}: ${leftMessage(minutesLeft(rule, othersMs) ?? 0)}`);
				return;
			}
		}
		setRefused(false);
		fetcher.submit({ intent: "cell", projectId, day: cell.day, hours: value }, { method: "post" });
	};
	const invalid = refused || (answer !== undefined && !answer.ok);
	return (
		<input
			type="text"
			inputMode="decimal"
			autoComplete="off"
			aria-label={
				rule?.leftMinutes != null
					? `${label}, ${formatDuration(rule.leftMinutes * 60_000)} left`
					: label
			}
			aria-invalid={invalid ? true : undefined}
			value={value}
			onChange={(event) => {
				setRefused(false);
				setValue(event.target.value);
			}}
			onBlur={save}
			onKeyDown={(event) => {
				if (event.key === "Enter") save();
			}}
			className={cx(
				"h-10 w-16 rounded-extra-small border border-outline-variant bg-surface px-2 text-end tabular-nums outline-none focus-visible:focus-indicator",
				invalid && "border-error",
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
