import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { cx } from "~/components/cx";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { type OrganisationScope, organisationScope } from "~/db";
import { halfDaysTaken } from "~/leave/days";
import {
	HOLIDAY_KIND,
	halfDaysLabel,
	LEAVE_STATUS_LABELS,
	LEAVE_TEXT_MAX_LENGTH,
	requestableKinds,
} from "~/leave/kinds";
import {
	cancelLeave,
	decideLeave,
	leaveDecidablePeople,
	myLeave,
	publicHolidaysOf,
	requestLeave,
	requestsToDecide,
	type Stepped,
	someoneElseDecides,
	TEAM_LEAVE_AHEAD_DAYS,
	teamLeaveAhead,
	withdrawLeave,
	workingWeekOf,
} from "~/leave/leave.server";
import {
	daysLabel,
	earliestNoticed,
	isShortNotice,
	NOTICE_REASON_MAX_LENGTH,
	noticeAsked,
	noticeGiven,
	noticeLabel,
	WORK_KIND_LABELS,
	WorkKind,
} from "~/leave/rules";
import { timesheetRulesOf } from "~/leave/rules.server";
import {
	MyWork,
	type MyWorkItem,
	WorkFields,
	type WorkItemToDecide,
	WorkToDecideSection,
} from "~/leave/WorkRequests";
import { dateWords, minutesLabel, spanLabel } from "~/leave/words";
import {
	cancelWork,
	decideWork,
	myWork,
	requestWork,
	type WorkToDecide,
	withdrawWork,
	workToDecide,
} from "~/leave/work.server";
import { parseRequest } from "~/lib/validate";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, viewerOf } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { canSee, destination, destinationPath } from "~/shell/destinations";
import { EmptySheet, PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { Day, dayOf } from "~/time/calendar";
import { zoneOfMember } from "~/time/zones.server";
import { TypedHours } from "~/timesheet/durations";

import type { Route } from "./+types/time-off";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Time off (TS-061), under Track: a person's balance of each kind of leave in
// this year, their requests and where each stands, and a sheet to ask for more.
// A request of a kind that needs a decision waits for a manager of a team the
// person is in, or an owner or admin; sick leave is approved as it is made.
// Whoever decides somebody's leave also has the Requests tab: the requests
// waiting for them, to approve or refuse, and the approved leave to come, which
// an owner or admin may cancel with a reason. Nobody decides their own.
//
// TS-090: the request sheet states each kind's notice and asks why when the
// first day comes sooner; approvers see the notice every request gave. Where
// the organisation allows overtime or weekend work only with pre-approval, it
// is asked for here and decided like leave. The page also lists the leave to
// come of the people the person works with, naming the kind only where they
// may see it.

const { label } = destination("time-off");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** The query that opens the Requests tab. */
const SHOW_PARAM = "show";

/** A request for work's days in words: "14 to 18 December 2026". */
function workDaysLabel(work: { startsOn: Day; endsOn: Day }): string {
	return spanLabel({
		startsOn: work.startsOn,
		endsOn: work.endsOn,
		startsHalf: false,
		endsHalf: false,
	});
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation, user } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const zone = await zoneOfMember(membership);
	const today = dayOf(Date.now(), zone);
	const year = Number(today.slice(0, 4));
	const decides = canSee(viewerOf(membership), "approvals");
	const show =
		decides && new URL(request.url).searchParams.get(SHOW_PARAM) === "requests"
			? "requests"
			: "mine";
	const access = await accessOf(membership);

	const [mine, week, holidays, decidedByOthers, rules, work, teamLeave] = await Promise.all([
		myLeave(scope, user.id, year),
		workingWeekOf(scope),
		publicHolidaysOf(scope, { first: today, last: `${year + 1}-12-31` }),
		someoneElseDecides(scope, user.id),
		timesheetRulesOf(organisation.id),
		myWork(scope, user.id),
		teamLeaveAhead(scope, organisation, access, today),
	]);
	const holidayKind = mine.kinds.find((k) => k.key === HOLIDAY_KIND);
	const calendar = {
		week,
		holidays: new Map(holidayKind?.enabled === false ? [] : holidays.map((h) => [h.day, h.name])),
	};

	let requests = null;
	let waiting = 0;
	if (decides) {
		const people = await leaveDecidablePeople(scope, organisation, access);
		const todayOf = (person: { timeZone: string }) => dayOf(Date.now(), person.timeZone);
		const [listed, workListed] = await Promise.all([
			requestsToDecide(scope, access, people, todayOf),
			workToDecide(scope, access, people, todayOf),
		]);
		waiting = listed.pending.length + workListed.pending.length;
		if (show === "requests") {
			const shape = (r: (typeof listed.pending)[number]) => ({
				id: r.id,
				person: r.person.name,
				kind: r.kindName,
				days: spanLabel(r),
				takes: halfDaysLabel(r.halfDays),
				note: r.note,
				notice: noticeLabel(r),
				shortNotice: r.shortNotice,
				noticeReason: r.noticeReason,
				cancellable: r.cancellable,
			});
			const shapeWork = (w: WorkToDecide): WorkItemToDecide => ({
				id: w.id,
				person: w.person.name,
				kind: w.kind,
				label: WORK_KIND_LABELS[w.kind],
				days: workDaysLabel(w),
				hours: minutesLabel(w.minutesPerDay),
				reason: w.reason,
				cancellable: w.cancellable,
			});
			requests = {
				pending: listed.pending.map(shape),
				upcoming: listed.upcoming.map(shape),
				work: {
					pending: workListed.pending.map(shapeWork),
					upcoming: workListed.upcoming.map(shapeWork),
				},
			};
		}
	}

	return {
		show,
		decides,
		waiting,
		year,
		today,
		kinds: requestableKinds(mine.kinds).map((kind) => ({
			id: kind.id,
			name: kind.name,
			key: kind.key,
			noticeDays: noticeAsked(kind),
			earliest: earliestNoticed(kind, today),
		})),
		shortNotice: rules.shortNotice,
		workRules: { overtime: rules.overtime, weekend: rules.weekend },
		balances: mine.balances.map(({ kind, balance }) => ({
			id: kind.id,
			name: kind.name,
			allowance: balance.allowance === null ? null : halfDaysLabel(balance.allowance),
			approved: halfDaysLabel(balance.approved),
			pending: balance.pending > 0 ? halfDaysLabel(balance.pending) : null,
			left: balance.left === null ? null : halfDaysLabel(balance.left),
		})),
		requests: mine.requests.map((r) => ({
			id: r.id,
			kind: r.kindName,
			days: spanLabel(r),
			takes: halfDaysLabel(halfDaysTaken(r, calendar)),
			status: r.status,
			statusLabel: LEAVE_STATUS_LABELS[r.status],
			note: r.note,
			comment: r.comment,
		})),
		work: work.map(
			(w): MyWorkItem => ({
				id: w.id,
				kind: w.kind,
				label: WORK_KIND_LABELS[w.kind],
				days: workDaysLabel(w),
				hours: minutesLabel(w.minutesPerDay),
				status: w.status,
				statusLabel: LEAVE_STATUS_LABELS[w.status],
				reason: w.reason,
				comment: w.comment,
			}),
		),
		teamLeave: teamLeave.map((l) => ({
			id: l.id,
			person: l.person,
			kind: l.kind,
			days: spanLabel(l),
		})),
		/** How far ahead the team's leave is listed, in weeks. */
		teamLeaveWeeks: TEAM_LEAVE_AHEAD_DAYS / 7,
		holidays: holidayKind?.enabled === false ? [] : holidays.slice(0, 12),
		decisions: requests,
		/** Whether nobody but the person may decide their leave, so what needs approval is approved as it is sent. */
		alone: !decidedByOthers,
		zone,
	};
}

