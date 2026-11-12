import { type KeyboardEvent, useRef } from "react";
import { Link } from "react-router";
import { cx } from "~/components/cx";
import { finishRunningTransition } from "~/shell/transitions";
import type { Day } from "~/time/calendar";
import { formatDayOfMonth, formatWeekday } from "~/time/format";
import { focusItem, useRovingFocus } from "./calendar-focus";
import type { MonthSheet } from "./calendar-sheets";
import { ruleWords } from "./DayRules";
import { formatDuration } from "./durations";
import { useDayFormat } from "./format";
import type { CalendarData } from "./timesheet.server";
import { calendarPath, dayPath } from "./views";

/**
 * The month calendar (TS-062): the month's weeks from the organisation's week
 * start, each day with its total and a bar of its share of the busiest day,
 * today marked, the days of other months muted, and each week's total at the
 * row's end. A day opens the Day view; a week's total opens the week calendar.
 * A day of the month with a limit says what is left of it, one that takes no
 * time says "Closed" and why, and one over its limit by how much (TS-090).
 *
 * For assistive technology it is a grid of weeks by days; arrow keys move
 * between days, Home and End to a week's ends, and Enter opens.
 */

/** A day's bar, in twelfths of the busiest day: classes, not a `style` (docs/security.md). */
const SHARE = [
	"w-0",
	"w-1/12",
	"w-2/12",
	"w-3/12",
	"w-4/12",
	"w-5/12",
	"w-6/12",
	"w-7/12",
	"w-8/12",
	"w-9/12",
	"w-10/12",
	"w-11/12",
	"w-full",
] as const;

/** The column of each week's total, after the seven days. */
const TOTAL_COLUMN = 7;

