import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { Link } from "react-router";

import { cx } from "~/components/cx";
import { finishRunningTransition } from "~/shell/transitions";
import { type Day, exactInstantAt, wallMinutes } from "~/time/calendar";
import { GRID_DAY_STARTS_AT_MINUTES } from "~/time/grid";
import { type FocusItemProps, focusItem, useRovingFocus } from "./calendar-focus";
import {
	daySegments,
	freeSlots,
	MINUTES_PER_DAY,
	type PlacedSegment,
	placeSegments,
	ROW_MINUTES,
	ROWS_PER_DAY,
	ZOOM_GEOMETRY,
} from "./calendar-sheets";
import { ClosedDays, RuleLine, refusalOfDay } from "./DayRules";
import { formatDuration } from "./durations";
import { useClockFormat, useDayFormat } from "./format";
import type { SheetEntry } from "./sheets";
import type { CalendarData } from "./timesheet.server";
import { dayPath } from "./views";

/**
 * The week calendar (TS-062): the period's seven days side by side on an hour
 * axis, each entry a block from its start to its end, cut at midnight, and
 * each day's total at the head of its column. A block opens the entry's edit
 * sheet; an empty slot opens Track time from its start. A day of a submitted
 * or approved week takes neither: its blocks lead to the Day view, which says
 * why. A day that takes no time, or has none left, offers no slot, and its
 * head says why; a day with a limit says what is left, and a day over it by
 * how much (TS-090). The hours are 24px tall when compact, so the whole day
 * is in view, and 96px in detail, so a quarter of an hour is a line of text.
 *
 * For assistive technology it is a grid of two rows: the days' heads, then
 * the days' entries and free slots. Arrow keys move between days and along a
 * day; Enter opens what has the focus.
 */

/** A day's hours as drawn: 288 rows of five minutes. Classes, not a `style`, place each block (docs/security.md). */
const DAY_HEIGHT = { compact: "h-144", detailed: "h-576" } as const;

/** Where the week opens: an hour before the working day starts, or the earliest entry if it is earlier. */
const OPENS_AT_MINUTES = GRID_DAY_STARTS_AT_MINUTES - 60;

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const twoDigits = (value: number) => String(value).padStart(2, "0");
/** Minutes after midnight as a wall-clock time: `09:30`. */
export const clockOfMinutes = (minutes: number) =>
	`${twoDigits(Math.floor(minutes / 60))}:${twoDigits(minutes % 60)}`;

