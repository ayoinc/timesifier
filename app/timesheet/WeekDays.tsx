import { Link } from "react-router";

import { cx } from "~/components/cx";
import { StartArrowhead } from "~/components/TimerMark";
import { type DayRule, overLabel } from "~/leave/rules";
import { finishRunningTransition } from "~/shell/transitions";
import { type Day, dayOf } from "~/time/calendar";

import { formatDuration } from "./durations";
import { useDayFormat } from "./format";
import type { SheetEntry } from "./sheets";
import type { DayData } from "./timesheet.server";
import { dayPath } from "./views";

/** The one word a day of the strip shows under its total, where seven fit in 390px; its full name is read out. */
const SHORT: Partial<Record<DayData["away"]["days"][number]["kind"], string>> = {
	leave: "Leave",
	holiday: "Holiday",
	"not-a-working-day": "Off",
};

/**
 * Above the Day view's day (TS-056): the seven days of its period, each a link
 * to its day with the time tracked on it, the day shown marked, and the
 * period's total. The totals are the Week view's, added up by the same
 * `weekSheet`. A day of leave, a public holiday and a day not worked say so
 * (TS-061), a day over its limit says "Over" (TS-090), and the period's total
 * stands beside the time expected over it. Today is amber and the day shown
 * keeps the ink frame; the day of a running timer has the mark's arrowhead
 * after its total (taste HT-B). Each chip writes its weekday and date on two
 * lines under 600px, so none wraps where the others do not (audit W16).
 */
export function WeekDays({
	week,
	away,
	rules,
	day,
	today,
	running,
	zone,
	slug,
	awaiting,
}: {
	week: DayData["week"];
	away: DayData["away"];
	rules: readonly DayRule[];
	day: Day;
	today: Day;
	running: SheetEntry | null;
	zone: string;
	slug: string;
	/** Whether another week is on its way, so this one dims. */
	awaiting: boolean;
}) {
	const formatShort = useDayFormat("short");
	const formatLong = useDayFormat();
	const runningOn = running ? dayOf(running.startedAt, zone) : null;
	return (
		<div
			className={cx(
				"mt-6 flex max-w-200 flex-col gap-2 medium:flex-row medium:items-stretch",
				awaiting && "awaiting",
			)}
		>
			{/* A group, not a landmark: the shell's one navigation landmark is the main one. */}
			<fieldset className="min-w-0 flex-1">
				<legend className="sr-only">Days of the week</legend>
				<ol className="grid grid-cols-7 gap-1">
					{week.days.map((each, index) => {
						const isShown = each.day === day;
						const isToday = each.day === today;
						const [weekday, date] = formatShort(each.day).split(" ");
						const marked = away.days[index];
						const short = marked ? SHORT[marked.kind] : undefined;
						const over = rules.find((rule) => rule.day === each.day)?.overMinutes ?? 0;
						return (
							<li key={each.day} className="min-w-0">
								<Link
									to={dayPath(slug, each.day)}
									preventScrollReset
									onClick={finishRunningTransition}
									aria-current={isShown ? "date" : undefined}
									className={cx(
										"flex h-full min-h-14 flex-col items-center justify-center rounded-medium px-0.5 py-1 outline-none state-layer transition-control hover:state-hover focus-visible:focus-indicator",
										isShown ? "border-2 border-on-surface" : "border border-outline-variant",
										isToday
											? "over-primary-container text-on-primary-fixed"
											: isShown
												? "text-on-surface"
												: "text-on-surface-variant",
									)}
								>
									<span className="text-label-medium">
										<span
											aria-hidden="true"
											className="flex flex-col items-center whitespace-nowrap medium:flex-row medium:gap-1"
										>
											<span>{weekday}</span> <span>{date}</span>
										</span>
										<span className="sr-only">
											{isToday ? "Today, " : ""}
											{formatLong(each.day)}
										</span>
									</span>
									<span className="sr-only">, </span>
									<span className="flex items-center gap-0.5 text-label-large tabular-nums">
										{formatDuration(each.total)}
										{runningOn === each.day && (
											<>
												<StartArrowhead className="size-2.5" />
												<span className="sr-only">, timer running</span>
											</>
										)}
									</span>
									{short && marked?.label && (
										<span className="max-w-full truncate text-label-small">
											<span className="sr-only">, </span>
											<span aria-hidden="true">{short}</span>
											<span className="sr-only">{marked.label}</span>
										</span>
									)}
									{over > 0 && (
										<span className={cx("text-label-small", isToday ? undefined : "text-error")}>
											<span className="sr-only">, </span>
											<span aria-hidden="true">Over</span>
											<span className="sr-only">{overLabel(over)}</span>
										</span>
									)}
								</Link>
							</li>
						);
					})}
				</ol>
			</fieldset>
			<p className="flex items-baseline justify-between gap-4 rounded-medium border-2 border-on-surface px-4 py-2 medium:flex-col medium:items-end medium:justify-center">
				<span className="text-label-large">Week total</span>
				<span className="text-title-medium tabular-nums">
					{formatDuration(week.total)}
					<span className="text-label-large text-on-surface-variant">
						{" "}
						of {formatDuration(away.expectedMinutes * 60_000)} expected
					</span>
				</span>
			</p>
		</div>
	);
}
