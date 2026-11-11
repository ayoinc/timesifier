import { cx } from "~/components/cx";

import { useRunningDay } from "./RunningDay";

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** A month takes room for as many weeks as it has. */
const ROOM = { 4: "grow-4", 5: "grow-5" } as const;

/**
 * The year in weeks, a mark for each, with this week standing above the rest:
 * the last and largest of the scales the page counts in. Seconds on the timer,
 * minutes and hours on the day, days in the week, and the week here, in its month
 * and its year. The weeks behind are filled and the ones ahead are open. It is
 * the visitor's own year once the clock runs, and the example's before.
 */
export function YearStrip() {
	const {
		week: { year, week, months },
	} = useRunningDay();
	const weeks = months.reduce((total, each) => total + each, 0);
	let before = 0;

	return (
		<figure>
			<div
				role="img"
				aria-label={`${year} in weeks. This is week ${week} of ${weeks}.`}
				className="flex items-end gap-1 medium:gap-2"
			>
				{months.map((count, month) => {
					const first = before + 1;
					before += count;
					return (
						<div
							key={MONTHS[month]}
							className={cx("flex min-w-0 basis-0 flex-col gap-2", ROOM[count === 5 ? 5 : 4])}
						>
							<div className="flex items-end gap-px medium:gap-0.5">
								{Array.from({ length: count }, (_, index) => first + index).map((each) => (
									<span
										key={each}
										className={cx(
											"flex-1 rounded-extra-small border border-on-sheet",
											each === week ? "h-8 bg-on-sheet" : "h-4",
											each < week && "bg-on-sheet opacity-50",
										)}
									/>
								))}
							</div>
							<span className="text-label-medium text-on-sheet-variant">
								<span className="medium:hidden">{MONTHS[month]?.slice(0, 1)}</span>
								<span className="max-medium:hidden">{MONTHS[month]?.slice(0, 3)}</span>
							</span>
						</div>
					);
				})}
			</div>
			<figcaption className="mt-3 flex items-baseline justify-between gap-4 border-t-2 border-on-sheet pt-3 text-label-large">
				<span>{year}, in weeks</span>
				<span className="tabular-nums">
					Week {week} of {weeks}
				</span>
			</figcaption>
		</figure>
	);
}