export function CalendarWeek({
	data,
	slug,
	now,
	totals,
	statuses,
	canTrack,
	projectName,
	onEdit,
	onTrack,
}: {
	data: CalendarData;
	slug: string;
	/** The clock a running entry grows by. */
	now: number;
	/** Each day's total and the week's: `weekSheet`'s. */
	totals: { days: { day: Day; total: number }[]; total: number };
	statuses: CalendarData["statuses"];
	/** Whether there is an active project to track time on. */
	canTrack: boolean;
	projectName: (id: string) => string;
	onEdit: (entry: SheetEntry) => void;
	onTrack: (day: Day, start: string) => void;
}) {
	const { days, zone, today, zoom, lockedDays } = data;
	const geometry = ZOOM_GEOMETRY[zoom];
	const formatShort = useDayFormat("short");
	const formatLong = useDayFormat();
	const clock = useClockFormat(zone);

	const segments = daySegments(data.entries, days, zone, now);
	const columns = days.map((day) => {
		const placed = placeSegments(segments.get(day) ?? [], geometry.leastRows);
		const locked = lockedDays.includes(day);
		const rule = data.rules.find((each) => each.day === day);
		const slots =
			locked || !canTrack || refusalOfDay(rule) !== null
				? []
				: freeSlots(placed, geometry.slotMinutes).filter(
						// A time the clocks skip cannot start an entry.
						(minutes) => exactInstantAt(day, minutes, zone) !== null,
					);
		return { day, placed, slots, locked, status: statuses[day], rule };
	});

	// The items of the grid in the order the arrow keys walk them: each day's
	// head, then its blocks and slots from midnight on.
	const items = columns.map((column) =>
		[
			...column.placed.map((part) => ({ id: blockId(part), at: part.row * ROW_MINUTES })),
			...column.slots.map((minutes) => ({ id: slotId(column.day, minutes), at: minutes })),
		].sort((a, b) => a.at - b.at),
	);
	const ids = new Set([...days.map(headId), ...items.flat().map((item) => item.id)]);
	const first = headId(days.includes(today) ? today : (days[0] as Day));
	const { itemProps } = useRovingFocus(ids, first);

	const grid = useRef<HTMLTableElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const body = useRef<HTMLTableRowElement>(null);
	const axis = useRef<HTMLTableCellElement>(null);
	const earliest = Math.min(
		OPENS_AT_MINUTES,
		...columns.flatMap((column) => column.placed.map((part) => Math.floor(part.from / 60) * 60)),
	);
	// Opens at the working hours, and with today's column in view where the
	// week is wider than the screen. The view gives each week and zoom a
	// calendar of its own, so this is done as each opens.
	useLayoutEffect(() => {
		const box = scroller.current;
		if (!box || !body.current || !axis.current) return;
		// Half an hour above, so the first hour's label clears the days' heads.
		box.scrollTop = (body.current.offsetHeight * (earliest - 30)) / MINUTES_PER_DAY;
		const todayHead = box.querySelector<HTMLElement>('[aria-current="date"]')?.closest("th");
		box.scrollLeft = todayHead ? todayHead.offsetLeft - axis.current.offsetWidth : 0;
	}, [earliest]);

	function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
		const target = event.target as HTMLElement;
		const id = target.dataset.focusId;
		if (id === undefined) return;
		const isHead = id.startsWith("head:");
		const col = Number(target.dataset.col);
		const at = Number(target.dataset.at ?? -1);
		const inColumn = items[col] ?? [];
		const index = inColumn.findIndex((item) => item.id === id);
		const nearest = (to: number, near: number) => {
			const list = items[to] ?? [];
			let best = list[0];
			for (const item of list)
				if (Math.abs(item.at - near) < Math.abs((best?.at ?? 0) - near)) best = item;
			return best?.id ?? headId(days[to] as Day);
		};
		let next: string | undefined;
		switch (event.key) {
			case "ArrowLeft":
			case "ArrowRight": {
				const to = col + (event.key === "ArrowLeft" ? -1 : 1);
				if (to < 0 || to >= days.length) return;
				next = isHead ? headId(days[to] as Day) : nearest(to, at);
				break;
			}
			case "ArrowDown":
				next = isHead ? nearest(col, earliest) : inColumn[index + 1]?.id;
				break;
			case "ArrowUp":
				next = isHead ? undefined : (inColumn[index - 1]?.id ?? headId(days[col] as Day));
				break;
			case "Home":
				next = headId(days[0] as Day);
				break;
			case "End":
				next = headId(days.at(-1) as Day);
				break;
			default:
				return;
		}
		event.preventDefault();
		focusItem(grid.current, next);
	}

	const geometryClass = DAY_HEIGHT[zoom];
	return (
		<>
			<div
				ref={scroller}
				className={cx(
					"mt-6 overflow-auto overscroll-contain rounded-large border-2 border-on-surface",
					zoom === "detailed" && "max-h-160",
				)}
			>
				<table
					ref={grid}
					aria-label={`Week calendar, ${formatLong(days[0] as Day)} to ${formatLong(days.at(-1) as Day)}`}
					onKeyDown={onKeyDown}
					className="w-full min-w-182 table-fixed border-separate border-spacing-0 expanded:min-w-0"
				>
					<thead>
						<tr>
							<th
								scope="col"
								className="sticky top-0 left-0 z-30 w-14 border-b-2 border-on-surface bg-surface px-1 py-3 align-middle font-normal"
							>
								<span className="block text-label-small text-on-surface-variant">
									Week<span className="sr-only"> total</span>
								</span>
								<span className="block text-label-large tabular-nums">
									{formatDuration(totals.total)}
								</span>
							</th>
							{columns.map(({ day, locked, status, rule }, col) => {
								const total = totals.days.find((each) => each.day === day)?.total ?? 0;
								const isToday = day === today;
								return (
									<th
										key={day}
										scope="col"
										className={cx(
											"sticky top-0 z-20 border-b-2 border-l border-b-on-surface border-l-outline-variant p-1 font-normal",
											locked || status?.quiet ? "bg-surface-container-low" : "bg-surface",
										)}
									>
										<Link
											to={dayPath(slug, day)}
											onClick={finishRunningTransition}
											aria-current={isToday ? "date" : undefined}
											data-col={col}
											{...itemProps(headId(day))}
											className={cx(
												"flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-medium px-1 py-2 outline-none state-layer transition-control hover:state-hover focus-visible:focus-indicator-inner",
												isToday
													? "over-primary-container text-on-primary-fixed"
													: status?.quiet
														? "text-on-surface-variant"
														: "text-on-surface",
											)}
										>
											<span className="text-label-large">
												<span aria-hidden="true">{formatShort(day)}</span>
												<span className="sr-only">
													{isToday ? "Today, " : ""}
													{formatLong(day)},
												</span>
											</span>
											<span className="text-title-small tabular-nums">
												{formatDuration(total)}
												<span className="sr-only"> tracked</span>
											</span>
											{status && (
												<span
													className={cx(
														"max-w-full truncate text-label-small",
														!isToday && "text-on-surface-variant",
													)}
												>
													<span className="sr-only">, </span>
													{status.label}
												</span>
											)}
											{!locked && <RuleLine rule={rule} onAmber={isToday} />}
											{locked && (
												<span
													className={cx("text-label-small", !isToday && "text-on-surface-variant")}
												>
													<span className="sr-only">, </span>Submitted
												</span>
											)}
										</Link>
									</th>
								);
							})}
						</tr>
					</thead>
					<tbody>
						<tr ref={body}>
							<th
								ref={axis}
								scope="row"
								className="sticky left-0 z-20 bg-surface p-0 align-top font-normal"
							>
								<span className="sr-only">Entries by time of day</span>
								<span aria-hidden="true" className={cx("grid grid-rows-24", geometryClass)}>
									{HOURS.map((hour) => (
										<span
											key={hour}
											className="-translate-y-2 pe-2 text-end text-label-small text-on-surface-variant tabular-nums"
										>
											{hour === 0 ? "" : clockOfMinutes(hour * 60)}
										</span>
									))}
								</span>
							</th>
							{columns.map(({ day, placed, slots, locked, status }, col) => (
								<td
									key={day}
									className={cx(
										"border-l border-outline-variant p-0 align-top",
										(locked || status?.quiet) && "bg-surface-container-low",
									)}
								>
									<div className={cx("relative", geometryClass)}>
										<div
											aria-hidden="true"
											className="absolute inset-0 grid grid-rows-24 divide-y divide-outline-variant"
										>
											{HOURS.map((hour) => (
												<span key={hour} />
											))}
										</div>
										<div className="relative grid h-full grid-cols-60 grid-rows-288">
											{slots.map((minutes) => (
												<button
													key={minutes}
													type="button"
													data-col={col}
													data-at={minutes}
													{...itemProps(slotId(day, minutes))}
													onClick={() => onTrack(day, clockOfMinutes(minutes))}
													// Not "Track time": that is the Day view's button and the sheet's title.
													aria-label={`New entry, ${formatLong(day)}, from ${clockOfMinutes(minutes)}`}
													className={cx(
														"group col-span-60 flex items-start justify-start rounded-small px-2 text-label-small text-on-surface-variant outline-none state-layer transition-control hover:state-hover focus-visible:focus-indicator-inner",
														placement(
															minutes / ROW_MINUTES,
															(minutes + geometry.slotMinutes) / ROW_MINUTES,
														),
													)}
												>
													<span
														aria-hidden="true"
														className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
													>
														+ {clockOfMinutes(minutes)}
													</span>
												</button>
											))}
											{placed.map((part) => (
												<Block
													key={blockId(part)}
													part={part}
													col={col}
													zoom={zoom}
													locked={locked}
													slug={slug}
													now={now}
													name={part.entry.description || projectName(part.entry.projectId)}
													project={
														part.entry.description ? projectName(part.entry.projectId) : null
													}
													clock={clock}
													focusProps={itemProps(blockId(part))}
													onEdit={onEdit}
												/>
											))}
											{day === today && <NowLine now={now} day={day} zone={zone} />}
										</div>
									</div>
								</td>
							))}
						</tr>
					</tbody>
				</table>
			</div>
			<ClosedDays rules={data.rules} />
		</>
	);
}

