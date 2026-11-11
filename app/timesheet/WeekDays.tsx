import { Link } from "react-router";

import { cx } from "~/components/cx";
import { finishRunningTransition } from "~/shell/transitions";
import type { Day } from "~/time/calendar";

import { formatDuration } from "./durations";
import { useDayFormat } from "./format";
import type { DayData } from "./timesheet.server";
import { dayPath } from "./views";

/**
 * Above the Day view's day (TS-056): the seven days of its period, each a link
 * to its day with the time tracked on it, the day shown marked, and the
 * period's total. The totals are the Week view's, added up by the same
 * `weekSheet`.
 */
export function WeekDays({ week, day, slug }: { week: DayData["week"]; day: Day; slug: string }) {
	const formatShort = useDayFormat("short");
	const formatLong = useDayFormat();
	return (
		<div className="mt-6 flex max-w-200 flex-col gap-2 medium:flex-row medium:items-stretch">
			{/* A group, not a landmark: the shell's one navigation landmark is the main one. */}
			<fieldset className="min-w-0 flex-1">
				<legend className="sr-only">Days of the week</legend>
				<ol className="grid grid-cols-7 gap-1">
					{week.days.map((each) => {
						const isShown = each.day === day;
						return (
							<li key={each.day} className="min-w-0">
								<Link
									to={dayPath(slug, each.day)}
									preventScrollReset
									onClick={finishRunningTransition}
									aria-current={isShown ? "date" : undefined}
									className={cx(
										"flex min-h-14 flex-col items-center justify-center rounded-medium px-1 py-1 outline-none state-layer transition-control hover:state-hover focus-visible:focus-indicator",
										isShown
											? "border-2 border-on-surface text-on-surface"
											: "border border-outline-variant text-on-surface-variant",
									)}
								>
									<span className="text-label-medium">
										<span aria-hidden="true">{formatShort(each.day)}</span>
										<span className="sr-only">{formatLong(each.day)}</span>
									</span>
									<span className="sr-only">, </span>
									<span className="text-label-large tabular-nums">
										{formatDuration(each.total)}
									</span>
								</Link>
							</li>
						);
					})}
				</ol>
			</fieldset>
			<p className="flex items-baseline justify-between gap-4 rounded-medium border-2 border-on-surface px-4 py-2 medium:flex-col medium:items-end medium:justify-center">
				<span className="text-label-large">Week total</span>
				<span className="text-title-medium tabular-nums">{formatDuration(week.total)}</span>
			</p>
		</div>
	);
}
