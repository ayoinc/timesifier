import { useEffect, useRef } from "react";

import { cx } from "~/components/cx";

import { DAYS, dayTotals, duration, longestProject, week, weekTotal } from "./example-week";

const DAY_COLUMN = "px-3 py-3 text-end max-medium:hidden";
const TIME = "text-title-large tabular-nums";

/**
 * A project's share of the longest project, drawn as a bar. The number beside it
 * says the same. The bar grows to its length when the table arrives in the window
 * (`grow-bar` in public.css).
 */
function Bar({ minutes }: { minutes: number }) {
	return (
		<svg aria-hidden="true" className="mt-2 block h-1.5 w-full" preserveAspectRatio="none">
			<rect width="100%" height="100%" className="fill-surface-container-highest" />
			<rect
				width={`${(minutes / longestProject) * 100}%`}
				height="100%"
				className="grow-bar fill-on-surface"
			/>
		</svg>
	);
}

/**
 * A total that counts up to its value when the table arrives in the window
 * (`count-up` in public.css), in the time its bar takes to grow, and then is the
 * value: it never rests on a number that is not the sum. The value itself is
 * always in the markup: it holds the room, it is what a screen reader reads, and
 * it is what shows without script and with reduced motion.
 */
function Counted({ minutes }: { minutes: number }) {
	const figure = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		// The style sheet needs the number to count to. It is set through the CSSOM:
		// the Content Security Policy allows no `style` attribute in the markup.
		figure.current?.style.setProperty("--count-to", String(minutes));
	}, [minutes]);

	return (
		<span ref={figure} className="count-up">
			<span className="count-up-value">{duration(minutes)}</span>
		</span>
	);
}

/**
 * Says on the table when it comes into the window, for the bars and the totals
 * to arrive: `data-arrival` is "waiting" while it is still below the window and
 * "arrived" from then on. A table that is already in the window when script
 * takes the page over is left as the server drew it: nothing a person is looking
 * at goes back to nothing. A style sheet cannot start a movement, once, on
 * arrival, which is why this is script.
 */
function useArrival() {
	const table = useRef<HTMLTableElement>(null);

	useEffect(() => {
		const element = table.current;
		if (!element) return;
		let first = true;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) {
					if (!first) element.dataset.arrival = "arrived";
					observer.disconnect();
				} else if (first) {
					element.dataset.arrival = "waiting";
				}
				first = false;
			},
			// A fifth of the window's height is on show before it counts as arrived.
			{ rootMargin: "0px 0px -20% 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return table;
}

/**
 * A week as a timetable: a row for each project, a column for each day, and a
 * total at the end of every row and column. It is a finished week, an example
 * with no date: nothing in it is running. Under 600px the days are left out and
 * each project keeps its bar and its total.
 */
export function WeekReport() {
	const table = useArrival();

	return (
		<table ref={table} className="week-report w-full border-collapse text-body-large">
			<caption className="pb-4 text-start text-label-large text-on-surface-variant">
				An example week: hours and minutes by project and day.
			</caption>
			<thead>
				<tr className="border-y-2 border-on-surface text-label-large">
					<th scope="col" className="py-3 pe-3 text-start">
						Project
					</th>
					{DAYS.map((day) => (
						<th key={day.name} scope="col" className={DAY_COLUMN}>
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
									minutes === 0 && "text-on-surface-variant",
								)}
							>
								{duration(minutes)}
							</td>
						))}
						<td className={cx("py-3 ps-3 text-end", TIME)}>
							<Counted minutes={row.total} />
						</td>
					</tr>
				))}
			</tbody>
			<tfoot>
				<tr className="border-y-2 border-on-surface">
					<th scope="row" className="py-3 pe-3 text-start text-label-large">
						Total
					</th>
					{dayTotals.map((minutes, index) => (
						<td key={DAYS[index]?.name} className={cx(DAY_COLUMN, TIME)}>
							{duration(minutes)}
						</td>
					))}
					<td className="py-3 ps-3 text-end text-headline-large tabular-nums">
						<Counted minutes={weekTotal} />
					</td>
				</tr>
			</tfoot>
		</table>
	);
}