const Id = z.string().min(1).max(64);
const Text = z.string().trim().max(LEAVE_TEXT_MAX_LENGTH);
/** A checkbox sends its value only while it is ticked. */
const Ticked = z
	.literal("on")
	.optional()
	.transform((value) => value === "on");

const form = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("request"),
		kindId: Id,
		startsOn: Day,
		endsOn: Day,
		startsHalf: Ticked,
		endsHalf: Ticked,
		note: Text.optional(),
		noticeReason: z.string().trim().max(NOTICE_REASON_MAX_LENGTH).optional(),
	}),
	z.object({ intent: z.literal("withdraw"), requestId: Id }),
	z.object({ intent: z.literal("approve"), requestId: Id, comment: Text.optional() }),
	z.object({ intent: z.literal("refuse"), requestId: Id, comment: Text.optional() }),
	z.object({ intent: z.literal("cancel"), requestId: Id, comment: z.string() }),
	z.object({
		intent: z.literal("request-work"),
		kind: WorkKind,
		startsOn: Day,
		endsOn: Day,
		hours: TypedHours,
		reason: Text.optional(),
	}),
	z.object({ intent: z.literal("withdraw-work"), requestId: Id }),
	z.object({ intent: z.literal("approve-work"), requestId: Id, comment: Text.optional() }),
	z.object({ intent: z.literal("refuse-work"), requestId: Id, comment: Text.optional() }),
	z.object({ intent: z.literal("cancel-work"), requestId: Id, comment: z.string() }),
]);