export function CalendarMonth({
	data,
	slug,
	sheet,
	title,
}: {
	data: CalendarData;
	slug: string;
	sheet: MonthSheet;
	/** The month, as its heading reads: `November 2026`. */
	title: string;
}) {
	const { today, lockedDays, statuses, rules } = data;
	const formatLong = useDayFormat();

	const ids = new Set(
		sheet.weeks.flatMap((week) => [...week.days.map((d) => d.day), weekId(week)]),
	);
	const shown = sheet.weeks.flatMap((week) => week.days).find((d) => d.day === today && d.inMonth);
	const firstOfMonth = sheet.weeks.flatMap((week) => week.days).find((d) => d.inMonth);
	const { itemProps } = useRovingFocus(ids, (shown ?? firstOfMonth)?.day ?? "");
	const grid = useRef<HTMLTableElement>(null);

	function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
		const target = event.target as HTMLElement;
		if (target.dataset.focusId === undefined) return;
		let row = Number(target.dataset.row);
		let col = Number(target.dataset.col);
		const last = sheet.weeks.length - 1;
		switch (event.key) {
			case "ArrowLeft":
				col -= 1;
				break;
			case "ArrowRight":
				col += 1;
				break;
			case "ArrowUp":
				row -= 1;
				break;
			case "ArrowDown":
				row += 1;
				break;
			case "Home":
				col = 0;
				if (event.ctrlKey) row = 0;
				break;
			case "End":
				col = TOTAL_COLUMN;
				if (event.ctrlKey) row = last;
				break;
			default:
				return;
		}
		event.preventDefault();
		if (row < 0 || row > last || col < 0 || col > TOTAL_COLUMN) return;
		const week = sheet.weeks[row];
		if (!week) return;
		focusItem(grid.current, col === TOTAL_COLUMN ? weekId(week) : week.days[col]?.day);
	}

	const headDays = sheet.weeks[0]?.days ?? [];
	return (
		<div className="mt-6 overflow-hidden rounded-large border-2 border-on-surface">
			<table
				ref={grid}
				aria-label={`Month calendar, ${title}`}
				onKeyDown={onKeyDown}
				className="w-full table-fixed border-collapse"
			>
				<thead>
					<tr className="border-b-2 border-on-surface">
						{headDays.map(({ day }) => (
							<th
								key={day}
								scope="col"
								className="px-1 py-3 text-center text-label-large font-normal text-on-surface-variant medium:px-2 medium:text-start"
							>
								<span aria-hidden="true" className="medium:hidden">
									{formatWeekday(day, "narrow")}
								</span>
								<span aria-hidden="true" className="max-medium:hidden">
									{formatWeekday(day, "short")}
								</span>
								<span className="sr-only">{formatWeekday(day, "long")}</span>
							</th>
						))}
						<th
							scope="col"
							className="border-l border-outline-variant px-1 py-3 text-center text-label-large font-normal medium:px-2 medium:text-end"
						>
							Week<span className="sr-only"> total</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{sheet.weeks.map((week, row) => (
						<tr key={week.days[0]?.day} className="border-b border-outline-variant last:border-b-0">
							{week.days.map(({ day, total, overtime, inMonth }, col) => {
								const isToday = day === today;
								const locked = lockedDays.includes(day);
								const status = statuses[day];
								const muted = !inMonth || status?.quiet;
								const share = sheet.busiest === 0 ? 0 : Math.round((total / sheet.busiest) * 12);
								const rule = inMonth && !locked ? rules.find((r) => r.day === day) : undefined;
								const words = ruleWords(rule);
								return (
									<td
										key={day}
										className={cx(
											"border-l border-outline-variant p-0 align-top first:border-l-0",
											(muted || locked) && "bg-surface-container-low",
										)}
									>
										<Link
											to={dayPath(slug, day)}
											onClick={finishRunningTransition}
											aria-current={isToday ? "date" : undefined}
											data-row={row}
											data-col={col}
											{...itemProps(day)}
											className={cx(
												"flex min-h-18 flex-col gap-1 p-1 outline-none state-layer transition-control hover:state-hover focus-visible:focus-indicator-inner medium:min-h-24 medium:p-2",
												muted ? "text-on-surface-variant" : "text-on-surface",
											)}
										>
											<span className="flex items-center justify-between gap-1">
												<span
													aria-hidden="true"
													className={cx(
														"flex size-6 shrink-0 items-center justify-center rounded-full text-label-large tabular-nums",
														isToday && "bg-primary-container text-on-primary-fixed",
													)}
												>
													{Number(day.slice(8))}
												</span>
												{(locked || status) && (
													<span
														aria-hidden="true"
														className="max-medium:size-1.5 max-medium:shrink-0 max-medium:rounded-full max-medium:bg-on-surface-variant medium:min-w-0 medium:truncate medium:text-label-small"
													>
														<span className="max-medium:hidden">
															{status?.label ?? "Submitted"}
														</span>
													</span>
												)}
											</span>
											<span
												aria-hidden="true"
												className="mt-auto min-h-4 truncate text-label-medium tabular-nums medium:text-label-large"
											>
												{total > 0 ? formatDuration(total) : ""}
											</span>
											{overtime > 0 && (
												<span
													aria-hidden="true"
													className="truncate text-label-small text-on-surface-variant tabular-nums"
												>
													{formatDuration(overtime)} overtime
												</span>
											)}
											{words && (
												<span
													aria-hidden="true"
													title={rule?.closedReason ?? undefined}
													className={cx(
														"truncate text-label-small",
														words.over ? "text-error" : "text-on-surface-variant",
													)}
												>
													{words.text}
												</span>
											)}
											<span
												aria-hidden="true"
												className={cx(
													"block h-1 w-full rounded-full",
													total > 0 && "bg-surface-container-highest",
												)}
											>
												<span
													className={cx(
														"block h-1 rounded-full bg-on-surface-variant",
														SHARE[share],
													)}
												/>
											</span>
											<span className="sr-only">
												{[
													isToday ? "Today" : null,
													formatLong(day),
													formatDuration(total),
													overtime > 0 ? `${formatDuration(overtime)} of it overtime` : null,
													status?.label,
													locked ? "submitted" : null,
													words?.text,
													rule?.closedReason,
												]
													.filter(Boolean)
													.join(", ")}
											</span>
										</Link>
									</td>
								);
							})}
							<td className="border-l border-outline-variant p-0 align-top">
								<Link
									to={calendarPath(slug, { scale: "week", date: week.days[0]?.day })}
									onClick={finishRunningTransition}
									data-row={row}
									data-col={TOTAL_COLUMN}
									{...itemProps(weekId(week))}
									className="flex min-h-18 flex-col items-center justify-end p-1 outline-none state-layer transition-control hover:state-hover focus-visible:focus-indicator-inner medium:min-h-24 medium:items-end medium:p-2"
								>
									<span
										aria-hidden="true"
										className="text-label-medium tabular-nums medium:text-title-small"
									>
										{formatDuration(week.total)}
									</span>
									<span className="sr-only">
										Week of {formatDayOfMonth(week.days[0]?.day as Day)},{" "}
										{formatDuration(week.total)}
									</span>
								</Link>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const weekId = (week: MonthSheet["weeks"][number]) => `week:${week.days[0]?.day}`;
