import { use, useEffect, useId, useState, ViewTransition } from "react";
import { Link, useFetcher } from "react-router";

import { entryHistoryPath } from "~/activity/paths";
import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import { Digits } from "~/components/Digits";
import { IconButton } from "~/components/IconButton";
import { AddIcon } from "~/components/icons/AddIcon";
import { MoreVertIcon } from "~/components/icons/MoreVertIcon";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { PeriodStepper } from "~/components/PeriodStepper";
import { TextField } from "~/components/TextField";
import { StartArrowhead } from "~/components/TimerMark";
import { Tooltip } from "~/components/Tooltip";
import { type DayRule, overLabel } from "~/leave/rules";
import { LOCK_LABELS, lockSentence } from "~/locks/locks";
import type { Outcome } from "~/organisations/problems";
import { FormSheet } from "~/routes/app/FormSheet";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { TRANSITION, useTravel } from "~/shell/transitions";
import { EntryChoices } from "~/tasks/EntryChoices";
import { TrackChoicesContext } from "~/tasks/track";
import { addDays, type Day } from "~/time/calendar";
import { ENTRY_DESCRIPTION_MAX_LENGTH } from "~/time/entries";

import { DayPicker } from "./DayPicker";
import { OvertimeTag, refusalOfDay } from "./DayRules";
import { formatDuration, formatElapsed } from "./durations";
import { ChangedMark, useReport, useReportAnswer, useReported } from "./feedback";
import { dayNumber, useClockFormat, useDayFormat, usePeriodFormat } from "./format";
import { GettingStartedList, usePutAwayAnswer } from "./GettingStarted";
import { elapsedSeconds, useNow } from "./live";
import { PENDING_PROJECT_NAME, usePendingTimer } from "./pending";
import { PeriodHeader } from "./Submission";
import { durationOf, type SheetEntry } from "./sheets";
import { ShortcutsSheet, useTimesheetKeys } from "./shortcuts";
import { useTrackTime } from "./TrackTime";
import type { DayData } from "./timesheet.server";
import { dayPath, timerAction } from "./views";
import { WeekDays } from "./WeekDays";

/**
 * The Day view (TS-012a, TS-013, TS-012b, TS-056; taste HT-A to HT-F): the
 * day stepper, whose title opens the month (`DayPicker`), with "Back to today"
 * away from today; getting started while a step is left; the period's header
 * row with its "Submit week" (shared with the Week and Calendar views); the
 * period's seven days with their totals, today amber; "Track time", the
 * page's one filled action, and the running timer, amber, its elapsed time the
 * largest figure on the page; then the chosen day's entries, earliest first,
 * with a total. A finished entry starts again with one press, and is changed
 * in a sheet or deleted at once, with Undo in the snackbar. An empty day says
 * so with its action, and offers the entries of the last working day with
 * time. Nothing on a day in a submitted or approved period, or on or before
 * the lock date, can be tracked, started again or changed.
 *
 * A day's limit (TS-090): beside Track time, what is left of a day that has
 * one; on a day that takes no time, or has none left, Track time is disabled
 * and says why. A day over its limit says by how much, and marks its entries
 * as the ones to trim or move: changing and deleting them stay open.
 */