const STEPPED: Record<Exclude<Stepped, "done">, [string, number]> = {
	missing: ["That request is no longer there.", 404],
	"not-allowed": [NOT_ALLOWED, 403],
	stale: ["That request has changed since this page was opened. Look at it again.", 409],
};

function outcome(result: Stepped, said: string) {
	if (result === "done") return done(said);
	const [problem, status] = STEPPED[result];
	return declined(problem, status);
}

/** What a step on a request for work came to, saying it of the request's kind: "Overtime approved." */
async function workOutcome(
	scope: OrganisationScope,
	requestId: string,
	result: Stepped,
	happened: string,
) {
	if (result !== "done") return outcome(result, "");
	const [row] = await scope.workRequests.select((w) => eq(w.id, requestId), { limit: 1 });
	const kind = WorkKind.safeParse(row?.kind);
	return done(`${kind.success ? WORK_KIND_LABELS[kind.data] : "Request"} ${happened}.`);
}

/** Why a cancellation is refused before it is tried, or null when its reason will do. */
function badReason(reason: string): string | null {
	return reason.length === 0 || reason.length > LEAVE_TEXT_MAX_LENGTH
		? `Say why, in 1 to ${LEAVE_TEXT_MAX_LENGTH} characters.`
		: null;
}

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const access = await accessOf(membership);
	/** The person's own today, as their approvers' pages count it. */
	const todayOfPerson = async (userId: string) => {
		const people = await leaveDecidablePeople(scope, membership.organisation, access);
		return dayOf(Date.now(), people.find((p) => p.id === userId)?.timeZone ?? "UTC");
	};

	switch (input.intent) {
		case "request": {
			const [zone, rules] = await Promise.all([
				zoneOfMember(membership),
				timesheetRulesOf(membership.organisation.id),
			]);
			const made = await requestLeave(
				scope,
				membership.user.id,
				{
					kindId: input.kindId,
					startsOn: input.startsOn,
					endsOn: input.endsOn,
					startsHalf: input.startsHalf,
					endsHalf: input.endsHalf,
					note: input.note || null,
					noticeReason: input.noticeReason || null,
				},
				{ today: dayOf(Date.now(), zone), shortNotice: rules.shortNotice },
			);
			if (!made.ok) return declined(made.problem.message);
			return done(
				made.alone
					? "Approved automatically: nobody else can decide it."
					: made.status === "approved"
						? "Recorded. It needs nobody's approval."
						: "Requested. It waits for a manager's approval.",
			);
		}
		case "withdraw":
			return outcome(await withdrawLeave(scope, access, input.requestId), "Request withdrawn.");
		case "approve":
		case "refuse":
			return outcome(
				await decideLeave(scope, access, input.requestId, {
					action: input.intent === "approve" ? "approved" : "refused",
					comment: input.comment || null,
				}),
				input.intent === "approve" ? "Leave approved." : "Leave refused.",
			);
		case "cancel": {
			const reason = input.comment.trim();
			const bad = badReason(reason);
			if (bad) return declined(bad);
			return outcome(
				await cancelLeave(scope, access, input.requestId, reason, todayOfPerson),
				"Leave cancelled.",
			);
		}
		case "request-work": {
			const made = await requestWork(
				scope,
				membership.user.id,
				{
					kind: input.kind,
					startsOn: input.startsOn,
					endsOn: input.endsOn,
					minutesPerDay: input.hours,
					reason: input.reason || null,
				},
				await timesheetRulesOf(membership.organisation.id),
			);
			if (!made.ok) return declined(made.problem.message);
			return done(
				made.alone
					? "Approved automatically: nobody else can decide it."
					: `${WORK_KIND_LABELS[input.kind]} requested. It waits for a manager's approval.`,
			);
		}
		case "withdraw-work":
			return outcome(await withdrawWork(scope, access, input.requestId), "Request withdrawn.");
		case "approve-work":
		case "refuse-work": {
			const approve = input.intent === "approve-work";
			return workOutcome(
				scope,
				input.requestId,
				await decideWork(scope, access, input.requestId, {
					action: approve ? "approved" : "refused",
					comment: input.comment || null,
				}),
				approve ? "approved" : "refused",
			);
		}
		case "cancel-work": {
			const reason = input.comment.trim();
			const bad = badReason(reason);
			if (bad) return declined(bad);
			return workOutcome(
				scope,
				input.requestId,
				await cancelWork(scope, access, input.requestId, reason, todayOfPerson),
				"cancelled",
			);
		}
	}
}

