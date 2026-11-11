import { useEffect, useRef, useState, ViewTransition } from "react";
import { Link, useFetcher, useLocation } from "react-router";

import { Button } from "~/components/Button";
import { Digits } from "~/components/Digits";
import { AddIcon } from "~/components/icons/AddIcon";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { minutesLabel } from "~/leave/words";
import type { Outcome } from "~/organisations/problems";
import { FormSheet } from "~/routes/app/FormSheet";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { TRANSITION, useTravel } from "~/shell/transitions";
import { addDays } from "~/time/calendar";
import { ENTRY_DESCRIPTION_MAX_LENGTH } from "~/time/entries";

import { formatDuration, formatElapsed } from "./durations";
import { dayNumber, useClockFormat, useDayFormat, usePeriodFormat } from "./format";
import { GettingStartedList, usePutAwayAnswer } from "./GettingStarted";
import { elapsedSeconds, useNow } from "./live";
import { PeriodLinks } from "./PeriodLinks";
import { Submission } from "./Submission";
import { durationOf, PERIOD_STATE_LABELS, type SheetEntry } from "./sheets";
import type { DayData } from "./timesheet.server";
import { dayPath, TIMER_ANCHOR } from "./views";
import { WeekDays } from "./WeekDays";

/**
 * The Day view (TS-012a, TS-013, TS-012b, TS-056): getting started while a
 * step is left, the period's seven days with their totals, "Track time", the
 * page's one primary action, with the running timer and its Stop, then the
 * chosen day's entries, earliest first, with a total, and the period's
 * submission at its foot. An entry is changed or deleted in a sheet. Nothing
 * on a day in a submitted or approved period can be tracked or changed.
 */
