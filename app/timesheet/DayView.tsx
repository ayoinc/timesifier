import { useEffect, useId, useRef, useState, ViewTransition } from "react";
import { Link, useFetcher, useLocation } from "react-router";

import { Button } from "~/components/Button";
import { Digits } from "~/components/Digits";
import { AddIcon } from "~/components/icons/AddIcon";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { type DayRule, overLabel } from "~/leave/rules";
import { minutesLabel } from "~/leave/words";
import type { Outcome } from "~/organisations/problems";
import { FormSheet } from "~/routes/app/FormSheet";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { TRANSITION, useTravel } from "~/shell/transitions";
import { addDays } from "~/time/calendar";
import { ENTRY_DESCRIPTION_MAX_LENGTH } from "~/time/entries";

import { refusalOfDay } from "./DayRules";
import { formatDuration, formatElapsed } from "./durations";
import { dayNumber, useClockFormat, useDayFormat, usePeriodFormat } from "./format";
import { GettingStartedList, usePutAwayAnswer } from "./GettingStarted";
import { elapsedSeconds, useNow } from "./live";
import { PeriodLinks } from "./PeriodLinks";
import { PeriodHeader } from "./Submission";
import { durationOf, type SheetEntry } from "./sheets";
import type { DayData } from "./timesheet.server";
import { dayPath, TIMER_ANCHOR } from "./views";
import { WeekDays } from "./WeekDays";

/**
 * The Day view (TS-012a, TS-013, TS-012b, TS-056): getting started while a
 * step is left, the period's header row with its "Submit week" (shared with
 * the Week and Calendar views), the period's seven days with their totals,
 * "Track time", the page's one primary action, with the running timer and its
 * Stop, then the chosen day's entries, earliest first, with a total. An entry
 * is changed or deleted in a sheet. Nothing on a day in a submitted or
 * approved period can be tracked or changed.
 *
 * A day's limit (TS-090): beside Track time, what is left of a day that has
 * one; on a day that takes no time, or has none left, Track time is disabled
 * and says why. A day over its limit says by how much, and marks its entries
 * as the ones to trim or move: changing and deleting them stay open.
 */
export function DayView({ data, slug }: { data: DayData; slug: string }) {
	const { day, today, entries, total, locked, projects, zone, now, submission } = data;
	const formatDay = useDayFormat();
	const formatPeriod = usePeriodFormat();
	const clock = useClockFormat(zone);
	const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
	const travel = useTravel(dayNumber(day));
	const live = useNow(data.running !== null, now);
	// The day's limit (TS-090): why nothing can be tracked on it, if nothing can.
	const rule = data.rules.find((r) => r.day === day);
	const blocked = refusalOfDay(rule);
	const canTrack = !locked && projects.some((p) => !p.archived) && blocked === null;
	// The day as leave sees it: its name and the time expected on it (TS-061).
	const shownDay = data.away.days.find((d) => d.day === day);
	const over = rule?.overMinutes ?? 0;
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

			{/* What changes with the day, from the period's header row down, moves
			    as one, as on the Week and Calendar views: the boundary starts just
			    below the links that step, so it is in view whenever they are used. */}
			<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
				<div>
					<div className="mt-6">
						<PeriodHeader
							title={formatPeriod(submission.period.startsOn, submission.period.endsOn)}
							submission={submission}
							onSaid={setSaid}
						/>
					</div>

					<WeekDays week={data.week} away={data.away} rules={data.rules} day={day} slug={slug} />

					<Timer
						data={data}
						slug={slug}
						projectName={projectName}
						onSaid={setSaid}
						onTrack={canTrack ? () => setTask("track") : null}
						rule={locked ? undefined : rule}
						blocked={locked ? null : blocked}
						now={live}
					/>

					{/* What the last task did. Always here, so what is put in it is read out. */}
					<p role="status" className="mt-6 text-body-medium text-on-surface-variant empty:hidden">
						{said}
					</p>

					<div className="mt-6 max-w-200">
						<Ledger
							heading={day === today ? `Today, ${formatDay(day)}` : formatDay(day)}
							note={locked ? "Submitted" : over > 0 ? overLabel(over) : undefined}
						>
							{shownDay && (
								<p className="px-4 pb-3 text-body-medium text-on-surface-variant @sm:px-5">
									{shownDay.label ? `${shownDay.label}. ` : ""}
									{minutesLabel(shownDay.expectedMinutes)} expected.
								</p>
							)}
							{over > 0 && (
								<p role="note" className="px-4 pb-3 text-body-medium text-error @sm:px-5">
									{overLabel(over)}
									{rule?.limitMinutes != null
										? ` of the ${minutesLabel(rule.limitMinutes)} this day takes`
										: ""}
									. Trim or move one of these entries before you submit the week.
								</p>
							)}
							{entries.length === 0 ? (
								<p className="px-4 pb-4 text-body-large text-on-surface-variant @sm:px-5">
									Nothing tracked on this day.
								</p>
							) : (
								<LedgerRows label={over > 0 ? "Entries to trim or move" : "Entries"}>
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
				</div>
			</ViewTransition>

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
 * with the slot's, and the hours are asked for from that time. A day with a
 * limit says what it has left (TS-090); the server refuses what does not fit.
 * It is not offered on a day that takes no time, nor one with none left.
 */
export function TrackTime({
	data,
	start,
	isOpen,
	onClose,
	onDone,
}: {
	data: Pick<DayData, "day" | "today" | "projects" | "rules">;
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
	const rule = data.rules.find((r) => r.day === data.day);
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
			{rule && rule.limitMinutes !== null && rule.closedReason === null && (
				<p role="note" className="text-body-medium text-on-surface-variant">
					This day has {minutesLabel(rule.leftMinutes ?? 0)} left of{" "}
					{minutesLabel(rule.limitMinutes)}.
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
 * Where the day takes no time, or has none left, Track time is disabled and
 * says why beside it; where the day has a limit, what is left of it stands
 * beside it (TS-090).
 */
function Timer({
	data,
	slug,
	projectName,
	onSaid,
	onTrack,
	rule,
	blocked,
	now,
}: {
	data: DayData;
	slug: string;
	projectName: (id: string) => string;
	onSaid: (said: string) => void;
	/** Opens "Track time"; null where nothing can be tracked. */
	onTrack: (() => void) | null;
	/** The shown day's limit, while its entries can change. */
	rule: DayRule | undefined;
	/** Why nothing can be tracked on the shown day, when it is its limit that says so. */
	blocked: string | null;
	now: number;
}) {
	const fetcher = useFetcher<Outcome>();
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	const clock = useClockFormat(data.zone);
	const hasActive = data.projects.some((p) => !p.archived);
	const { running } = data;
	const whyId = useId();
	const why =
		blocked ??
		(rule && rule.limitMinutes !== null
			? `${minutesLabel(rule.leftMinutes ?? 0)} left of ${minutesLabel(rule.limitMinutes)}`
			: null);

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
			{(onTrack || (hasActive && blocked)) && (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<Button
						icon={<AddIcon size="medium" />}
						isDisabled={onTrack === null}
						aria-describedby={why ? whyId : undefined}
						onPress={onTrack ?? undefined}
					>
						Track time
					</Button>
					{why && (
						<p id={whyId} className="max-w-120 text-body-medium text-on-surface-variant">
							{why}
						</p>
					)}
				</div>
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
