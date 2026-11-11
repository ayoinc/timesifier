import { cx } from "~/components/cx";

import {
	DAYS,
	dayTotals,
	duration,
	longestProject,
	TODAY,
	WEEK_LABEL,
	week,
	weekTotal,
} from "./example-week";

const DAY_COLUMN = "px-3 py-3 text-end max-medium:hidden";
const TIME = "text-title-large tabular-nums";
const TODAY_CELL = "bg-primary-container text-on-primary-fixed";

/** A project's share of the longest project, drawn as a bar. The number beside it says the same. */
function Bar({ minutes }: { minutes: number }) {
	return (
		<svg aria-hidden="true" className="mt-2 block h-1.5 w-full" preserveAspectRatio="none">
			<rect width="100%" height="100%" className="fill-surface-container-highest" />
			<rect
				width={`${(minutes / longestProject) * 100}%`}
				height="100%"
				className="fill-on-surface"
			/>
		</svg>
	);
}

/**
 * The week as a timetable: a row for each project, a column for each day, and a
 * total at the end of every row and column. Under 600px the days are left out
 * and each project keeps its bar and its total.
 */
export function WeekReport() {
	return (
		<table className="w-full border-collapse text-body-large">
			<caption className="pb-4 text-start text-label-large text-on-surface-variant">
				{WEEK_LABEL}. An example: hours and minutes by project and day.
			</caption>
			<thead>
				<tr className="border-y-2 border-on-surface text-label-large">
					<th scope="col" className="py-3 pe-3 text-start">
						Project
					</th>
					{DAYS.map((day, index) => (
						<th
							key={day.name}
							scope="col"
							className={cx(DAY_COLUMN, index === TODAY && TODAY_CELL)}
						>
							<abbr title={day.name} className="no-underline">
								{day.short}
							</abbr>{" "}
							{day.date}
						</th>
					))}
					<th scope="col" className="py-3 ps-3 text-end">
						Total
					</th>
				</tr>
			</thead>
			<tbody className="divide-y divide-outline-variant">
				{week.map((row) => (
					<tr key={row.project}>
						<th scope="row" className="w-full py-3 pe-3 text-start font-normal medium:w-1/3">
							{row.project}
							<Bar minutes={row.total} />
						</th>
						{row.days.map((minutes, index) => (
							<td
								key={DAYS[index]?.name}
								className={cx(
									DAY_COLUMN,
									TIME,
									"font-normal",
									index === TODAY ? TODAY_CELL : minutes === 0 && "text-on-surface-variant",
								)}
							>
								{duration(minutes)}
							</td>
						))}
						<td className={cx("py-3 ps-3 text-end", TIME)}>{duration(row.total)}</td>
					</tr>
				))}
			</tbody>
			<tfoot>
				<tr className="border-y-2 border-on-surface">
					<th scope="row" className="py-3 pe-3 text-start text-label-large">
						Total
					</th>
					{dayTotals.map((minutes, index) => (
						<td
							key={DAYS[index]?.name}
							className={cx(DAY_COLUMN, TIME, index === TODAY && TODAY_CELL)}
						>
							{duration(minutes)}
						</td>
					))}
					<td className="py-3 ps-3 text-end text-headline-large tabular-nums">
						{duration(weekTotal)}
					</td>
				</tr>
			</tfoot>
		</table>
	);
}
