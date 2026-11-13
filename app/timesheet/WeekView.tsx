import { useEffect, useRef, useState, ViewTransition } from "react";
import { Link, useFetcher } from "react-router";

import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import { PeriodStepper } from "~/components/PeriodStepper";
import { Select } from "~/components/Select";
import { type DayRule, leftMessage, overLabel, wholeMinutes } from "~/leave/rules";
import { lockDateNotice } from "~/locks/locks";
import type { Outcome } from "~/organisations/problems";
import { TRANSITION, useTravel } from "~/shell/transitions";
import { addDays, type Day } from "~/time/calendar";

import { type Aim, stepsAround } from "./aim";
import { ClosedDays, OvertimeTag, RuleLine } from "./DayRules";
import { cellText, formatDuration, minutesToMs, TypedHours } from "./durations";
import { useReportAnswer } from "./feedback";
import { dayNumber, useDayFormat, usePeriodFormat } from "./format";
import { PeriodHeader } from "./Submission";
import { type GridCell, type GridRow, isTypable, rowKey, weekSheet } from "./sheets";
import { ShortcutsSheet, useTimesheetKeys } from "./shortcuts";
import type { WeekData } from "./timesheet.server";
import { dayPath, timerAction, weekPath } from "./views";

/**
 * The Week view (TS-013, TS-052, TS-046): the period's seven days as a grid of
 * projects by days, hours typed into a cell, a total per day, per project and
 * for the week. Its header row says where the period stands, with "Submit
 * week" at its end (`PeriodHeader`, which the Day and Calendar views share);
 * a returned one shows why. A day with a limit shows what is left of it, a
 * day that takes no time is read-only and says why, and a day over its limit
 * says by how much (TS-090). While any day of the week takes overtime, or a
 * project has some, each project has an overtime row under its regular time,
 * whose cells are its overtime on each day (TS-095).
 */