export function DayView({ data, slug }: { data: DayData; slug: string }) {
	const {
		day,
		today,
		entries,
		total,
		locked,
		lockReason,
		lockDate,
		projects,
		zone,
		now,
		submission,
	} = data;
	const formatDay = useDayFormat();
	const formatShort = useDayFormat("short");
	const formatPeriod = usePeriodFormat();
	const clock = useClockFormat(zone);
	const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
	const travel = useTravel(dayNumber(day));
	const starting = usePendingTimer(slug).starting !== null;
	const live = useNow(data.running !== null || starting, now);
	// The day's limit (TS-090): why nothing can be tracked on it, if nothing can.
	const rule = data.rules.find((r) => r.day === day);
	const blocked = refusalOfDay(rule);
	const canTrack = !locked && projects.some((p) => !p.archived) && blocked === null;
	// The day as leave sees it: its name and the time expected on it (TS-061).
	const shownDay = data.away.days.find((d) => d.day === day);
	const over = rule?.overMinutes ?? 0;
	// Of the day's time, how much is overtime: the total reads "7:30 + 1:00 overtime" (TS-095).
	const overtimeTotal = entries
		.filter((each) => each.overtime)
		.reduce((sum, each) => sum + durationOf(each, now), 0);
	const [entry, setEntry] = useState<SheetEntry | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	usePutAwayAnswer(setSaid);
	const openTrackTime = useTrackTime();
	const track = canTrack ? () => openTrackTime({ day }) : null;
	const report = useReport();
	const reported = useReported();
	useEffect(() => {
		if (reported) setSaid(reported.said);
	}, [reported]);

	// Deleting, starting again and copying are one press each, answered in the snackbar.
	const act = useFetcher<Outcome>();
	const acted = act.state === "idle" ? act.data : undefined;
	useReportAnswer(acted);
	const send = (fields: Record<string, string>) =>
		act.submit(fields, { method: "post", action: timerAction(slug) });
	const choices = use(TrackChoicesContext);
	const startAgain = (each: SheetEntry) => {
		const own = choices?.entries[each.id];
		const form = new FormData();
		form.set("intent", "track");
		form.set("projectId", each.projectId);
		form.set(PENDING_PROJECT_NAME, projectName(each.projectId));
		form.set("description", each.description ?? "");
		form.set("day", today);
		if (own?.taskId) form.set("taskId", own.taskId);
		for (const tag of own?.tagIds ?? []) form.append("tagIds", tag);
		act.submit(form, { method: "post", action: timerAction(slug) });
	};

	const keys = useTimesheetKeys({
		onNew: track ?? undefined,
		previous: dayPath(slug, addDays(day, -1)),
		next: dayPath(slug, addDays(day, 1)),
		today: dayPath(slug),
	});

	return (
		<>
			<div className="mt-6">
				<PeriodStepper
					label="Days"
					period={
						<DayPicker
							slug={slug}
							day={day}
							label={day === today ? `Today, ${formatShort(day)}` : formatDay(day)}
						/>
					}
					previous={{ to: dayPath(slug, addDays(day, -1)), label: "Previous day" }}
					next={{ to: dayPath(slug, addDays(day, 1)), label: "Next day" }}
					current={day === today ? undefined : { to: dayPath(slug), label: "Back to today" }}
				/>
			</div>

			{data.gettingStarted && <GettingStartedList steps={data.gettingStarted} slug={slug} />}

			{/* What changes with the day, from the period's header row down, moves
			    as one, as on the Week and Calendar views: the boundary starts just
			    below the stepper, so it is in view whenever it is used. */}
			<ViewTransition default="none" update={travel ? TRANSITION[travel] : "none"}>
				<div data-reveal-sections="">
					<div className="mt-6">
						<PeriodHeader
							title={formatPeriod(submission.period.startsOn, submission.period.endsOn)}
							submission={submission}
							onSaid={setSaid}
						/>
					</div>

					<WeekDays
						week={data.week}
						away={data.away}
						rules={data.rules}
						day={day}
						today={today}
						running={data.running}
						zone={zone}
						slug={slug}
					/>

					<Timer
						data={data}
						slug={slug}
						projectName={projectName}
						onTrack={track}
						rule={locked ? undefined : rule}
						blocked={locked ? null : blocked}
						now={live}
					/>

					{/* What the last task did. Always here, so what is put in it is read out. */}
					<p role="status" className="mt-6 text-body-medium text-on-surface-variant empty:hidden">
						{said}
					</p>
					<p role="alert" className="mt-2 text-body-medium text-error empty:hidden">
						{acted && !acted.ok ? acted.problem : null}
					</p>

					<div className="mt-6 max-w-200">
						<Ledger
							heading={day === today ? `Today, ${formatDay(day)}` : formatDay(day)}
							note={lockReason ? LOCK_LABELS[lockReason] : over > 0 ? overLabel(over) : undefined}
						>
							{shownDay && (
								<p className="px-4 pb-3 text-body-medium text-on-surface-variant @sm:px-5">
									{shownDay.label ? `${shownDay.label}. ` : ""}
									{formatDuration(shownDay.expectedMinutes * 60_000)} expected.
								</p>
							)}
							{over > 0 && (
								<p role="note" className="px-4 pb-3 text-body-medium text-error @sm:px-5">
									{overLabel(over)}
									{rule?.limitMinutes != null
										? ` of the ${formatDuration(rule.limitMinutes * 60_000)} this day takes`
										: ""}
									. Trim or move one of these entries before you submit the week.
								</p>
							)}
							{entries.length === 0 ? (
								<EmptyDay
									day={day}
									isToday={day === today}
									onTrack={track}
									copyFrom={data.copyFrom}
									onCopy={() => send({ intent: "copy-day", day })}
								/>
							) : (
								<LedgerRows label={over > 0 ? "Entries to trim or move" : "Entries"}>
									{entries.map((each) => {
										const isRunning = each.endedAt === null;
										const name = projectName(each.projectId);
										const what = each.description || name;
										return (
											<LedgerRow
												key={each.id}
												className={cx(
													"relative",
													isRunning &&
														"-mx-4 bg-primary-container px-4 text-on-primary-fixed @sm:-mx-5 @sm:px-5",
												)}
												title={
													<>
														<ChangedMark id={each.id} reported={reported} />
														<span className="wrap-anywhere">{what}</span>
														{each.overtime && (
															<>
																<span className="sr-only">, </span>{" "}
																<OvertimeTag onAmber={isRunning} />
															</>
														)}
													</>
												}
												detail={
													each.description ? (
														<span className={isRunning ? "text-on-primary-fixed" : undefined}>
															{name}
														</span>
													) : undefined
												}
												aside={
													<span className={isRunning ? "text-on-primary-fixed" : undefined}>
														{`${clock(each.startedAt)}–${isRunning ? "Running" : clock(each.endedAt as number)}`}
													</span>
												}
												value={formatDuration(durationOf(each, now))}
												action={
													!locked &&
													!isRunning && (
														<>
															<Tooltip label="Start again">
																<IconButton
																	variant="outlined"
																	label={`Start again: ${what}`}
																	onPress={() => startAgain(each)}
																>
																	<StartArrowhead />
																</IconButton>
															</Tooltip>
															<MenuTrigger>
																<IconButton label={`Actions for ${what}, ${clock(each.startedAt)}`}>
																	<MoreVertIcon />
																</IconButton>
																<Menu
																	onAction={(chosen) => {
																		if (chosen === "edit") setEntry(each);
																		if (chosen === "delete")
																			send({ intent: "delete", entryId: each.id });
																	}}
																>
																	<MenuItem id="edit">Edit entry</MenuItem>
																	<MenuItem id="delete">Delete entry</MenuItem>
																	<MenuItem id="history" href={entryHistoryPath(slug, each.id)}>
																		History
																	</MenuItem>
																</Menu>
															</MenuTrigger>
														</>
													)
												}
											/>
										);
									})}
								</LedgerRows>
							)}
							<LedgerTotal
								label="Day total"
								value={
									overtimeTotal > 0
										? `${formatDuration(total - overtimeTotal)} + ${formatDuration(overtimeTotal)} overtime`
										: formatDuration(total)
								}
							/>
						</Ledger>
						{lockReason && (
							<p className="mt-4 text-body-medium text-on-surface-variant">
								{lockSentence(lockReason, lockDate, formatDay)}
							</p>
						)}
					</div>
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
				{entry && <EntryFields key={`edit-${entry.id}`} data={data} entry={entry} clock={clock} />}
			</FormSheet>

			<ShortcutsSheet isOpen={keys.helpOpen} onOpenChange={keys.setHelpOpen} />
		</>
	);
}