export function DayView({ data, slug }: { data: DayData; slug: string }) {
	const { day, today, entries, total, locked, projects, zone, now, submission } = data;
	const formatDay = useDayFormat();
	const formatPeriod = usePeriodFormat();
	const clock = useClockFormat(zone);
	const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
	const travel = useTravel(dayNumber(day));
	const live = useNow(data.running !== null, now);
	const canTrack = !locked && projects.some((p) => !p.archived);
	// The day as leave sees it: its name and the time expected on it (TS-061).
	const shownDay = data.away.days.find((d) => d.day === day);

	const [task, setTask] = useState<"track" | "edit" | "delete" | null>(null);
	const [entry, setEntry] = useState<SheetEntry | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	usePutAwayAnswer(setSaid);

	// "Start timer" in the navigation and "Track an entry" in getting started
	// lead here with the timer's anchor: each arrival opens "Track time" once.
	const location = useLocation();
	const arrived = useRef<string | null>(null);
	useEffect(() => {
		if (location.hash !== `#${TIMER_ANCHOR}` || arrived.current === location.key) return;
		arrived.current = location.key;
		if (canTrack) setTask("track");
	}, [location.hash, location.key, canTrack]);

	return (
		<>
			{data.gettingStarted && <GettingStartedList steps={data.gettingStarted} slug={slug} />}

			<PeriodLinks
				label="Days"
				previous={{ to: dayPath(slug, addDays(day, -1)), label: "Previous day" }}
				current={{ to: dayPath(slug), label: "Today", isCurrent: day === today }}
				next={{ to: dayPath(slug, addDays(day, 1)), label: "Next day" }}
			/>

			<WeekDays week={data.week} away={data.away} day={day} slug={slug} />

			<Timer
				data={data}
				slug={slug}
				projectName={projectName}
				onSaid={setSaid}
				onTrack={canTrack ? () => setTask("track") : null}
				now={live}
			/>

			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-6 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
				<div className="mt-6 max-w-200">
					<Ledger
						heading={day === today ? `Today, ${formatDay(day)}` : formatDay(day)}
						note={locked ? "Submitted" : undefined}
					>
						{shownDay && (
							<p className="px-4 pb-3 text-body-medium text-on-surface-variant @sm:px-5">
								{shownDay.label ? `${shownDay.label}. ` : ""}
								{minutesLabel(shownDay.expectedMinutes)} expected.
							</p>
						)}
						{entries.length === 0 ? (
							<p className="px-4 pb-4 text-body-large text-on-surface-variant @sm:px-5">
								Nothing tracked on this day.
							</p>
						) : (
							<LedgerRows label="Entries">
								{entries.map((each) => {
									const isRunning = each.endedAt === null;
									const name = projectName(each.projectId);
									return (
										<LedgerRow
											key={each.id}
											title={<span className="wrap-anywhere">{each.description || name}</span>}
											detail={each.description ? name : undefined}
											aside={`${clock(each.startedAt)}–${each.endedAt === null ? "Running" : clock(each.endedAt)}`}
											value={formatDuration(durationOf(each, now))}
											action={
												!locked &&
												!isRunning && (
													<MenuTrigger>
														<Button
															variant="text"
															aria-label={`Actions for ${each.description || name}, ${clock(each.startedAt)}`}
														>
															Actions
														</Button>
														<Menu
															onAction={(chosen) => {
																setEntry(each);
																setTask(chosen === "edit" ? "edit" : "delete");
															}}
														>
															<MenuItem id="edit">Edit entry</MenuItem>
															<MenuItem id="delete">Delete entry</MenuItem>
														</Menu>
													</MenuTrigger>
												)
											}
										/>
									);
								})}
							</LedgerRows>
						)}
						<LedgerTotal label="Day total" value={formatDuration(total)} />
					</Ledger>
					{locked && (
						<p className="mt-4 text-body-medium text-on-surface-variant">
							This day is in a submitted or approved week, so nothing can be tracked or changed on
							it.
						</p>
					)}
				</div>
			</ViewTransition>

			{/* The period's one submission action, as at the Week view's foot. Not
			    filled: "Track time" is this view's primary action. */}
			<Submission
				submission={submission}
				onSaid={setSaid}
				variant="outlined"
				heading={
					<div>
						<h2 className="text-title-large">
							{formatPeriod(submission.period.startsOn, submission.period.endsOn)}
						</h2>
						<p className="text-label-large text-on-surface-variant">
							<span className="sr-only">Status: </span>
							{PERIOD_STATE_LABELS[submission.state]}
						</p>
						{submission.state === "returned" && (
							<p className="mt-2 max-w-160 text-body-large">
								Returned{submission.comment ? `: ${submission.comment}` : "."} Correct the week and
								submit it again.
							</p>
						)}
					</div>
				}
			/>

			<TrackTime data={data} isOpen={task === "track"} onClose={close} onDone={setSaid} />

			<FormSheet
				title="Edit entry"
				intent="edit"
				submitLabel="Save"
				isOpen={task === "edit"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="entryId" value={entry?.id ?? ""} />
				{entry && <EntryFields key={`edit-${entry.id}`} data={data} entry={entry} clock={clock} />}
			</FormSheet>

			<FormSheet
				title="Delete this entry?"
				intent="delete"
				submitLabel="Delete"
				isOpen={task === "delete"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="entryId" value={entry?.id ?? ""} />
				<p>
					{entry
						? `${entry.description || projectName(entry.projectId)}, ${clock(entry.startedAt)}–${
								entry.endedAt === null ? "" : clock(entry.endedAt)
							}, is removed from your timesheet.`
						: null}
				</p>
			</FormSheet>
		</>
	);
}

/**
 * "Track time" (TS-056): a project, a description and hours on the day shown.
 * With no hours the action is "Start timer", which runs from now; with hours,
 * `1.5`, `1,5` or `1:30`, it is "Save entry", one entry of that length on the
 * day. A timer runs today only, so on another day the hours are asked for.
 * Opened from a slot of the calendar (TS-062) it has a start too, filled in
 * with the slot's, and the hours are asked for from that time.
 */
export function TrackTime({
	data,
	start,
	isOpen,
	onClose,
	onDone,
}: {
	data: Pick<DayData, "day" | "today" | "projects">;
	/** The time the entry starts, `09:30`, where a slot of the calendar was chosen. */
	start?: string;
	isOpen: boolean;
	onClose: () => void;
	onDone: (said: string) => void;
}) {
	const [hours, setHours] = useState("");
	const formatDay = useDayFormat();
	const isToday = data.day === data.today;
	const timerAllowed = isToday && start === undefined;
	const startsTimer = timerAllowed && hours.trim() === "";
	const active = data.projects.filter((p) => !p.archived);
	// A whole day of leave, or a public holiday: tracking is allowed, and said to be unusual (TS-061).
	const away = data.away.days.find(
		(d) =>
			d.day === data.day &&
			((d.kind === "leave" && d.expectedMinutes === 0) || d.kind === "holiday"),
	);
	return (
		<FormSheet
			title="Track time"
			intent="track"
			submitLabel={startsTimer ? "Start timer" : "Save entry"}
			isOpen={isOpen}
			onClose={() => {
				setHours("");
				onClose();
			}}
			onDone={onDone}
		>
			<p className="text-body-large text-on-surface-variant">
				{isToday ? `Today, ${formatDay(data.day)}` : formatDay(data.day)}
			</p>
			{away && (
				<p
					role="note"
					className="rounded-medium border-2 border-on-surface px-4 py-3 text-body-large"
				>
					{away.kind === "holiday"
						? `${away.label} is a public holiday.`
						: `You are on ${away.label?.toLowerCase()} this day.`}{" "}
					You can still track time on it.
				</p>
			)}
			<input type="hidden" name="day" value={data.day} />
			<Select
				label="Project"
				name="projectId"
				options={active.map((p) => ({ id: p.id, label: p.name }))}
				defaultValue={active[0]?.id ?? null}
				isRequired
			/>
			<TextField label="Description" name="description" maxLength={ENTRY_DESCRIPTION_MAX_LENGTH} />
			{start !== undefined && (
				<TextField
					key={`${data.day}-${start}`}
					label="Start"
					name="start"
					type="time"
					defaultValue={start}
					isRequired
				/>
			)}
			<TextField
				label="Hours"
				name="hours"
				value={hours}
				onChange={setHours}
				inputMode="decimal"
				autoComplete="off"
				maxLength={16}
				isRequired={!timerAllowed}
				description={
					timerAllowed
						? "As 1.5, 1,5 or 1:30. Leave it empty to start a timer."
						: "As 1.5, 1,5 or 1:30."
				}
			/>
		</FormSheet>
	);
}

/**
 * The fields of an entry changed by hand: its project, its day and its start
 * and end, read in the person's zone, and a description. Native date and time
 * inputs, which write no `style` attribute (docs/security.md). `day` is the
 * day the entry starts on.
 */
export function EntryFields({
	data,
	entry,
	clock,
}: {
	data: Pick<DayData, "day" | "projects">;
	entry: SheetEntry;
	clock: (instant: number) => string;
}) {
	const offered = data.projects.filter((p) => !p.archived || p.id === entry.projectId);
	return (
		<>
			<Select
				label="Project"
				name="projectId"
				options={offered.map((p) => ({ id: p.id, label: p.name }))}
				defaultValue={entry.projectId}
				isRequired
			/>
			<TextField label="Date" name="date" type="date" defaultValue={data.day} isRequired />
			<div className="grid grid-cols-2 gap-4">
				<TextField
					label="Start"
					name="start"
					type="time"
					defaultValue={clock(entry.startedAt)}
					isRequired
				/>
				<TextField
					label="End"
					name="end"
					type="time"
					defaultValue={entry.endedAt ? clock(entry.endedAt) : ""}
					isRequired
				/>
			</div>
			<TextField
				label="Description"
				name="description"
				defaultValue={entry.description ?? ""}
				maxLength={ENTRY_DESCRIPTION_MAX_LENGTH}
			/>
		</>
	);
}

/**
 * Where "Start timer" in the navigation leads: "Track time", which opens its
 * sheet, and the running entry with its elapsed time and Stop. With no active
 * project, the way to create one instead; on a locked day, no "Track time".
 */
function Timer({
	data,
	slug,
	projectName,
	onSaid,
	onTrack,
	now,
}: {
	data: DayData;
	slug: string;
	projectName: (id: string) => string;
	onSaid: (said: string) => void;
	/** Opens "Track time"; null where nothing can be tracked. */
	onTrack: (() => void) | null;
	now: number;
}) {
	const fetcher = useFetcher<Outcome>();
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	const clock = useClockFormat(data.zone);
	const hasActive = data.projects.some((p) => !p.archived);
	const { running } = data;

	return (
		<section
			id={TIMER_ANCHOR}
			aria-labelledby="timer-heading"
			className="mt-8 flex max-w-200 scroll-mt-24 flex-col items-start gap-4"
		>
			{hasActive ? (
				<h2 id="timer-heading" className="sr-only">
					Timer
				</h2>
			) : (
				<div>
					<h2 id="timer-heading" className="text-title-large">
						No project to track yet
					</h2>
					<p className="mt-2 text-body-large text-on-surface-variant">
						Time is tracked against a project.{" "}
						<Link to={destinationPath(slug, "projects")} className={TEXT_LINK}>
							Create a project
						</Link>
					</p>
				</div>
			)}
			{onTrack && (
				<Button icon={<AddIcon size="medium" />} onPress={onTrack}>
					Track time
				</Button>
			)}
			{running && (
				<fetcher.Form
					method="post"
					onSubmit={(event) => {
						if (fetcher.state !== "idle") event.preventDefault();
					}}
					className="flex w-full flex-col gap-4 rounded-large border-2 border-on-surface p-4 medium:flex-row medium:items-end"
				>
					<input type="hidden" name="intent" value="stop" />
					<div className="min-w-0 flex-1">
						<p className="text-label-large text-on-surface-variant">
							Running since {clock(running.startedAt)}
						</p>
						<p className="truncate text-title-medium">
							{running.description || projectName(running.projectId)}
						</p>
						{running.description && (
							<p className="truncate text-body-medium text-on-surface-variant">
								{projectName(running.projectId)}
							</p>
						)}
					</div>
					<p role="timer" aria-label="Elapsed" className="text-headline-medium">
						<Digits value={formatElapsed(elapsedSeconds(running.startedAt, now))} />
					</p>
					<Button type="submit" variant="tonal">
						Stop timer
					</Button>
				</fetcher.Form>
			)}
			<p role="alert" className="text-body-medium text-error empty:hidden">
				{answer && !answer.ok ? answer.problem : null}
			</p>
			<SaidOnce answer={answer} onSaid={onSaid} />
		</section>
	);
}

/** Hands what the server said, once per answer, to the page's status line. */
function SaidOnce({
	answer,
	onSaid,
}: {
	answer: Outcome | undefined;
	onSaid: (said: string) => void;
}) {
	const handled = useRef<Outcome | undefined>(undefined);
	useEffect(() => {
		if (!answer || handled.current === answer) return;
		handled.current = answer;
		if (answer.ok) onSaid(answer.said);
	}, [answer, onSaid]);
	return null;
}
