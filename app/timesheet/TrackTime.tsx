import {
	createContext,
	type ReactNode,
	use,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Link, useFetcher } from "react-router";

import { Skeleton } from "~/components/Skeleton";
import { showSnackbar } from "~/components/Snackbar";
import { TextField } from "~/components/TextField";
import { LOCK_LABELS, lockSentence } from "~/locks/locks";
import type { Outcome } from "~/organisations/problems";
import { FormSheet } from "~/routes/app/FormSheet";
import type { loader as trackDayLoader } from "~/routes/app/timesheet.day";
import { destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { EntryChoices } from "~/tasks/EntryChoices";
import { TrackChoicesContext } from "~/tasks/track";
import type { Day } from "~/time/calendar";
import { ENTRY_DESCRIPTION_MAX_LENGTH } from "~/time/entries";
import { refusalOfDay, takesOvertimeOnly } from "./DayRules";
import { formatDuration } from "./durations";
import { useReport } from "./feedback";
import { useDayFormat } from "./format";
import { PENDING_PROJECT_NAME } from "./pending";
import { timerAction, trackDayPath } from "./views";

/**
 * "Track time" (TS-056, amended by taste HT-C): one sheet, opened over
 * whatever page of the organisation is showing, from the navigation's timer,
 * the Day view, the calendar's slots, an empty day and the key N. The address
 * does not change, and closing it gives the focus back to what opened it.
 *
 * A project, its task and tags, a description, a date and hours. The date
 * starts at the day shown on the Timesheet and at today anywhere else. With no
 * hours on today the action is "Start timer", which runs from now; with hours,
 * `1.5`, `1,5` or `1:30`, it is "Save entry", one entry of that length on the
 * date. Opened from a slot of the calendar (TS-062) it has a start too.
 *
 * The rules of the date chosen are read with it (`timesheet.day.ts`): a locked
 * day, a day that takes no time (a public holiday, whole-day leave) and a day
 * with none left say why and hold the action back; a day with a limit says
 * what it has left (TS-090). A day whose regular time is used and that takes
 * overtime asks for Overtime instead of Hours, and its time is sent as
 * overtime; a timer started on it runs as overtime (TS-095). The server
 * refuses the same, whatever is sent.
 *
 * While the day's rules are read, the sheet holds the shape of its fields
 * (`Skeleton`). "Start timer" is a quick action (TS-096): the sheet closes at
 * once and every timer on the page runs (`usePendingTimer`); a refusal stops
 * them again and the snackbar says why.
 */

/** What the sheet is opened with: the day to start at, and a start from a calendar slot. */
export interface TrackTimeRequest {
	day?: Day;
	/** `09:30`, where a slot of the calendar was chosen. */
	start?: string;
}

const TrackTimeContext = createContext<(request?: TrackTimeRequest) => void>(() => {});

/** Opens the Track time sheet over the page. */
export function useTrackTime(): (request?: TrackTimeRequest) => void {
	return use(TrackTimeContext);
}

/** The sheet itself, once for the whole organisation, and the way to open it. */
export function TrackTimeProvider({ slug, children }: { slug: string; children: ReactNode }) {
	// A new key each time it opens, so its fields start afresh.
	const [request, setRequest] = useState<(TrackTimeRequest & { key: number }) | null>(null);
	const [shown, setShown] = useState<TrackTimeRequest & { key: number }>({ key: 0 });
	const open = useCallback((asked: TrackTimeRequest = {}) => {
		const next = { ...asked, key: Date.now() };
		setShown(next);
		setRequest(next);
	}, []);

	// A timer's start, sent once the sheet has closed: it outlives the sheet.
	const report = useReport();
	const start = useFetcher<Outcome>();
	const { submit } = start;
	const started = start.state === "idle" ? start.data : undefined;
	const handled = useRef<Outcome | undefined>(undefined);
	useEffect(() => {
		if (!started || handled.current === started) return;
		handled.current = started;
		if (started.ok) report(started);
		else showSnackbar(started.problem);
	}, [started, report]);
	const startTimer = useCallback(
		(form: FormData) => submit(form, { method: "post", action: timerAction(slug) }),
		[slug, submit],
	);

	return (
		<TrackTimeContext value={open}>
			{children}
			<TrackTimeSheet
				key={shown.key}
				slug={slug}
				request={shown}
				isOpen={request !== null}
				onClose={() => setRequest(null)}
				onStartTimer={startTimer}
			/>
		</TrackTimeContext>
	);
}

function TrackTimeSheet({
	slug,
	request,
	isOpen,
	onClose,
	onStartTimer,
}: {
	slug: string;
	request: TrackTimeRequest;
	isOpen: boolean;
	onClose: () => void;
	/** Sends a timer's start on its own, so the sheet can close at once. */
	onStartTimer: (form: FormData) => void;
}) {
	const report = useReport();
	const formatDay = useDayFormat();
	const fetcher = useFetcher<typeof trackDayLoader>();
	const { load } = fetcher;
	const [date, setDate] = useState<string>(request.day ?? "");
	const [hours, setHours] = useState("");

	// The day's rules are read when the sheet opens and each time the date changes to a whole one.
	const asked = /^\d{4}-\d{2}-\d{2}$/.test(date) ? (date as Day) : undefined;
	useEffect(() => {
		if (!isOpen) return;
		load(trackDayPath(slug, asked));
	}, [isOpen, slug, asked, load]);

	const data = fetcher.data;
	// The date the data is for, once it has come: today when none was asked for.
	useEffect(() => {
		if (data && date === "") setDate(data.day);
	}, [data, date]);
	const current = data && (asked === undefined || data.day === asked) ? data : undefined;

	const active = (data?.projects ?? []).filter((p) => !p.archived);
	const isToday = current !== undefined && current.day === current.today;
	const timerAllowed = isToday && request.start === undefined;
	const startsTimer = timerAllowed && hours.trim() === "";
	const rule = current?.rule ?? undefined;
	const lockReason = current?.lockReason ?? null;
	const closed = lockReason ? null : refusalOfDay(rule);
	const overtime = lockReason === null && takesOvertimeOnly(rule);
	const recent = data?.track.recent ?? [];
	const firstChoice = recent.find((id) => active.some((p) => p.id === id)) ?? active[0]?.id ?? null;
	const loading = data === undefined;

	return (
		<FormSheet
			title="Track time"
			intent="track"
			action={timerAction(slug)}
			submitLabel={startsTimer ? "Start timer" : "Save entry"}
			isSubmitDisabled={
				current === undefined || active.length === 0 || lockReason !== null || closed !== null
			}
			isOpen={isOpen}
			onClose={onClose}
			onDone={(_said, answer) => report(answer)}
			onSubmitAtOnce={(form) => {
				if (!startsTimer) return false;
				const project = active.find((p) => p.id === form.get("projectId"));
				if (project) form.set(PENDING_PROJECT_NAME, project.name);
				onStartTimer(form);
				return true;
			}}
		>
			{loading ? (
				<FieldsSkeleton />
			) : active.length === 0 ? (
				<p className="text-body-large text-on-surface-variant">
					Time is tracked against a project, and this organisation has none yet.{" "}
					<Link to={destinationPath(slug, "projects")} onClick={onClose} className={TEXT_LINK}>
						Create a project
					</Link>
				</p>
			) : (
				<TrackChoicesContext value={data.track}>
					<EntryChoices projects={active} defaultProjectId={firstChoice} autoFocusProject />
					<TextField
						label="Description"
						name="description"
						maxLength={ENTRY_DESCRIPTION_MAX_LENGTH}
					/>
					<TextField
						label={overtime ? "Overtime" : "Hours"}
						name="hours"
						value={hours}
						onChange={setHours}
						inputMode="decimal"
						autoComplete="off"
						maxLength={16}
						isRequired={!timerAllowed}
						description={
							timerAllowed
								? `As 1.5, 1,5 or 1:30. Leave it empty to start a timer${overtime ? " of overtime" : ""}.`
								: "As 1.5, 1,5 or 1:30. A timer runs today only."
						}
					/>
					{overtime && <input type="hidden" name="overtime" value="true" />}
					<div className="grid grid-cols-2 gap-4">
						<TextField
							label="Date"
							name="day"
							type="date"
							value={date}
							onChange={setDate}
							isRequired
						/>
						{request.start !== undefined && (
							<TextField
								label="Start"
								name="start"
								type="time"
								defaultValue={request.start}
								isRequired
							/>
						)}
					</div>
					<DayNote
						day={current?.day}
						isToday={isToday}
						formatDay={formatDay}
						lock={lockReason ? lockSentence(lockReason, null, formatDay) : null}
						lockLabel={lockReason ? LOCK_LABELS[lockReason] : null}
						closed={closed}
						left={
							rule && overtime
								? overtimeNote(rule.limitMinutes ?? 0, rule.overtimeLeftMinutes)
								: rule &&
										rule.limitMinutes !== null &&
										rule.closedReason === null &&
										closed === null
									? `This day has ${formatDuration((rule.leftMinutes ?? 0) * 60_000)} left of ${formatDuration(rule.limitMinutes * 60_000)}.`
									: null
						}
					/>
				</TrackChoicesContext>
			)}
		</FormSheet>
	);
}

/** What the sheet says of a day whose time is overtime: why, and how much of it is left. */
function overtimeNote(limitMinutes: number, leftMinutes: number | null): string {
	const why =
		limitMinutes === 0
			? "No regular time is expected on this day"
			: `This day's ${formatDuration(limitMinutes * 60_000)} of regular time is tracked`;
	const left = leftMinutes === null ? "" : `, ${formatDuration(leftMinutes * 60_000)} of it left`;
	return `${why}: more is overtime${left}.`;
}

/**
 * The sheet's fields while the day's rules are read: project, description,
 * hours and date, each the height of its field, so nothing moves when they
 * come. Said once to assistive technology.
 */
function FieldsSkeleton() {
	return (
		<div role="status" aria-label="Loading your projects" className="flex flex-col gap-4">
			<Skeleton className="h-14 w-full" />
			<Skeleton className="h-14 w-full" />
			<Skeleton className="h-14 w-full" />
			<div className="grid grid-cols-2 gap-4">
				<Skeleton className="h-14" />
			</div>
		</div>
	);
}

/** What the sheet says of the date chosen: which day it is, and why it takes nothing or how much. */
function DayNote({
	day,
	isToday,
	formatDay,
	lock,
	lockLabel,
	closed,
	left,
}: {
	day: Day | undefined;
	isToday: boolean;
	formatDay: (day: Day) => string;
	lock: string | null;
	lockLabel: string | null;
	closed: string | null;
	left: string | null;
}) {
	if (!day) return null;
	const said = lock ?? closed ?? left;
	return (
		<p className="text-body-medium text-on-surface-variant">
			{isToday ? `Today, ${formatDay(day)}` : formatDay(day)}
			{lockLabel ? `. ${lockLabel}` : ""}
			{said ? <span className={lock || closed ? "block text-error" : "block"}>{said}</span> : null}
		</p>
	);
}