/**
 * An empty day (taste HT-F): one sentence of what will be here, and its
 * action, Track time, with the copy of the last working day's entries beside
 * it where there is one to copy.
 */
function EmptyDay({
	day,
	isToday,
	onTrack,
	copyFrom,
	onCopy,
}: {
	day: Day;
	isToday: boolean;
	onTrack: (() => void) | null;
	copyFrom: Day | null;
	onCopy: () => void;
}) {
	const formatDay = useDayFormat();
	const formatShort = useDayFormat("short");
	// "today", or "on Tuesday 10 November": never "on today".
	const when = isToday ? "today" : `on ${formatDay(day)}`;
	return (
		<div className="px-4 pb-4 @sm:px-5">
			<p className="text-body-large text-on-surface-variant">
				{onTrack
					? `Nothing yet ${when}. Track time${copyFrom ? `, or copy ${formatShort(copyFrom)}'s entries` : ""}.`
					: `Nothing tracked ${when}.`}
			</p>
			{onTrack && (
				<div className="mt-2 flex flex-wrap gap-2">
					<Button
						variant="text"
						icon={<AddIcon size="medium" />}
						aria-label={`Track time ${when}`}
						onPress={onTrack}
					>
						Track time
					</Button>
					{copyFrom && (
						<Button variant="text" onPress={onCopy}>
							{`Copy ${formatShort(copyFrom)}'s entries`}
						</Button>
					)}
				</div>
			)}
		</div>
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
			<EntryChoices projects={offered} defaultProjectId={entry.projectId} entryId={entry.id} />
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
 * "Track time", which opens its sheet over the page, and the running entry
 * with its elapsed time and Stop. The running entry is amber, the one thing
 * on the page that is live (docs/design-direction.md), and its elapsed time
 * the largest figure on the page (taste HT-B). With no active project, the
 * way to create one instead; on a locked day, no "Track time". Where the day
 * takes no time, or has none left, Track time is disabled and says why
 * beside it; where the day has a limit, what is left of it stands beside it
 * (TS-090).
 */
function Timer({
	data,
	slug,
	projectName,
	onTrack,
	rule,
	blocked,
	now,
}: {
	data: DayData;
	slug: string;
	projectName: (id: string) => string;
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
	useReportAnswer(answer);
	const clock = useClockFormat(data.zone);
	const hasActive = data.projects.some((p) => !p.archived);
	const pending = usePendingTimer(slug);
	// A start or a stop on its way already shows as done (TS-096); a refusal puts it back.
	const running = pending.starting
		? {
				projectId: pending.starting.projectId,
				description: pending.starting.description || null,
				startedAt: pending.starting.startedAt,
			}
		: pending.stopping
			? null
			: data.running;
	const whyId = useId();
	const why =
		blocked ??
		(rule && rule.limitMinutes !== null
			? `${formatDuration((rule.leftMinutes ?? 0) * 60_000)} left of ${formatDuration(rule.limitMinutes * 60_000)}`
			: null);

	return (
		<section
			aria-labelledby="timer-heading"
			className="mt-8 flex max-w-200 flex-col items-start gap-4"
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
					action={timerAction(slug)}
					onSubmit={(event) => {
						if (fetcher.state !== "idle") event.preventDefault();
					}}
					className="flex w-full flex-col gap-4 rounded-large bg-primary-container p-4 text-on-primary-fixed medium:flex-row medium:items-end"
				>
					<input type="hidden" name="intent" value="stop" />
					<div className="min-w-0 flex-1">
						<p className="text-label-large">Running since {clock(running.startedAt)}</p>
						<p className="truncate text-title-medium">
							{running.description || projectName(running.projectId)}
						</p>
						{running.description && (
							<p className="truncate text-body-medium">{projectName(running.projectId)}</p>
						)}
					</div>
					<p role="timer" aria-label="Elapsed" className="text-display-small tabular-nums">
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
		</section>
	);
}
