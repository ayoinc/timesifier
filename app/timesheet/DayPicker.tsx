import { useCallback, useEffect, useRef, useState } from "react";
import {
	Button as AriaButton,
	Dialog as AriaDialog,
	DialogTrigger,
	Heading,
	Popover,
} from "react-aria-components";
import { Link, useFetcher } from "react-router";

import { cx } from "~/components/cx";
import { IconButton } from "~/components/IconButton";
import { ArrowDropDownIcon } from "~/components/icons/ArrowDropDownIcon";
import { ChevronLeftIcon } from "~/components/icons/ChevronLeftIcon";
import { ChevronRightIcon } from "~/components/icons/ChevronRightIcon";
import { POPOVER_MOTION } from "~/components/motion";
import type { loader as monthLoader } from "~/routes/app/timesheet.month";
import { finishRunningTransition } from "~/shell/transitions";
import type { Day } from "~/time/calendar";
import { formatDay, formatMonth } from "~/time/format";

import { calendarDays, monthAfter, monthOf } from "./calendar-sheets";
import { formatDuration } from "./durations";
import { dayPath, pickerMonthPath } from "./views";

/**
 * The day title of the Day view as a button that opens the month (taste HT-D,
 * Harvest's "change date"): a grid of the weeks that hold the month, each day
 * a link that opens it, with a dot on a day with time and its total in its
 * name. Today is amber, the day shown has the ink frame. ‹ and › move the
 * grid a month; Escape or choosing a day closes it.
 *
 * The grid is drawn from the date alone the moment it opens (TS-114, harvest
 * sweep S2-03). The month's totals are read then (`timesheet.month.ts`), and
 * on the way to it, when the pointer or the focus comes to the title, so the
 * page itself carries none of it: each day's dot fades in where its place was
 * kept, and nothing moves.
 */
export function DayPicker({
	slug,
	day,
	today,
	weekStartsOn,
	label,
}: {
	slug: string;
	day: Day;
	today: Day;
	/** The weekday the organisation's weeks start on, which starts each row. */
	weekStartsOn: number;
	label: string;
}) {
	const [isOpen, setOpen] = useState(false);
	const [month, setMonth] = useState<Day>(monthOf(day));
	const fetcher = useFetcher<typeof monthLoader>();
	const { load } = fetcher;
	// The month being read, so a press that follows a hover does not read it again while it comes.
	const reading = useRef<string | null>(null);
	useEffect(() => {
		if (fetcher.state === "idle") reading.current = null;
	}, [fetcher.state]);
	const read = useCallback(
		(of: Day) => {
			const path = pickerMonthPath(slug, of);
			if (reading.current === path) return;
			reading.current = path;
			void load(path);
		},
		[slug, load],
	);
	useEffect(() => {
		if (isOpen) read(month);
	}, [isOpen, month, read]);
	const totals = fetcher.data && monthOf(fetcher.data.month) === month ? fetcher.data : undefined;
	const totalOf = new Map(totals?.days.map((each) => [each.day, each.total]));
	const weeks: Day[][] = [];
	for (const [index, each] of calendarDays("month", month, weekStartsOn).days.entries()) {
		if (index % 7 === 0) weeks.push([]);
		weeks.at(-1)?.push(each);
	}

	return (
		<DialogTrigger
			isOpen={isOpen}
			onOpenChange={(open) => {
				if (open) setMonth(monthOf(day));
				setOpen(open);
			}}
		>
			<AriaButton
				aria-label={`${label}: choose a day`}
				onHoverStart={() => read(monthOf(day))}
				onFocus={() => read(monthOf(day))}
				className="relative inline-flex min-h-11 min-w-0 cursor-pointer items-center gap-1 rounded-large-increased ps-3 pe-1 text-center text-on-surface text-title-small outline-none state-layer transition-control data-hovered:state-hover data-focus-visible:focus-indicator data-pressed:state-pressed"
			>
				<span className="min-w-0">{label}</span>
				<ArrowDropDownIcon />
			</AriaButton>
			<Popover
				placement="bottom"
				offset={4}
				className={cx(
					POPOVER_MOTION,
					"rounded-large bg-surface-container-low p-3 shadow-level2 outline-none",
				)}
			>
				<AriaDialog aria-label="Choose a day" className="outline-none">
					<div className="flex items-center justify-between gap-2">
						<IconButton label="Previous month" onPress={() => setMonth(monthAfter(month, -1))}>
							<ChevronLeftIcon />
						</IconButton>
						<Heading slot="title" className="text-title-small">
							{formatMonth(month)}
						</Heading>
						<IconButton label="Next month" onPress={() => setMonth(monthAfter(month, 1))}>
							<ChevronRightIcon />
						</IconButton>
					</div>
					<table className="mt-2 border-collapse">
						<caption className="sr-only">{formatMonth(month)}</caption>
						<thead>
							<tr>
								{(weeks[0] ?? []).map((each) => (
									<th
										key={each}
										scope="col"
										className="size-11 text-label-medium font-normal text-on-surface-variant"
									>
										<span aria-hidden="true">{formatDay(each, "short").slice(0, 2)}</span>
										<span className="sr-only">{formatDay(each, "short").split(" ")[0]}</span>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{weeks.map((week) => (
								<tr key={week[0]}>
									{week.map((each) => {
										const isShown = each === day;
										const isToday = each === today;
										const total = totalOf.get(each);
										return (
											<td key={each} className="p-0">
												<Link
													to={dayPath(slug, each)}
													preventScrollReset
													onClick={() => {
														finishRunningTransition();
														setOpen(false);
													}}
													aria-current={isShown ? "date" : undefined}
													aria-label={`${isToday ? "Today, " : ""}${formatDay(each)}${
														total === undefined
															? ""
															: total > 0
																? `, ${formatDuration(total)} tracked`
																: ", no time"
													}`}
													className={cx(
														"relative flex size-11 flex-col items-center justify-center rounded-full text-label-large tabular-nums outline-none state-layer transition-control hover:state-hover focus-visible:focus-indicator",
														isToday
															? "over-primary-container text-on-primary-fixed"
															: each.slice(0, 7) === month.slice(0, 7)
																? "text-on-surface"
																: "text-on-surface-variant",
														isShown && "border-2 border-on-surface",
													)}
												>
													<span aria-hidden="true">{Number(each.slice(8, 10))}</span>
													{/* The dot's place is kept from the first frame; it fades in when the month's totals come. */}
													<span
														aria-hidden="true"
														className={cx(
															"size-1 rounded-full bg-current transition-opacity duration-short4 ease-standard",
															total !== undefined && total > 0 ? "opacity-100" : "opacity-0",
														)}
													/>
												</Link>
											</td>
										);
									})}
								</tr>
							))}
						</tbody>
					</table>
				</AriaDialog>
			</Popover>
		</DialogTrigger>
	);
}
