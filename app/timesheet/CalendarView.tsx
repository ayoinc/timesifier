import { useEffect, useState, ViewTransition } from "react";
import { useNavigate } from "react-router";
import { IconButton } from "~/components/IconButton";
import { AddIcon } from "~/components/icons/AddIcon";
import { RemoveIcon } from "~/components/icons/RemoveIcon";
import { PeriodStepper } from "~/components/PeriodStepper";
import { Tooltip } from "~/components/Tooltip";
import { FormSheet } from "~/routes/app/FormSheet";
import { TRANSITION, useTravel } from "~/shell/transitions";
import { addDays, type Day, dayOf } from "~/time/calendar";
import { formatMonth } from "~/time/format";

import { CalendarMonth } from "./CalendarMonth";
import { CalendarWeek } from "./CalendarWeek";
import {
	monthAfter,
	monthSheet,
	ZOOM_LABELS,
	type ZoomLevel,
	zoomLevel,
	zoomPath,
	zoomStep,
} from "./calendar-sheets";
import { EntryFields } from "./DayView";
import { formatDuration } from "./durations";
import { useReport, useReported } from "./feedback";
import { dayNumber, useClockFormat, usePeriodFormat } from "./format";
import { useNow } from "./live";
import { PeriodHeader } from "./Submission";
import { type SheetEntry, weekSheet } from "./sheets";
import { ShortcutsSheet, useTimesheetKeys } from "./shortcuts";
import { useTrackTime } from "./TrackTime";
import type { CalendarData } from "./timesheet.server";
import { calendarPath, timerAction } from "./views";

/**
 * The Calendar view of Timesheet (TS-062): the person's own time as a week on
 * an hour axis or as a month of days, with Previous, Today and Next, the
 * totals, and the zoom, by its control or by `-` and `+`, from the month to
 * the week, the week in detail, and the Day view. The address holds the
 * scale, the day and the zoom. The totals are the Day and Week views': an
 * entry counts on the day it starts, and the sums are `weekSheet`'s. Its
 * header row is the Day and Week views' (`PeriodHeader`), with "Submit week"
 * on the week's scale. A day that takes no time offers no slot to add time
 * and says why; a day over its limit says by how much (TS-090).
 */