export function WeekView({ data, slug, aim }: { data: WeekData; slug: string; aim: Aim | null }) {
	const { period, days, lockedDays, lockDate, projects, today } = data;
	const formatPeriod = usePeriodFormat();
	const formatDay = useDayFormat();
	const travel = useTravel(dayNumber(period.startsOn));
	// A press answered before the server (TS-114): the week it asks for is the
	// one the stepper shows at once, and what it replaces dims.
	const leaving = aim !== null && aim.view !== "week";
	const shownStart = aim?.view === "week" ? aim.start : period.startsOn;
	const awaiting = leaving || shownStart !== period.startsOn;
	const steps = stepsAround(slug, { view: "week", start: shownStart }, data.weekStartsOn);
	const [said, setSaid] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);

	// Rows added with no time yet, which the server does not know of: kept here,
	// for each week visited, until hours are typed into them.
	const [addedByWeek, setAddedByWeek] = useState<Record<string, string[]>>({});
	const added = addedByWeek[period.startsOn] ?? [];
	const sheet = weekSheet([], days, data.zone, data.now, { addedRows: added });
	const rows = withOvertimeRows(
		[
			...data.sheet.rows,
			...sheet.rows.filter((row) => !data.sheet.rows.some((r) => r.projectId === row.projectId)),
		],
		days,
		data.rules.some((rule) => rule.overtimeOpen),
	);
	const inGrid = new Set(rows.map((row) => row.projectId));
	const addable = projects.filter((p) => !p.archived && !inGrid.has(p.id));
	const editable = lockedDays.length < days.length;
	const shownEnd = addDays(shownStart, 6);
	const thisWeek = shownStart <= today && today <= shownEnd;

	// N adds a row (taste HT-D): the project chosen to add, or the first not in the grid, with its first open cell focused.
	const [chosen, setChosen] = useState<string | null>(null);
	const pick = chosen && addable.some((p) => p.id === chosen) ? chosen : (addable[0]?.id ?? null);
	const addRows = (ids: string[]) => {
		setAddedByWeek((all) => ({
			...all,
			[period.startsOn]: [...added, ...ids.filter((id) => !added.includes(id))],
		}));
		setSaid(
			ids.length === 1
				? `${projects.find((p) => p.id === ids[0])?.name} added.`
				: `${ids.length} rows added.`,
		);
		requestAnimationFrame(() =>
			document
				.querySelector<HTMLInputElement>(
					`[data-row="${ids[0]}"] input:not([readonly]):not([disabled])`,
				)
				?.focus(),
		);
	};
	const keys = useTimesheetKeys({
		onNew: editable && pick ? () => addRows([pick]) : undefined,
		previous: steps.previous,
		next: steps.next,
		today: weekPath(slug),
	});

	// "Copy last week with hours" (taste HT-F), answered in the snackbar.
	const copy = useFetcher<Outcome>();
	const copied = copy.state === "idle" ? copy.data : undefined;
	useReportAnswer(copied);
	useEffect(() => {
		if (copied && !copied.ok) setProblem(copied.problem);
	}, [copied]);

	return (
		<>
			<div className={cx("mt-6", leaving && "awaiting")}>
				<PeriodStepper
					label="Weeks"
					period={formatPeriod(shownStart, shownEnd)}
					previous={{ to: steps.previous, label: "Previous week" }}
					next={{ to: steps.next, label: "Next week" }}
					current={thisWeek ? undefined : { to: weekPath(slug), label: "Back to this week" }}
				/>
			</div>

			<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
				<div className={cx("mt-6", awaiting && "awaiting")}>
					<PeriodHeader
						title={formatPeriod(period.startsOn, period.endsOn)}
						submission={data}
						onSaid={setSaid}
					/>
					{lockDate && period.startsOn <= lockDate.lockedThrough && (
						<p className="mt-2 max-w-160 text-body-large">{lockDateNotice(lockDate, formatDay)}</p>
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
							pick={pick}
							onPick={setChosen}
							lastWeek={data.lastWeekProjects.filter((id) => !inGrid.has(id))}
							onAdd={addRows}
							canCopyWeek={data.canCopyWeek}
							copyingWeek={copy.state !== "idle"}
							onCopyWeek={() =>
								copy.submit(
									{ intent: "copy-week", startsOn: period.startsOn },
									{ method: "post", action: timerAction(slug) },
								)
							}
						/>
					)}
				</div>
			</ViewTransition>
			<ShortcutsSheet isOpen={keys.helpOpen} onOpenChange={keys.setHelpOpen} />
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
	// The time of one kind on a day, across every row: what a cell's change is checked against.
	const kindTotal = (day: string, overtime: boolean) => {
		const totals = sheet.days.find((each) => each.day === day);
		if (!totals) return 0;
		return overtime ? totals.overtime : totals.total - totals.overtime;
	};
	const weekOvertime = sheet.days.reduce((sum, each) => sum + each.overtime, 0);
	// Today's column is amber in the week that holds it, and no other (taste HT-B).
	const todayColumn = (day: string) =>
		day === data.today ? "bg-primary-container text-on-primary-fixed" : undefined;

	return (
		<>
			{/* Relative, so the grid's visually hidden words are placed inside the
			    scroller and clipped by it, not out past the window's edge (audit W02). */}
			<div className="relative mt-6 overflow-x-auto rounded-large border-2 border-on-surface">
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
									<th
										key={day}
										scope="col"
										aria-current={day === data.today ? "date" : undefined}
										className={cx("px-2 py-3 text-end", todayColumn(day))}
									>
										<Link
											to={dayPath(slug, day)}
											className="rounded-extra-small underline-offset-4 outline-none hover:underline focus-visible:focus-indicator"
										>
											{formatDay(day)}
										</Link>
										{marked?.label && (
											<span
												className={cx(
													"ms-auto block max-w-24 truncate text-label-small font-normal",
													day === data.today ? undefined : "text-on-surface-variant",
												)}
											>
												{marked.label}
											</span>
										)}
										{marked?.hours && (
											<span
												className={cx(
													"block text-label-small font-normal whitespace-nowrap tabular-nums",
													day === data.today ? undefined : "text-on-surface-variant",
												)}
											>
												{marked.hours}
											</span>
										)}
										<span className="flex justify-end font-normal">
											<RuleLine rule={ruleOf(day)} onAmber={day === data.today} />
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
									No hours this week. Add a row below and type them in, or copy last week's.
								</td>
							</tr>
						)}
						{rows.map((row) => (
							<tr
								key={rowKey(row.projectId, row.overtime)}
								data-row={rowKey(row.projectId, row.overtime)}
							>
								<th scope="row" className="max-w-60 truncate px-4 py-2 text-start font-normal">
									{row.overtime ? (
										<span className="flex items-center gap-2 ps-4">
											<span className="sr-only">{nameOf(row.projectId)}, </span>
											<OvertimeTag />
										</span>
									) : (
										nameOf(row.projectId)
									)}
								</th>
								{row.cells.map((cell) => (
									<td
										key={cell.day}
										className={cx("px-1 py-1 text-end tabular-nums", todayColumn(cell.day))}
									>
										<Cell
											cell={cell}
											projectId={row.projectId}
											overtime={row.overtime}
											label={`${nameOf(row.projectId)}, ${row.overtime ? "overtime, " : ""}${formatLong(cell.day)}`}
											locked={lockedDays.includes(cell.day)}
											rule={ruleOf(cell.day)}
											kindTotal={kindTotal(cell.day, row.overtime)}
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
									<td
										key={each.day}
										className={cx("px-2 py-3 text-end tabular-nums", todayColumn(each.day))}
									>
										{formatDuration(each.total)}
										{each.overtime > 0 && (
											<span
												className={cx(
													"block text-label-small",
													each.day === data.today ? undefined : "text-on-surface-variant",
												)}
											>
												<span className="sr-only">, </span>
												{formatDuration(each.overtime)} overtime
											</span>
										)}
										{over > 0 && (
											<span
												className={cx(
													"block text-label-small",
													each.day === data.today ? undefined : "text-error",
												)}
											>
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
								{weekOvertime > 0 && (
									<span className="block text-label-small text-on-surface-variant">
										<span className="sr-only">, </span>
										{formatDuration(weekOvertime)} overtime
									</span>
								)}
							</td>
						</tr>
						<tr className="text-on-surface-variant">
							<th scope="row" className="px-4 pb-3 text-start text-label-large font-normal">
								Expected
							</th>
							{away.days.map((each) => (
								<td
									key={each.day}
									className={cx("px-2 pb-3 text-end tabular-nums", todayColumn(each.day))}
								>
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
 * view, where it can be trimmed or moved. A cell of an overtime row is held
 * to the overtime its day still takes, and is read-only on a day that takes
 * none (TS-095).
 */
function Cell({
	cell,
	projectId,
	overtime,
	label,
	locked,
	rule,
	kindTotal,
	slug,
	onSaved,
	onProblem,
}: {
	cell: GridCell;
	projectId: string;
	/** Whether the cell is the project's overtime on its day. */
	overtime: boolean;
	label: string;
	locked: boolean;
	/** The day's limit; undefined for a row added before the server knows of it. */
	rule: DayRule | undefined;
	/** The time of the cell's kind on its day across every row, in milliseconds. */
	kindTotal: number;
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
	const reason =
		rule?.closedReason ?? (overtime && rule && !rule.overtimeOpen ? rule.noOvertimeReason : null);
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
		const refusal =
			typed.success && rule
				? cellRefusal(rule, overtime, cell.total, kindTotal, minutesToMs(typed.data))
				: null;
		if (refusal) {
			setRefused(true);
			onProblem(`${label}: ${refusal}`);
			return;
		}
		setRefused(false);
		fetcher.submit(
			{ intent: "cell", projectId, day: cell.day, hours: value, overtime: String(overtime) },
			{ method: "post" },
		);
	};
	const invalid = refused || (answer !== undefined && !answer.ok);
	return (
		<input
			type="text"
			inputMode="decimal"
			autoComplete="off"
			aria-label={cellLabel(label, rule, overtime)}
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
				"h-11 w-16 rounded-extra-small border border-outline-variant bg-surface px-2 text-on-surface text-end tabular-nums outline-none focus-visible:focus-indicator",
				invalid && "border-error",
			)}
		/>
	);
}

/**
 * What a cell's change would take its day past, checked before it is sent:
 * the day's regular time, or the overtime it still takes. Null when it fits,
 * and always for a change that adds nothing, so a day over can be trimmed.
 */
function cellRefusal(
	rule: DayRule,
	overtime: boolean,
	beforeMs: number,
	kindMs: number,
	afterMs: number,
): string | null {
	if (afterMs <= beforeMs) return null;
	if (overtime) {
		if (!rule.overtimeOpen) return rule.noOvertimeReason ?? rule.closedReason;
		const left = rule.overtimeLeftMinutes;
		if (left === null || wholeMinutes(afterMs - beforeMs) <= left) return null;
		return `This day has ${formatDuration(left * 60_000)} of overtime left.`;
	}
	if (rule.limitMinutes === null) return null;
	const othersMs = Math.max(0, kindMs - beforeMs);
	if (wholeMinutes(othersMs + afterMs) <= rule.limitMinutes) return null;
	const left = leftMessage(Math.max(0, rule.limitMinutes - wholeMinutes(othersMs)));
	return rule.overtimeOpen ? `${left} Track more as overtime.` : left;
}

/** A cell's name with what its day has left of the cell's kind. */
function cellLabel(label: string, rule: DayRule | undefined, overtime: boolean): string {
	const left = overtime ? rule?.overtimeLeftMinutes : rule?.leftMinutes;
	return left != null ? `${label}, ${formatDuration(left * 60_000)} left` : label;
}

/**
 * The rows as the grid shows them: each project's regular time, then, while
 * any day of the week takes overtime, its overtime, empty where it has none.
 * A project with overtime alone keeps a regular row above it.
 */
function withOvertimeRows(
	rows: readonly GridRow[],
	days: readonly Day[],
	overtimeOpen: boolean,
): GridRow[] {
	const empty = (projectId: string, overtime: boolean): GridRow => ({
		projectId,
		overtime,
		cells: days.map((day) => ({ day, total: 0, entries: 0, running: false, entryId: null })),
		total: 0,
	});
	const shown: GridRow[] = [];
	for (const projectId of new Set(rows.map((row) => row.projectId))) {
		const of = (overtime: boolean) =>
			rows.find((row) => row.projectId === projectId && row.overtime === overtime);
		shown.push(of(false) ?? empty(projectId, false));
		const extra = of(true) ?? (overtimeOpen ? empty(projectId, true) : undefined);
		if (extra) shown.push(extra);
	}
	return shown;
}

/**
 * "Add row" for a project with no time yet, and the copies of the last week
 * with time: its rows alone (TS-052), or its hours too (taste HT-F), which
 * never touch a day that has time or is locked.
 */
function AddRows({
	addable,
	pick,
	onPick,
	lastWeek,
	onAdd,
	canCopyWeek,
	copyingWeek,
	onCopyWeek,
}: {
	addable: WeekData["projects"];
	pick: string | null;
	onPick: (id: string) => void;
	lastWeek: string[];
	onAdd: (ids: string[]) => void;
	canCopyWeek: boolean;
	/** Whether "Copy last week with hours" is on its way. */
	copyingWeek: boolean;
	onCopyWeek: () => void;
}) {
	return (
		<div className="mt-4 flex flex-wrap items-end gap-4">
			{addable.length > 0 && (
				<>
					<div className="w-72 max-w-full">
						<Select
							label="Project to add"
							options={addable.map((p) => ({ id: p.id, label: p.name }))}
							value={pick}
							onChange={(id) => id && onPick(id)}
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
			{canCopyWeek && (
				<Button variant="text" isPending={copyingWeek} onPress={onCopyWeek}>
					Copy last week with hours
				</Button>
			)}
		</div>
	);
}
