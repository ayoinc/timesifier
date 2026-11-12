import { useEffect, useState, ViewTransition } from "react";
import { useDateFormatter } from "react-aria";
import { useNavigate } from "react-router";
import { IconButton } from "~/components/IconButton";
import { AddIcon } from "~/components/icons/AddIcon";
import { RemoveIcon } from "~/components/icons/RemoveIcon";
import { Tooltip } from "~/components/Tooltip";
import { FormSheet } from "~/routes/app/FormSheet";
import { TRANSITION, useTravel } from "~/shell/transitions";
import { addDays, type Day, dayOf } from "~/time/calendar";

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
import { EntryFields, TrackTime } from "./DayView";
import { formatDuration } from "./durations";
import { dayNumber, useClockFormat, usePeriodFormat } from "./format";
import { useNow } from "./live";
import { PeriodLinks } from "./PeriodLinks";
import { type SheetEntry, weekSheet } from "./sheets";
import type { CalendarData } from "./timesheet.server";
import { calendarPath } from "./views";

/**
 * The Calendar view of Timesheet (TS-062): the person's own time as a week on
 * an hour axis or as a month of days, with Previous, Today and Next, the
 * totals, and the zoom, by its control or by `-` and `+`, from the month to
 * the week, the week in detail, and the Day view. The address holds the
 * scale, the day and the zoom. The totals are the Day and Week views': an
 * entry counts on the day it starts, and the sums are `weekSheet`'s.
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
	const formatMonth = useDateFormatter({ month: "long", year: "numeric", timeZone: "UTC" });
	const clock = useClockFormat(zone);
	const navigate = useNavigate();
	const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
	const canTrack = projects.some((p) => !p.archived);

	const [said, setSaid] = useState<string | null>(null);
	const [task, setTask] = useState<"track" | "edit" | null>(null);
	const [entry, setEntry] = useState<SheetEntry | null>(null);
	const [slot, setSlot] = useState<{ day: Day; start: string }>({ day: today, start: "09:00" });
	const close = () => setTask(null);

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

	const title = isMonth
		? formatMonth.format(new Date(`${month}T00:00:00Z`))
		: formatPeriod(first, last);
	const week = weekSheet(data.entries, days, zone, live);
	const ofMonth = isMonth ? monthSheet(data.entries, days, month, zone, live) : null;

	return (
		<>
			<PeriodLinks
				label={isMonth ? "Months" : "Weeks"}
				previous={{
					to: isMonth
						? calendarPath(slug, { scale, date: monthAfter(month, -1) })
						: calendarPath(slug, { date: addDays(first, -7), zoom }),
					label: isMonth ? "Previous month" : "Previous week",
				}}
				current={{
					to: calendarPath(slug, { scale, zoom }),
					label: "Today",
					isCurrent: thisOne,
				}}
				next={{
					to: isMonth
						? calendarPath(slug, { scale, date: monthAfter(month, 1) })
						: calendarPath(slug, { date: addDays(first, 7), zoom }),
					label: isMonth ? "Next month" : "Next week",
				}}
			/>

			<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
				<div className="mt-6">
					<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
						<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
							<h2 className="text-title-large">{title}</h2>
							<p className="text-label-large text-on-surface-variant">
								{isMonth ? "Month total" : "Week total"}{" "}
								<span className="text-title-medium text-on-surface tabular-nums">
									{formatDuration(ofMonth ? ofMonth.total : week.total)}
								</span>
							</p>
						</div>
						<Zoom
							level={level}
							onOut={zoomOut ? () => void navigate(zoomOut, { preventScrollReset: true }) : null}
							onIn={zoomIn ? () => void navigate(zoomIn, { preventScrollReset: true }) : null}
						/>
					</div>

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
							onEdit={(chosen) => {
								setEntry(chosen);
								setTask("edit");
							}}
							onTrack={(day, start) => {
								setSlot({ day, start });
								setTask("track");
							}}
						/>
					)}
				</div>
			</ViewTransition>

			<TrackTime
				data={{ day: slot.day, today, projects, away: data.away }}
				start={slot.start}
				isOpen={task === "track"}
				onClose={close}
				onDone={setSaid}
			/>

			<FormSheet
				title="Edit entry"
				intent="edit"
				submitLabel="Save"
				isOpen={task === "edit"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="entryId" value={entry?.id ?? ""} />
				{entry && (
					<EntryFields
						key={`edit-${entry.id}`}
						data={{ day: dayOf(entry.startedAt, zone), projects }}
						entry={entry}
						clock={clock}
					/>
				)}
			</FormSheet>
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