export function CalendarView({ data, slug }: { data: CalendarData; slug: string }) {
	const { scale, zoom, date, days, today, zone, projects } = data;
	const month = data.month;
	const first = days[0] as Day;
	const last = days.at(-1) as Day;
	const live = useNow(
		data.entries.some((entry) => entry.endedAt === null),
		data.now,
	);
	const travel = useTravel(dayNumber(first));
	const formatPeriod = usePeriodFormat();
	const clock = useClockFormat(zone);
	const navigate = useNavigate();
	const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
	const canTrack = projects.some((p) => !p.archived);

	const [said, setSaid] = useState<string | null>(null);
	const [entry, setEntry] = useState<SheetEntry | null>(null);
	const openTrackTime = useTrackTime();
	const report = useReport();
	const reported = useReported();
	useEffect(() => {
		if (reported) setSaid(reported.said);
	}, [reported]);

	// The zoom: out to the month, in to the week, the week in detail and the
	// day that the calendar is on, or today where today is in view.
	const level = zoomLevel(scale, zoom);
	const isMonth = scale === "month" && month !== null;
	// Whether today is in what the calendar shows.
	const thisOne = isMonth ? today.startsWith(month.slice(0, 7)) : first <= today && today <= last;
	const focusDay = thisOne ? today : date;
	const zoomTo = (step: 1 | -1) => {
		const to = zoomStep(level, step);
		return to === null ? null : zoomPath(slug, to, focusDay);
	};
	const zoomIn = zoomTo(1);
	const zoomOut = zoomTo(-1);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
			if (document.querySelector("[role=dialog]")) return;
			const to =
				event.key === "+" || event.key === "=" ? zoomIn : event.key === "-" ? zoomOut : null;
			if (to === null) return;
			event.preventDefault();
			void navigate(to, { preventScrollReset: true });
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [navigate, zoomIn, zoomOut]);

	const title = isMonth ? formatMonth(month) : formatPeriod(first, last);
	const previous = isMonth
		? calendarPath(slug, { scale, date: monthAfter(month, -1) })
		: calendarPath(slug, { date: addDays(first, -7), zoom });
	const next = isMonth
		? calendarPath(slug, { scale, date: monthAfter(month, 1) })
		: calendarPath(slug, { date: addDays(first, 7), zoom });
	const keys = useTimesheetKeys({
		onNew: canTrack ? () => openTrackTime({ day: thisOne ? today : date }) : undefined,
		previous,
		next,
		today: calendarPath(slug, { scale, zoom }),
	});
	const week = weekSheet(data.entries, days, live);
	const ofMonth = isMonth ? monthSheet(data.entries, days, month, live) : null;

	return (
		<>
			<div className="mt-6">
				<PeriodStepper
					label={isMonth ? "Months" : "Weeks"}
					period={title}
					previous={{ to: previous, label: isMonth ? "Previous month" : "Previous week" }}
					next={{ to: next, label: isMonth ? "Next month" : "Next week" }}
					current={
						thisOne
							? undefined
							: {
									to: calendarPath(slug, { scale, zoom }),
									label: isMonth ? "Back to this month" : "Back to this week",
								}
					}
				/>
			</div>

			<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
				<div className="mt-6">
					<PeriodHeader
						title={title}
						submission={data.submission}
						onSaid={setSaid}
						aside={
							<p className="text-label-large text-on-surface-variant">
								{isMonth ? "Month total" : "Week total"}{" "}
								<span className="text-title-medium text-on-surface tabular-nums">
									{formatDuration(ofMonth ? ofMonth.total : week.total)}
								</span>
							</p>
						}
						tools={
							<Zoom
								level={level}
								onOut={zoomOut ? () => void navigate(zoomOut, { preventScrollReset: true }) : null}
								onIn={zoomIn ? () => void navigate(zoomIn, { preventScrollReset: true }) : null}
							/>
						}
					/>

					<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
						{said}
					</p>

					{ofMonth ? (
						<CalendarMonth data={data} slug={slug} sheet={ofMonth} title={title} />
					) : (
						<CalendarWeek
							key={`${first}-${zoom}`}
							data={data}
							slug={slug}
							now={live}
							totals={week}
							statuses={data.statuses}
							canTrack={canTrack}
							projectName={projectName}
							onEdit={setEntry}
							onTrack={(day, start) => openTrackTime({ day, start })}
						/>
					)}
				</div>
			</ViewTransition>

			<FormSheet
				title="Edit entry"
				intent="edit"
				submitLabel="Save"
				action={timerAction(slug)}
				isOpen={entry !== null}
				onClose={() => setEntry(null)}
				onDone={(_said, answer) => report(answer)}
			>
				<input type="hidden" name="entryId" value={entry?.id ?? ""} />
				{entry && (
					<EntryFields
						key={`edit-${entry.id}`}
						data={{ zone, projects }}
						entry={entry}
						clock={clock}
					/>
				)}
			</FormSheet>

			<ShortcutsSheet isOpen={keys.helpOpen} onOpenChange={keys.setHelpOpen} />
		</>
	);
}

/** Out and in by one level, with the level shown between: `-` and `+` do the same. */
function Zoom({
	level,
	onOut,
	onIn,
}: {
	level: ZoomLevel;
	onOut: (() => void) | null;
	onIn: (() => void) | null;
}) {
	return (
		<fieldset className="flex items-center gap-1 rounded-large-increased border border-outline-variant p-1">
			<legend className="sr-only">Zoom</legend>
			<Tooltip label="Zoom out, or press -">
				<IconButton label="Zoom out" isDisabled={onOut === null} onPress={onOut ?? undefined}>
					<RemoveIcon />
				</IconButton>
			</Tooltip>
			<p className="min-w-28 px-2 text-center text-label-large">
				<span className="sr-only">Showing </span>
				{ZOOM_LABELS[level]}
			</p>
			<Tooltip label="Zoom in, or press +">
				<IconButton label="Zoom in" isDisabled={onIn === null} onPress={onIn ?? undefined}>
					<AddIcon />
				</IconButton>
			</Tooltip>
		</fieldset>
	);
}