type Loaded = Route.ComponentProps["loaderData"];
type Task = "request" | "request-work" | "withdraw" | "approve" | "refuse" | "cancel";
/** What a task acts on; `work` when it is a request for overtime or weekend work. */
type Target = { id: string; name: string; work?: boolean };
type Open = (task: Task, on: Target | null) => void;

export default function TimeOff({ loaderData }: Route.ComponentProps) {
	const organisation = useOrganisation();
	const { show, decides, waiting } = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [target, setTarget] = useState<Target | null>(null);
	const [workKind, setWorkKind] = useState<WorkKind>("overtime");
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const open: Open = (next, on) => {
		setTarget(on);
		setTask(next);
	};
	const askForWork = (kind: WorkKind) => {
		setWorkKind(kind);
		open("request-work", null);
	};
	const here = destinationPath(organisation.slug, "time-off");
	/** The intent of a step on the target: the leave's own, or its twin for work. */
	const intentOf = (step: "withdraw" | "approve" | "refuse" | "cancel") =>
		target?.work ? `${step}-work` : step;

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				Leave you ask for, and the days off everyone has. Days of leave count working days only.
			</PageLead>
			{decides && (
				<ul
					aria-label="Time off pages"
					className="mt-6 flex max-w-200 border-outline-variant border-b"
				>
					<TabLink to={here} current={show === "mine"}>
						Your time off
					</TabLink>
					<TabLink to={`${here}?${SHOW_PARAM}=requests`} current={show === "requests"}>
						{waiting > 0 ? `Requests (${waiting})` : "Requests"}
					</TabLink>
				</ul>
			)}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			{show === "requests" && loaderData.decisions ? (
				<Requests decisions={loaderData.decisions} open={open} />
			) : (
				<Mine data={loaderData} open={open} askForWork={askForWork} />
			)}

			<FormSheet
				title="Request time off"
				intent="request"
				submitLabel="Request"
				isOpen={task === "request"}
				onClose={close}
				onDone={setSaid}
			>
				<RequestFields
					kinds={loaderData.kinds}
					today={loaderData.today}
					shortNotice={loaderData.shortNotice}
				/>
				{loaderData.alone && (
					<p className="text-body-medium text-on-surface-variant">
						Nobody else here can decide your leave, so leave that needs approval is approved as soon
						as you send it.
					</p>
				)}
			</FormSheet>

			<FormSheet
				title={`Request ${WORK_KIND_LABELS[workKind].toLowerCase()}`}
				intent="request-work"
				submitLabel="Request"
				isOpen={task === "request-work"}
				onClose={close}
				onDone={setSaid}
			>
				<WorkFields kind={workKind} today={loaderData.today} />
				{loaderData.alone && (
					<p className="text-body-medium text-on-surface-variant">
						Nobody else here can decide your requests, so they are approved as soon as you send
						them.
					</p>
				)}
			</FormSheet>

			<FormSheet
				title={`Withdraw your request for ${target?.name ?? "leave"}?`}
				intent={intentOf("withdraw")}
				submitLabel="Withdraw"
				cancelLabel="Keep it"
				isOpen={task === "withdraw"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="requestId" value={target?.id ?? ""} />
				<p>Nobody needs to decide it any more. You can ask again.</p>
			</FormSheet>

			<FormSheet
				title={`Approve ${target?.name ?? "this request"}?`}
				intent={intentOf("approve")}
				submitLabel="Approve"
				isOpen={task === "approve"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="requestId" value={target?.id ?? ""} />
				<TextField
					label="Comment (optional)"
					name="comment"
					maxLength={LEAVE_TEXT_MAX_LENGTH}
					description="They read this with the request."
				/>
			</FormSheet>

			<FormSheet
				title={`Refuse ${target?.name ?? "this request"}?`}
				intent={intentOf("refuse")}
				submitLabel="Refuse"
				isOpen={task === "refuse"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="requestId" value={target?.id ?? ""} />
				<TextField
					label="Comment (optional)"
					name="comment"
					autoFocus
					maxLength={LEAVE_TEXT_MAX_LENGTH}
					description="They read this with the request."
				/>
			</FormSheet>

			<FormSheet
				title={`Cancel ${target?.name ?? "this leave"}`}
				intent={intentOf("cancel")}
				submitLabel={target?.work ? "Cancel it" : "Cancel leave"}
				cancelLabel="Keep it"
				isOpen={task === "cancel"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="requestId" value={target?.id ?? ""} />
				<TextField
					label="Reason"
					name="comment"
					autoFocus
					isRequired
					maxLength={LEAVE_TEXT_MAX_LENGTH}
					description={
						target?.work
							? "They read this with the request. Those days take only their usual hours again."
							: "They read this with the request. The days are theirs to work again."
					}
				/>
			</FormSheet>
		</>
	);
}

function TabLink({ to, current, children }: { to: string; current: boolean; children: string }) {
	return (
		<li className="flex-1">
			<Link
				to={to}
				aria-current={current ? "page" : undefined}
				className={cx(
					"relative flex h-12 items-center justify-center px-2 text-center text-title-small outline-none hover:text-on-surface focus-visible:focus-indicator-inner",
					current ? "text-primary" : "text-on-surface-variant",
				)}
			>
				{children}
				{current && (
					<span
						aria-hidden="true"
						className="absolute inset-x-2 bottom-0 h-0.75 rounded-t-full bg-primary"
					/>
				)}
			</Link>
		</li>
	);
}

function RequestFields({
	kinds,
	today,
	shortNotice,
}: Pick<Loaded, "kinds" | "today" | "shortNotice">) {
	const [kindId, setKindId] = useState<string | null>(kinds[0]?.id ?? null);
	const [startsOn, setStartsOn] = useState(today);
	const [endsOn, setEndsOn] = useState(today);
	const oneDay = startsOn === endsOn || endsOn === "";
	const kind = kinds.find((k) => k.id === kindId);
	const short =
		kind !== undefined && Day.safeParse(startsOn).success && isShortNotice(kind, today, startsOn);
	const given = short ? daysLabel(Math.max(0, noticeGiven(today, startsOn))) : "";
	return (
		<>
			<Select
				label="Kind of leave"
				name="kindId"
				options={kinds.map(({ id, name }) => ({ id, label: name }))}
				value={kindId}
				onChange={setKindId}
				isRequired
			/>
			<div className="grid grid-cols-2 gap-4">
				<TextField
					label="First day"
					name="startsOn"
					type="date"
					value={startsOn}
					onChange={(value) => {
						setStartsOn(value);
						if (endsOn < value) setEndsOn(value);
					}}
					isRequired
				/>
				<TextField
					label="Last day"
					name="endsOn"
					type="date"
					value={endsOn}
					onChange={setEndsOn}
					isRequired
				/>
			</div>
			{/* Said again as the kind or the first day changes, so a screen reader hears it. */}
			<div aria-live="polite" className="flex flex-col gap-1 text-body-medium">
				{kind && (
					<p className="text-on-surface-variant">
						{kind.noticeDays === 0
							? `${kind.name} needs no notice.`
							: `${kind.name} needs ${noticeLabel({ noticeDays: kind.noticeDays, shortNotice: false })}: the earliest well-noticed first day is ${dateWords(kind.earliest)}.`}
					</p>
				)}
				{short &&
					kind &&
					(shortNotice === "refused" ? (
						<p className="text-error">
							This is short notice ({given}), which this organisation does not take, so it cannot be
							sent. Choose {dateWords(kind.earliest)} or later.
						</p>
					) : (
						<p>This is short notice ({given}).</p>
					))}
			</div>
			{short && shortNotice === "with-reason" && (
				<TextField
					label="Why at short notice?"
					name="noticeReason"
					isRequired
					maxLength={NOTICE_REASON_MAX_LENGTH}
					description="One line. Your approver reads it with the request."
				/>
			)}
			<Checkbox name="startsHalf" value="on">
				{oneDay ? "Half a day" : "Half a day on the first day"}
			</Checkbox>
			{!oneDay && (
				<Checkbox name="endsHalf" value="on">
					Half a day on the last day
				</Checkbox>
			)}
			<TextField label="Note (optional)" name="note" maxLength={LEAVE_TEXT_MAX_LENGTH} />
		</>
	);
}

function Mine({
	data,
	open,
	askForWork,
}: {
	data: Loaded;
	open: Open;
	askForWork: (kind: WorkKind) => void;
}) {
	const { balances, requests, holidays, year, kinds, workRules, work, teamLeave } = data;
	const asksOvertime = workRules.overtime === "approval";
	const asksWeekend = workRules.weekend === "approval";
	return (
		<>
			{(kinds.length > 0 || asksOvertime || asksWeekend) && (
				<div className="mt-6 flex flex-wrap gap-2">
					{kinds.length > 0 && (
						<Button onPress={() => open("request", null)}>Request time off</Button>
					)}
					{asksOvertime && (
						<Button variant="outlined" onPress={() => askForWork("overtime")}>
							Request overtime
						</Button>
					)}
					{asksWeekend && (
						<Button variant="outlined" onPress={() => askForWork("weekend")}>
							Request weekend work
						</Button>
					)}
				</div>
			)}
			<Section id="balance" heading={`Your balance, ${year}`} className="max-w-200">
				<Ledger heading="Kinds of leave" note={`${year}`}>
					<LedgerRows label={`Your balance, ${year}`}>
						{balances.map((b) => (
							<LedgerRow
								key={b.id}
								title={b.name}
								detail={
									b.allowance === null
										? `No allowance. Taken: ${b.approved}${b.pending ? `; waiting: ${b.pending}` : ""}.`
										: `${b.allowance} a year. Taken: ${b.approved}${b.pending ? `; waiting: ${b.pending}` : ""}.`
								}
								value={b.left === null ? undefined : `${b.left} left`}
							/>
						))}
					</LedgerRows>
				</Ledger>
			</Section>

			<Section id="requests" heading="Your requests" className="max-w-200">
				{requests.length === 0 ? (
					<EmptySheet heading="Requests">
						You have not asked for any time off yet. What you ask for is listed here.
					</EmptySheet>
				) : (
					<Ledger heading="Requests" note={`${requests.length}`}>
						<LedgerRows label="Your requests">
							{requests.map((r) => (
								<LedgerRow
									key={r.id}
									title={
										<>
											{r.kind} <span className="text-on-surface-variant">· {r.statusLabel}</span>
										</>
									}
									detail={
										<>
											{r.days} · {r.takes}
											{r.note && <span className="block wrap-anywhere">Your note: “{r.note}”</span>}
											{r.comment && <span className="block wrap-anywhere">“{r.comment}”</span>}
										</>
									}
									action={
										r.status === "pending" && (
											<Button
												variant="text"
												aria-label={`Withdraw ${r.kind}, ${r.days}`}
												onPress={() => open("withdraw", { id: r.id, name: r.kind.toLowerCase() })}
											>
												Withdraw
											</Button>
										)
									}
								/>
							))}
						</LedgerRows>
					</Ledger>
				)}
			</Section>

			{(asksOvertime || asksWeekend || work.length > 0) && <MyWork work={work} open={open} />}

			<Section id="team-leave" heading="Your team's upcoming leave" className="max-w-200">
				{teamLeave.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">
						Nobody you work with has leave in the next {data.teamLeaveWeeks} weeks.
					</p>
				) : (
					<Ledger heading={`Next ${data.teamLeaveWeeks} weeks`} note={`${teamLeave.length}`}>
						<LedgerRows label="Your team's upcoming leave">
							{teamLeave.map((l) => (
								<LedgerRow
									key={l.id}
									title={
										<span className="wrap-anywhere">
											{l.person} <span className="text-on-surface-variant">· {l.kind}</span>
										</span>
									}
									detail={l.days}
								/>
							))}
						</LedgerRows>
					</Ledger>
				)}
			</Section>

			<Section id="holidays" heading="Public holidays" className="max-w-200">
				{holidays.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">
						No public holidays are set ahead.
					</p>
				) : (
					<Ledger heading="Coming up">
						<LedgerRows label="Public holidays coming up">
							{holidays.map((h) => (
								<LedgerRow
									key={h.id}
									title={<span className="wrap-anywhere">{h.name}</span>}
									detail={spanLabel({
										startsOn: h.day,
										endsOn: h.day,
										startsHalf: false,
										endsHalf: false,
									})}
								/>
							))}
						</LedgerRows>
					</Ledger>
				)}
			</Section>
		</>
	);
}

type Decisions = NonNullable<Loaded["decisions"]>;
type LeaveToDecide = Decisions["pending"][number];

/** The notice a request gave, marked when it was short, with the reason given for it. */
function Notice({ request }: { request: LeaveToDecide }) {
	return (
		<span className="block">
			{request.shortNotice ? (
				<span className="rounded-extra-small bg-error-container px-1.5 text-label-medium text-on-error-container">
					{request.notice}
				</span>
			) : (
				request.notice
			)}
			{request.noticeReason && (
				<span className="block wrap-anywhere">Why: “{request.noticeReason}”</span>
			)}
		</span>
	);
}

function Requests({ decisions, open }: { decisions: Decisions; open: Open }) {
	const { pending, upcoming, work } = decisions;
	return (
		<>
			<Section id="waiting" heading="Waiting for you" className="max-w-200">
				{pending.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">
						{work.pending.length > 0
							? "No request for leave is waiting for you."
							: "No request is waiting for you."}
					</p>
				) : (
					<Ledger heading="Pending" note={`${pending.length}`}>
						<LedgerRows label="Requests waiting for you">
							{pending.map((r) => {
								const on = { id: r.id, name: `${r.person}'s ${r.kind.toLowerCase()}` };
								return (
									<LedgerRow
										key={r.id}
										title={
											<span className="wrap-anywhere">
												{r.person} <span className="text-on-surface-variant">· {r.kind}</span>
											</span>
										}
										detail={
											<>
												{r.days} · {r.takes}
												<Notice request={r} />
												{r.note && <span className="block wrap-anywhere">“{r.note}”</span>}
											</>
										}
										action={
											<span className="flex gap-1">
												<Button
													variant="text"
													aria-label={`Approve ${on.name}`}
													onPress={() => open("approve", on)}
												>
													Approve
												</Button>
												<Button
													variant="text"
													aria-label={`Refuse ${on.name}`}
													onPress={() => open("refuse", on)}
												>
													Refuse
												</Button>
											</span>
										}
									/>
								);
							})}
						</LedgerRows>
					</Ledger>
				)}
			</Section>

			<Section id="upcoming" heading="Approved, to come" className="max-w-200">
				{upcoming.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">No approved leave is to come.</p>
				) : (
					<Ledger heading="Approved" note={`${upcoming.length}`}>
						<LedgerRows label="Approved leave to come">
							{upcoming.map((r) => {
								const on = { id: r.id, name: `${r.person}'s ${r.kind.toLowerCase()}` };
								return (
									<LedgerRow
										key={r.id}
										title={
											<span className="wrap-anywhere">
												{r.person} <span className="text-on-surface-variant">· {r.kind}</span>
											</span>
										}
										detail={
											<>
												{r.days} · {r.takes}
												<Notice request={r} />
											</>
										}
										action={
											r.cancellable && (
												<Button
													variant="text"
													aria-label={`Cancel ${on.name}`}
													onPress={() => open("cancel", on)}
												>
													Cancel
												</Button>
											)
										}
									/>
								);
							})}
						</LedgerRows>
					</Ledger>
				)}
			</Section>

			<WorkToDecideSection pending={work.pending} upcoming={work.upcoming} open={open} />
		</>
	);
}