const headId = (day: Day) => `head:${day}`;
const slotId = (day: Day, minutes: number) => `slot:${day}:${minutes}`;
const blockId = (part: PlacedSegment) => `block:${part.entry.id}:${part.day}`;

/** The classes that put an item on rows `row` up to, not including, `rowEnd`, of a day's 288. */
function placement(row: number, rowEnd: number): string {
	return `row-start-${row + 1} row-end-${rowEnd + 1}`;
}

/** The classes that put a block in its lane of the day's 60 columns. */
function lanePlacement(lane: number, lanes: number): string {
	const span = Math.max(1, Math.floor(60 / lanes));
	return `col-start-${lane * span + 1} col-span-${span}`;
}

function Block({
	part,
	col,
	zoom,
	locked,
	slug,
	now,
	name,
	project,
	clock,
	focusProps,
	onEdit,
}: {
	part: PlacedSegment;
	col: number;
	zoom: CalendarData["zoom"];
	locked: boolean;
	slug: string;
	now: number;
	name: string;
	project: string | null;
	clock: (instant: number) => string;
	focusProps: FocusItemProps;
	onEdit: (entry: SheetEntry) => void;
}) {
	const { entry } = part;
	const running = entry.endedAt === null;
	const length = formatDuration(Math.max(0, (entry.endedAt ?? now) - entry.startedAt));
	const times = `${clock(entry.startedAt)}–${running ? "Running" : clock(entry.endedAt as number)}`;
	const rows = part.rowEnd - part.row;
	const label = [
		name,
		project,
		times,
		length,
		part.continued ? `continued from the day before` : null,
		part.goesOn ? "goes on the next day" : null,
		locked ? "submitted, open the day" : running ? "running, open the day to stop it" : "edit",
	]
		.filter(Boolean)
		.join(", ");
	const className = cx(
		"relative z-10 m-px flex min-w-0 flex-col overflow-hidden px-2 py-1 text-start outline-none state-layer transition-control hover:state-hover focus-visible:focus-indicator",
		placement(part.row, part.rowEnd),
		lanePlacement(part.lane, part.lanes),
		part.continued ? "rounded-t-none rounded-b-small" : "rounded-small",
		part.goesOn && "rounded-b-none",
		part.continued && part.goesOn && "rounded-none",
		running
			? "over-surface border-2 border-on-surface text-on-surface"
			: locked
				? "over-surface-container-highest text-on-surface"
				: "over-primary-container text-on-primary-container",
	);
	const content = (
		<>
			<span aria-hidden="true" className="truncate text-label-medium">
				{name}
			</span>
			{(zoom === "detailed" ? rows >= 6 : rows >= 18) && (
				<span aria-hidden="true" className="truncate text-label-small">
					{times}
					{project ? ` · ${project}` : ""}
				</span>
			)}
			<span className="sr-only">{label}</span>
		</>
	);
	const common = { "data-col": col, "data-at": part.row * ROW_MINUTES, ...focusProps, className };
	if (locked || running) {
		return (
			<Link to={dayPath(slug, part.day)} onClick={finishRunningTransition} {...common}>
				{content}
			</Link>
		);
	}
	return (
		<button type="button" onClick={() => onEdit(entry)} {...common}>
			{content}
		</button>
	);
}

/** Where today's clock reads now, across today's column. */
function NowLine({ now, day, zone }: { now: number; day: Day; zone: string }) {
	const row = Math.min(ROWS_PER_DAY - 1, Math.floor(wallMinutes(now, day, zone) / ROW_MINUTES));
	return (
		<span
			aria-hidden="true"
			className={cx(
				"pointer-events-none z-10 col-span-60 self-start border-t-2 border-error",
				placement(row, row + 1),
			)}
		/>
	);
}
