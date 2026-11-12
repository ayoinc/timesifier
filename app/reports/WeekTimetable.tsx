import { cx } from "~/components/cx";

const DAY_COLUMN = "px-3 py-3 text-end max-medium:hidden";
const TIME = "text-title-large tabular-nums";

export interface TimetableProps {
	/** What the table holds, in a sentence. */
	caption: string;
	days: { day: string; short: string; name: string; isToday: boolean }[];
	rows: { key: string; label: string; cells: string[]; total: string; empty: boolean[] }[];
	dayTotals: string[];
	total: string;
}

/**
 * A week of a report as a timetable (harvest-taste item 10): a row for each
 * project, a column for each day, and a total at the end of every row and
 * column, drawn as the home page's week is (app/landing/WeekReport.tsx).
 * Today's column is amber in the current week, and nothing is in any other.
 * Under 600px the days are left out and each project keeps its total.
 */
export function WeekTimetable({ caption, days, rows, dayTotals, total }: TimetableProps) {
	const today = (index: number) => days[index]?.isToday === true;
	const amber = "bg-sheet text-on-sheet";
	return (
		<table className="w-full border-collapse text-body-large">
			<caption className="pb-4 text-start text-label-large text-on-surface-variant">
				{caption}
			</caption>
			<thead>
				<tr className="border-y-2 border-on-surface text-label-large">
					<th scope="col" className="py-3 pe-3 text-start">
						Project
					</th>
					{days.map((day, index) => (
						<th
							key={day.day}
							scope="col"
							aria-current={day.isToday ? "date" : undefined}
							className={cx(DAY_COLUMN, today(index) && amber)}
						>
							<abbr title={day.name} className="no-underline">
								{day.short}
							</abbr>
						</th>
					))}
					<th scope="col" className="py-3 ps-3 text-end">
						Total
					</th>
				</tr>
			</thead>
			<tbody className="divide-y divide-outline-variant">
				{rows.map((row) => (
					<tr key={row.key}>
						<th
							scope="row"
							className="w-full py-3 pe-3 text-start font-normal wrap-anywhere medium:w-1/3"
						>
							{row.label}
						</th>
						{row.cells.map((cell, index) => (
							<td
								key={days[index]?.day}
								className={cx(
									DAY_COLUMN,
									TIME,
									today(index) ? amber : row.empty[index] === true && "text-on-surface-variant",
								)}
							>
								{cell}
							</td>
						))}
						<td className={cx("py-3 ps-3 text-end", TIME)}>{row.total}</td>
					</tr>
				))}
			</tbody>
			<tfoot>
				<tr className="border-y-2 border-on-surface">
					<th scope="row" className="py-3 pe-3 text-start text-label-large">
						Total
					</th>
					{dayTotals.map((cell, index) => (
						<td key={days[index]?.day} className={cx(DAY_COLUMN, TIME, today(index) && amber)}>
							{cell}
						</td>
					))}
					<td className="py-3 ps-3 text-end text-headline-large tabular-nums">{total}</td>
				</tr>
			</tfoot>
		</table>
	);
}
