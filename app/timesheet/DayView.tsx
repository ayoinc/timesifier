import { useEffect, useRef, useState, ViewTransition } from "react";
import { Link, useFetcher } from "react-router";

import { Button } from "~/components/Button";
import { Digits } from "~/components/Digits";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import type { Outcome } from "~/organisations/problems";
import { FormSheet } from "~/routes/app/FormSheet";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { TRANSITION, useTravel } from "~/shell/transitions";
import { addDays } from "~/time/calendar";
import { ENTRY_DESCRIPTION_MAX_LENGTH } from "~/time/entries";

import { formatDuration, formatElapsed } from "./durations";
import { dayNumber, useClockFormat, useDayFormat } from "./format";
import { elapsedSeconds, useNow } from "./live";
import { PeriodLinks } from "./PeriodLinks";
import { durationOf, type SheetEntry } from "./sheets";
import type { DayData } from "./timesheet.server";
import { dayPath, TIMER_ANCHOR } from "./views";

/**
 * The Day view (TS-012a, TS-013, TS-012b): the timer, then the chosen day's
 * entries, earliest first, with a total. The timer's button is the page's one
 * primary action; an entry is added, changed or deleted by hand in a sheet.
 * Nothing on a day in a submitted or approved period can be changed.
 */
export function DayView({ data, slug }: { data: DayData; slug: string }) {
	const { day, today, entries, total, locked, projects, zone, now } = data;
	const formatDay = useDayFormat();
	const clock = useClockFormat(zone);
	const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
	const travel = useTravel(dayNumber(day));
	const live = useNow(data.running !== null, now);

	const [task, setTask] = useState<"add" | "edit" | "delete" | null>(null);
	const [entry, setEntry] = useState<SheetEntry | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	return (
		<>
			<PeriodLinks
				label="Days"
				previous={{ to: dayPath(slug, addDays(day, -1)), label: "Previous day" }}
				current={{ to: dayPath(slug), label: "Today", isCurrent: day === today }}
				next={{ to: dayPath(slug, addDays(day, 1)), label: "Next day" }}
			/>

			<Timer data={data} slug={slug} projectName={projectName} onSaid={setSaid} now={live} />

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
					{locked ? (
						<p className="mt-4 text-body-medium text-on-surface-variant">
							This day is in a submitted or approved week, so its entries cannot be changed.
						</p>
					) : (
						<div className="mt-4">
							<Button
								variant="outlined"
								onPress={() => {
									setEntry(null);
									setTask("add");
								}}
							>
								Add entry
							</Button>
						</div>
					)}
				</div>
			</ViewTransition>

			<FormSheet
				title="Add an entry"
				intent="add"
				submitLabel="Add"
				isOpen={task === "add"}
				onClose={close}
				onDone={setSaid}
			>
				<EntryFields key={`add-${day}`} data={data} />
			</FormSheet>

			<FormSheet
				title="Edit entry"
				intent="edit"
				submitLabel="Save"
				isOpen={task === "edit"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="entryId" value={entry?.id ?? ""} />
				<EntryFields key={`edit-${entry?.id}`} data={data} entry={entry} clock={clock} />
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
 * The fields of an entry made by hand: its project, its day and its start and
 * end, read in the person's zone, and a description. Native date and time
 * inputs, which write no `style` attribute (docs/security.md).
 */
function EntryFields({
	data,
	entry,
	clock,
}: {
	data: DayData;
	entry?: SheetEntry | null;
	clock?: (instant: number) => string;
}) {
	const offered = data.projects.filter((p) => !p.archived || p.id === entry?.projectId);
	return (
		<>
			<Select
				label="Project"
				name="projectId"
				options={offered.map((p) => ({ id: p.id, label: p.name }))}
				defaultValue={entry?.projectId ?? offered[0]?.id ?? null}
				isRequired
			/>
			<TextField label="Date" name="date" type="date" defaultValue={data.day} isRequired />
			<div className="grid grid-cols-2 gap-4">
				<TextField
					label="Start"
					name="start"
					type="time"
					defaultValue={entry && clock ? clock(entry.startedAt) : ""}
					isRequired
				/>
				<TextField
					label="End"
					name="end"
					type="time"
					defaultValue={entry?.endedAt && clock ? clock(entry.endedAt) : ""}
					isRequired
				/>
			</div>
			<TextField
				label="Description"
				name="description"
				defaultValue={entry?.description ?? ""}
				maxLength={ENTRY_DESCRIPTION_MAX_LENGTH}
			/>
		</>
	);
}

/**
 * The timer (TS-012a), where "Start timer" in the navigation leads: the
 * running entry with its elapsed time and Stop, or the active projects to
 * choose from and "Start timer", or, with none, the way to create one.
 */
function Timer({
	data,
	slug,
	projectName,
	onSaid,
	now,
}: {
	data: DayData;
	slug: string;
	projectName: (id: string) => string;
	onSaid: (said: string) => void;
	now: number;
}) {
	const fetcher = useFetcher<Outcome>();
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	const clock = useClockFormat(data.zone);
	const active = data.projects.filter((p) => !p.archived);
	const { running } = data;

	return (
		<section
			id={TIMER_ANCHOR}
			aria-labelledby="timer-heading"
			className="mt-8 max-w-200 scroll-mt-24"
		>
			{active.length === 0 && !running ? (
				<>
					<h2 id="timer-heading" className="text-title-large">
						No project to track yet
					</h2>
					<p className="mt-2 text-body-large text-on-surface-variant">
						Time is tracked against a project.{" "}
						<Link to={destinationPath(slug, "projects")} className={TEXT_LINK}>
							Create a project
						</Link>
					</p>
				</>
			) : (
				<>
					<h2 id="timer-heading" className="sr-only">
						Timer
					</h2>
					<fetcher.Form
						method="post"
						onSubmit={(event) => {
							if (fetcher.state !== "idle") event.preventDefault();
						}}
						className="flex flex-col gap-4 rounded-large border-2 border-on-surface p-4 @container medium:flex-row medium:items-end"
					>
						{running ? (
							<>
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
								<Button type="submit">Stop timer</Button>
							</>
						) : (
							<>
								<input type="hidden" name="intent" value="start" />
								<div className="min-w-0 flex-1">
									<Select
										label="Project"
										name="projectId"
										options={active.map((p) => ({ id: p.id, label: p.name }))}
										defaultValue={active[0]?.id ?? null}
										isRequired
									/>
								</div>
								<div className="min-w-0 flex-1">
									<TextField
										label="What are you working on?"
										name="description"
										maxLength={ENTRY_DESCRIPTION_MAX_LENGTH}
									/>
								</div>
								<Button type="submit">Start timer</Button>
							</>
						)}
					</fetcher.Form>
					<p role="alert" className="mt-2 text-body-medium text-error empty:hidden">
						{answer && !answer.ok ? answer.problem : null}
					</p>
					<SaidOnce answer={answer} onSaid={onSaid} />
				</>
			)}
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
