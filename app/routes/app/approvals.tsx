import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { data, Form, Link, redirect, useNavigate } from "react-router";
import * as z from "zod";

import {
	approvalsFor,
	approveAll,
	type Decided,
	decidablePeople,
	decide,
	pendingPeriods,
} from "~/approvals/approvals.server";
import {
	APPROVAL_GROUP_LABELS,
	APPROVAL_GROUPS,
	type ApprovalsQuery,
	byProject,
	parseApprovalsQuery,
	STATUS_LABELS,
	STATUSES,
	withoutTab,
} from "~/approvals/choices";
import { Button } from "~/components/Button";
import { FilterBar, useApplyFilters } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { PeriodStepper } from "~/components/PeriodStepper";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { expenseTotalsOf } from "~/expenses/expenses.server";
import { nothingExpected } from "~/leave/days";
import { halfDaysLabel, LEAVE_TEXT_MAX_LENGTH } from "~/leave/kinds";
import {
	calendarOf,
	decideLeave,
	leaveContext,
	leaveDecidablePeople,
	requestsToDecide,
	type Stepped,
} from "~/leave/leave.server";
import { noticeLabel, WORK_KIND_LABELS } from "~/leave/rules";
import { spanLabel } from "~/leave/words";
import { decideWork, workToDecide } from "~/leave/work.server";
import { parseRequest } from "~/lib/validate";
import { formatMoney, type Money, totalsByCurrency } from "~/money/money";
import { mayReopenPeriods } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { shownName } from "~/organisations/people";
import { NOT_ALLOWED } from "~/organisations/problems";
import { PERIOD_COMMENT_MAX_LENGTH, periodContaining } from "~/periods/periods";
import { destination, destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead, Section } from "~/shell/PageHeading";
import type { Person } from "~/teams/people.server";
import { viewedPeriod } from "~/teams/viewed-period.server";
import { timeByProject } from "~/teams/week.server";
import { hours, periodLabel, WEEK_PARAM } from "~/teams/words";
import { Day, dayOf, daysFrom } from "~/time/calendar";
import { formatDayAndTime, formatDuration, formatRange } from "~/time/format";

import type { Route } from "./+types/approvals";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Approvals (TS-047): the periods people submit, decided one period at a
// time. Owners and admins decide everyone's; a manager decides those of the
// members of the teams they manage, never their own; a member is not shown it
// and gets 404 (app/shell/destinations.ts). A period is approved, alone or
// with every other pending one of the same week, or returned with a comment;
// an owner or admin reopens an approved one with a reason.
//
// The page shows the period's timesheets in one status, `?status=`, grouped by
// person or by project, `?group=`, with the time logged in the period and its
// total (TS-058; app/approvals/choices.ts). The tabs it had before are a
// status now, and their addresses (`?tab=`) are sent to it.
//
// Time off waiting lists the requests for leave the viewer decides, each with
// the notice it gave, and beside them the requests for overtime and weekend
// work, decided the same way (TS-090; app/leave/work.server.ts).

const { label } = destination("approvals");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** The rest of an address of Approvals that keeps `query`'s view: its status always, its grouping when not the default. */
function viewSearch(query: ApprovalsQuery): string {
	return [`&status=${query.status}`, query.group === "person" ? "" : `&group=${query.group}`].join(
		"",
	);
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation } = membership;
	const url = new URL(request.url);
	const moved = withoutTab(url.searchParams);
	if (moved) {
		const search = moved.toString();
		throw redirect(
			`${destinationPath(organisation.slug, "approvals")}${search === "" ? "" : `?${search}`}`,
			301,
		);
	}
	const asked = parseApprovalsQuery(url.searchParams);
	if (!asked) throw data("Bad Request", { status: 400 });
	let query: ApprovalsQuery = asked;

	const access = await accessOf(membership);
	const scope = organisationScope(env.DB, organisation.id);
	const people = await decidablePeople(scope, organisation, access);
	const waiting = await pendingPeriods(scope, people);

	// With no week asked for, the latest week with something pending, else the
	// current one (W13). A decision that empties it adds `?week=` to its
	// address, so the page stays where it is; other weeks waiting are linked above.
	const now = Date.now();
	const opened = new URL(url);
	const latestWaiting = waiting[0];
	if (!url.searchParams.has(WEEK_PARAM) && latestWaiting) {
		opened.searchParams.set(WEEK_PARAM, latestWaiting.startsOn);
	}
	const viewed = await viewedPeriod(membership, opened, 0, now);
	const leavePeople = await leaveDecidablePeople(scope, organisation, access);
	const todayOf = (person: { timeZone: string }) => dayOf(now, person.timeZone);
	const [approvals, time, leave, leaveRequests, work, spent] = await Promise.all([
		approvalsFor(scope, people, viewed.period, viewed.today),
		timeByProject(scope, people, viewed.period, now),
		leaveContext(
			scope,
			people.map((p) => p.id),
			viewed.period.startsOn,
			viewed.period.endsOn,
		),
		requestsToDecide(scope, access, leavePeople, todayOf),
		workToDecide(scope, access, leavePeople, todayOf),
		// Expenses are submitted and decided with the week's time (TS-070).
		expenseTotalsOf(
			scope,
			people.map((p) => p.id),
			viewed.period.startsOn,
			viewed.period.endsOn,
		),
	]);
	// A person whose whole period was leave, public holidays and days not worked
	// had nothing to submit (TS-061).
	const periodDays = daysFrom(viewed.period.startsOn, viewed.period.endsOn);
	const notSubmitted =
		approvals.notSubmitted?.filter(
			(person) => !nothingExpected(calendarOf(leave, person.id), periodDays),
		) ?? null;
	// When a timesheet was submitted or decided, in the form every page uses.
	const date = { format: (instant: number) => formatDayAndTime(instant, viewed.zone) };
	const secondsOf = (personId: string) =>
		time.reduce((sum, each) => (each.userId === personId ? sum + each.seconds : sum), 0);
	// With no status asked for, the first one that has somebody in it (W13).
	if (!url.searchParams.has("status")) {
		const sizes: Record<(typeof STATUSES)[number], number> = {
			pending: approvals.pending.length,
			approved: approvals.decided.filter((p) => p.status === "approved").length,
			returned: approvals.decided.filter((p) => p.status === "returned").length,
			"not-submitted": notSubmitted?.length ?? 0,
		};
		const first = STATUSES.find((status) => sizes[status] > 0);
		if (first) query = { ...query, status: first };
	}
	// The address of the view it opened on: the page puts it in the address
	// bar, so a decision that empties it leaves the page where it is.
	const opensAt =
		url.searchParams.has(WEEK_PARAM) && url.searchParams.has("status")
			? null
			: `${destinationPath(organisation.slug, "approvals")}?${WEEK_PARAM}=${viewed.period.startsOn}${viewSearch(query)}`;
	const approved = approvals.decided.filter((p) => p.status === "approved");
	const returned = approvals.decided.filter((p) => p.status === "returned");

	// The timesheets in the status asked for, each with the time in it and
	// what can be done with it.
	type Row = {
		id: string;
		person: { id: string; name: string; address: string | null };
		seconds: number;
		detail: string;
		comment: string | null;
		periodId: string | null;
		/** What their expenses in the week come to, or null when they have none (TS-070). */
		expenses: string | null;
	};
	const moneyWords = (totals: readonly Money[]) =>
		totals.map((m) => formatMoney(m.amountMinor, m.currency, "en-GB")).join(" + ");
	const expensesOf = (personId: string) => {
		const own = spent.get(personId);
		if (!own) return null;
		const billable = own.billable.length > 0 ? `, ${moneyWords(own.billable)} billable` : "";
		return `Expenses: ${moneyWords(own.total)}${billable}`;
	};
	const row = (
		person: Pick<Person, "id" | "name" | "email" | "address">,
		detail: string,
		periodId: string | null = null,
		comment: string | null = null,
	): Row => ({
		id: periodId ?? person.id,
		// The name, or the start of the address with the whole of it under (harvest-taste item 9).
		person: {
			id: person.id,
			name: person.address ? shownName({ email: person.address }) : person.name,
			address: person.address,
		},
		seconds: secondsOf(person.id),
		detail,
		comment,
		periodId,
		expenses: expensesOf(person.id),
	});
	const decided = (p: (typeof approvals.decided)[number]) =>
		row(
			p.person,
			`${p.status === "approved" ? "Approved" : "Returned"} by ${p.decidedBy}, ${date.format(p.decidedAt)}`,
			p.id,
			p.comment,
		);
	let rows: Row[] | null;
	switch (query.status) {
		case "pending":
			rows = approvals.pending.map((p) =>
				row(p.person, `Submitted ${date.format(p.submittedAt)}`, p.id),
			);
			break;
		case "approved":
			rows = approved.map(decided);
			break;
		case "returned":
			rows = returned.map(decided);
			break;
		case "not-submitted":
			// Null while the period is open: who has not submitted it is known once it has closed.
			rows = notSubmitted?.map((p) => row(p, "Not submitted")) ?? null;
			break;
	}

	return {
		query,
		opensAt,
		week: { label: periodLabel(viewed.period), ...viewed },
		canReopen: mayReopenPeriods(access),
		elsewhere: waiting
			.filter((w) => w.startsOn !== viewed.period.startsOn)
			.map((w) => ({
				startsOn: w.startsOn,
				count: w.count,
				label: periodLabel(periodContaining(w.startsOn, organisation.weekStartsOn)),
			})),
		counts: {
			pending: approvals.pending.length,
			approved: approved.length,
			returned: returned.length,
			"not-submitted": notSubmitted?.length ?? null,
		},
		/** The requests for leave waiting for this person's decision, whatever their days (TS-061). */
		leaveWaiting: leaveRequests.pending.map((r) => ({
			id: r.id,
			person: r.person.name,
			kind: r.kindName,
			days: spanLabel(r),
			takes: halfDaysLabel(r.halfDays),
			note: r.note,
			/** The notice it gave: "Short notice (3 days)" or "14 days' notice" (TS-090). */
			notice: noticeLabel(r),
			shortNotice: r.shortNotice,
			noticeReason: r.noticeReason,
		})),
		/** The requests for overtime and weekend work waiting for this person's decision (TS-090). */
		workWaiting: work.pending.map((w) => ({
			id: w.id,
			person: w.person.name,
			kind: WORK_KIND_LABELS[w.kind],
			days: formatRange(w.startsOn, w.endsOn),
			perDay: `${formatDuration(w.minutesPerDay * 60)} a day`,
			reason: w.reason,
		})),
		rows,
		projects:
			rows !== null && query.group === "project"
				? byProject(
						rows.map((r) => r.person),
						time,
					).map((group) => ({ ...group, hours: hours(group.seconds) }))
				: [],
		total: hours(rows?.reduce((sum, r) => sum + r.seconds, 0) ?? 0),
		expenseTotal: moneyWords(
			totalsByCurrency((rows ?? []).flatMap((r) => spent.get(r.person.id)?.total ?? [])),
		),
	};
}

const Id = z.string().min(1).max(64);
/** A reason: required, on as many lines as it takes, up to the limit. */
const Comment = z.string().trim().min(1).max(PERIOD_COMMENT_MAX_LENGTH);

const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("approve"), periodId: Id }),
	z.object({ intent: z.literal("approve-all"), startsOn: z.string() }),
	z.object({ intent: z.literal("return"), periodId: Id, comment: z.string() }),
	z.object({ intent: z.literal("reopen"), periodId: Id, comment: z.string() }),
	z.object({
		intent: z.enum(["approve-leave", "refuse-leave", "approve-work", "refuse-work"]),
		requestId: Id,
		comment: z.string().trim().max(LEAVE_TEXT_MAX_LENGTH).optional(),
	}),
]);

const COMMENT_PROBLEM = `Say why, in 1 to ${PERIOD_COMMENT_MAX_LENGTH} characters.`;

const DECIDED: Record<Exclude<Decided, "done">, [string, number]> = {
	missing: ["That timesheet is no longer there.", 404],
	"not-allowed": [NOT_ALLOWED, 403],
	stale: ["That timesheet has changed since this page was opened. Look at it again.", 409],
};

function outcome(result: Decided, said: string) {
	if (result === "done") return done(said);
	const [problem, status] = DECIDED[result];
	return declined(problem, status);
}

const LEAVE_DECIDED: Record<Exclude<Stepped, "done">, [string, number]> = {
	missing: ["That request is no longer there.", 404],
	"not-allowed": [NOT_ALLOWED, 403],
	stale: ["That request has changed since this page was opened. Look at it again.", 409],
	locked: ["Those days are on or before the lock date, so the request can no longer change.", 409],
};

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	const access = await accessOf(membership);
	const scope = organisationScope(env.DB, membership.organisation.id);

	switch (input.intent) {
		case "approve-leave":
		case "refuse-leave": {
			const result = await decideLeave(scope, access, input.requestId, {
				action: input.intent === "approve-leave" ? "approved" : "refused",
				comment: input.comment || null,
			});
			if (result === "done") {
				return done(input.intent === "approve-leave" ? "Leave approved." : "Leave refused.");
			}
			const [problem, status] = LEAVE_DECIDED[result];
			return declined(problem, status);
		}
		case "approve-work":
		case "refuse-work": {
			const result = await decideWork(scope, access, input.requestId, {
				action: input.intent === "approve-work" ? "approved" : "refused",
				comment: input.comment || null,
			});
			if (result === "done") {
				return done(input.intent === "approve-work" ? "Request approved." : "Request refused.");
			}
			const [problem, status] = LEAVE_DECIDED[result];
			return declined(problem, status);
		}
		case "approve":
			return outcome(
				await decide(scope, access, input.periodId, { action: "approved" }),
				"Timesheet approved.",
			);
		case "approve-all": {
			const startsOn = Day.safeParse(input.startsOn);
			if (!startsOn.success) return declined("That week is not one this page knows.");
			const people = await decidablePeople(scope, membership.organisation, access);
			const count = await approveAll(scope, access, people, startsOn.data);
			return done(
				count === 0
					? "Nothing was waiting."
					: `${count} ${count === 1 ? "timesheet" : "timesheets"} approved.`,
			);
		}
		case "return":
		case "reopen": {
			const comment = Comment.safeParse(input.comment);
			if (!comment.success) return declined(COMMENT_PROBLEM);
			return input.intent === "return"
				? outcome(
						await decide(scope, access, input.periodId, {
							action: "returned",
							comment: comment.data,
						}),
						"Timesheet returned. They can change it and submit it again.",
					)
				: outcome(
						await decide(scope, access, input.periodId, {
							action: "reopened",
							comment: comment.data,
						}),
						"Timesheet reopened. It is back with them to change.",
					);
		}
	}
}

type Loaded = Route.ComponentProps["loaderData"];
type Target = { id: string; name: string };

/** What a status with nothing in it says, for the week shown. */
const NOTHING: Record<(typeof STATUSES)[number], string> = {
	pending: "Nothing is waiting for you this week.",
	approved: "Nothing has been approved for this week.",
	returned: "Nothing has been returned for this week.",
	"not-submitted": "Everyone has submitted this week.",
};

export default function Approvals({ loaderData }: Route.ComponentProps) {
	const organisation = useOrganisation();
	const {
		query,
		opensAt,
		week,
		rows,
		projects,
		total,
		counts,
		canReopen,
		elsewhere,
		leaveWaiting,
		workWaiting,
	} = loaderData;
	const navigate = useNavigate();
	// The week and status it opened on go into the address (W13).
	useEffect(() => {
		if (opensAt) navigate(opensAt, { replace: true, preventScrollReset: true });
	}, [opensAt, navigate]);
	const [task, setTask] = useState<
		| "approve"
		| "all"
		| "return"
		| "reopen"
		| "approve-leave"
		| "refuse-leave"
		| "approve-work"
		| "refuse-work"
		| null
	>(null);
	const [target, setTarget] = useState<Target | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const open = (next: NonNullable<typeof task>, on: Target | null) => {
		setTarget(on);
		setTask(next);
	};
	const here = destinationPath(organisation.slug, "approvals");
	const grouped = query.group === "person" ? "" : `&group=${query.group}`;
	const status = STATUS_LABELS[query.status];

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>The timesheets people submit, a week at a time.</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			{/* Another week opens on its own first status with somebody in it (W13). */}
			<div className="mt-6 max-w-200">
				<PeriodStepper
					label="Weeks"
					period={week.label}
					previous={{
						to: `${here}?${WEEK_PARAM}=${week.previous}${grouped}`,
						label: "Previous week",
					}}
					next={
						week.next
							? { to: `${here}?${WEEK_PARAM}=${week.next}${grouped}`, label: "Next week" }
							: null
					}
					current={
						week.next
							? {
									to: `${here}?${WEEK_PARAM}=${week.current.startsOn}${grouped}`,
									label: "This week",
								}
							: undefined
					}
				/>
			</div>
			{elsewhere.length > 0 && (
				<p className="mt-4 max-w-200 text-body-medium text-on-surface-variant">
					Also waiting:{" "}
					{elsewhere.map((w, index) => (
						<span key={w.startsOn}>
							{index > 0 && ", "}
							<Link
								to={`${here}?${WEEK_PARAM}=${w.startsOn}${query.group === "person" ? "" : `&group=${query.group}`}`}
								className={TEXT_LINK}
							>
								{w.label}
							</Link>{" "}
							({w.count})
						</span>
					))}
					.
				</p>
			)}

			<ViewChoice key={`${query.status} ${query.group}`} {...loaderData} />

			<div className="mt-6 max-w-200">
				{query.status === "pending" && counts.pending > 1 && (
					<div className="mb-4">
						<Button onPress={() => open("all", null)}>Approve all {counts.pending}</Button>
					</div>
				)}
				{rows === null ? (
					<EmptySheet heading={status}>
						This week has not ended yet. Who has not submitted it is listed once it has.
					</EmptySheet>
				) : rows.length === 0 ? (
					<EmptySheet heading={status}>{NOTHING[query.status]}</EmptySheet>
				) : (
					<Ledger heading={status} note={`By ${query.group}`}>
						{query.group === "person" ? (
							<LedgerRows label={`${status}, by person`}>
								{rows.map((p) => {
									const on = { id: p.periodId ?? "", name: `${p.person.name}'s` };
									return (
										<LedgerRow
											key={p.id}
											title={
												<Link
													to={`${destinationPath(organisation.slug, "team")}?${WEEK_PARAM}=${week.period.startsOn}&person=${p.person.id}`}
													className={`${TEXT_LINK} wrap-anywhere`}
												>
													{p.person.name}
												</Link>
											}
											detail={
												<>
													{p.person.address && (
														<span className="block wrap-anywhere">{p.person.address}</span>
													)}
													{p.detail}
													{p.comment && <span className="block wrap-anywhere">“{p.comment}”</span>}
													{p.expenses && (
														<span className="block">
															<Link
																to={`${destinationPath(organisation.slug, "expenses")}?${WEEK_PARAM}=${week.period.startsOn}&person=${p.person.id}`}
																className={TEXT_LINK}
															>
																{p.expenses}
															</Link>
														</span>
													)}
												</>
											}
											value={hours(p.seconds)}
											action={
												query.status === "pending" ? (
													<span className="flex gap-1">
														<Button
															variant="text"
															aria-label={`Approve ${p.person.name}'s timesheet`}
															onPress={() => open("approve", on)}
														>
															Approve
														</Button>
														<Button
															variant="text"
															aria-label={`Return ${p.person.name}'s timesheet`}
															onPress={() => open("return", on)}
														>
															Return
														</Button>
													</span>
												) : (
													canReopen &&
													query.status === "approved" && (
														<Button
															variant="text"
															aria-label={`Reopen ${p.person.name}'s timesheet`}
															onPress={() => open("reopen", on)}
														>
															Reopen
														</Button>
													)
												)
											}
										/>
									);
								})}
							</LedgerRows>
						) : projects.length > 0 ? (
							<LedgerRows label={`${status}, by project`}>
								{projects.map((project) => (
									<LedgerRow
										key={project.id}
										title={<span className="wrap-anywhere">{project.name}</span>}
										detail={<span className="wrap-anywhere">{project.people.join(", ")}</span>}
										value={project.hours}
									/>
								))}
							</LedgerRows>
						) : (
							<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
								No time was logged on any project in these timesheets.
							</p>
						)}
						{loaderData.expenseTotal && (
							<LedgerTotal label="Expenses" value={loaderData.expenseTotal} />
						)}
						<LedgerTotal label="Total" value={total} />
					</Ledger>
				)}
			</div>

			{(leaveWaiting.length > 0 || workWaiting.length > 0) && (
				<Section
					id="time-off-waiting"
					heading="Time off waiting"
					lead="Requests for leave, overtime and weekend work waiting for your decision, whatever week they fall in."
					className="max-w-200"
				>
					{leaveWaiting.length > 0 && (
						<Ledger heading="Time off" note={`${leaveWaiting.length}`}>
							<LedgerRows label="Time off waiting for you">
								{leaveWaiting.map((r) => {
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
													<span
														className={`block wrap-anywhere${r.shortNotice ? " text-tertiary" : ""}`}
													>
														{r.noticeReason ? `${r.notice}: “${r.noticeReason}”` : r.notice}
													</span>
													{r.note && <span className="block wrap-anywhere">“{r.note}”</span>}
												</>
											}
											action={
												<span className="flex gap-1">
													<Button
														variant="text"
														aria-label={`Approve ${on.name}`}
														onPress={() => open("approve-leave", on)}
													>
														Approve
													</Button>
													<Button
														variant="text"
														aria-label={`Refuse ${on.name}`}
														onPress={() => open("refuse-leave", on)}
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
					{workWaiting.length > 0 && (
						<div className="mt-6 first:mt-0">
							<Ledger heading="Overtime and weekend work" note={`${workWaiting.length}`}>
								<LedgerRows label="Overtime and weekend work waiting for you">
									{workWaiting.map((w) => {
										const on = { id: w.id, name: `${w.person}'s ${w.kind.toLowerCase()}` };
										return (
											<LedgerRow
												key={w.id}
												title={
													<span className="wrap-anywhere">
														{w.person} <span className="text-on-surface-variant">· {w.kind}</span>
													</span>
												}
												detail={
													<>
														{w.days} · {w.perDay}
														{w.reason && <span className="block wrap-anywhere">“{w.reason}”</span>}
													</>
												}
												action={
													<span className="flex gap-1">
														<Button
															variant="text"
															aria-label={`Approve ${on.name}`}
															onPress={() => open("approve-work", on)}
														>
															Approve
														</Button>
														<Button
															variant="text"
															aria-label={`Refuse ${on.name}`}
															onPress={() => open("refuse-work", on)}
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
						</div>
					)}
				</Section>
			)}

			<FormSheet
				title={`Approve ${target?.name ?? "this request"}?`}
				intent={task === "approve-work" ? "approve-work" : "approve-leave"}
				submitLabel="Approve"
				isOpen={task === "approve-leave" || task === "approve-work"}
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
				intent={task === "refuse-work" ? "refuse-work" : "refuse-leave"}
				submitLabel="Refuse"
				isOpen={task === "refuse-leave" || task === "refuse-work"}
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
				title={`Approve ${target?.name ?? "this"} timesheet?`}
				intent="approve"
				submitLabel="Approve"
				isOpen={task === "approve"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="periodId" value={target?.id ?? ""} />
				<p>Its entries stay locked. An owner or admin can reopen it if it needs changing.</p>
			</FormSheet>

			<FormSheet
				title={`Approve all ${counts.pending} pending?`}
				intent="approve-all"
				submitLabel="Approve all"
				isOpen={task === "all"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="startsOn" value={week.period.startsOn} />
				<p>Every timesheet waiting for the week of {week.label} is approved at once.</p>
			</FormSheet>

			<FormSheet
				title={`Return ${target?.name ?? "this"} timesheet`}
				intent="return"
				submitLabel="Return"
				isOpen={task === "return"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="periodId" value={target?.id ?? ""} />
				<TextField
					label="What needs changing"
					name="comment"
					autoFocus
					isRequired
					maxLength={PERIOD_COMMENT_MAX_LENGTH}
					description="They read this with the timesheet."
				/>
			</FormSheet>

			<FormSheet
				title={`Reopen ${target?.name ?? "this"} timesheet`}
				intent="reopen"
				submitLabel="Reopen"
				isOpen={task === "reopen"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="periodId" value={target?.id ?? ""} />
				<TextField
					label="Reason"
					name="comment"
					autoFocus
					isRequired
					maxLength={PERIOD_COMMENT_MAX_LENGTH}
					description="It goes back to them to change and submit again."
				/>
			</FormSheet>
		</>
	);
}

/** The status and the grouping, applied as each is chosen (W28); the week shown stays. */
function ViewChoice({ query, counts, week }: Pick<Loaded, "query" | "counts" | "week">) {
	return (
		<div className="mt-8 max-w-200">
			<FilterBar name="Choose timesheets" keep={{ [WEEK_PARAM]: week.period.startsOn }}>
				<ViewFields query={query} counts={counts} />
			</FilterBar>
		</div>
	);
}

function ViewFields({ query, counts }: Pick<Loaded, "query" | "counts">) {
	const apply = useApplyFilters();
	// The hidden selects hold the new value once React has drawn it.
	const applySoon = () => setTimeout(apply, 0);
	return (
		<>
			<div className="min-w-0 flex-1 basis-56">
				<Select
					label="Status"
					name="status"
					options={STATUSES.map((id) => {
						const count = counts[id];
						return {
							id,
							label: count === null ? STATUS_LABELS[id] : `${STATUS_LABELS[id]} (${count})`,
						};
					})}
					defaultValue={query.status}
					onChange={applySoon}
				/>
			</div>
			<div className="min-w-0 flex-1 basis-56">
				<Select
					label="Group by"
					name="group"
					options={APPROVAL_GROUPS.map((id) => ({ id, label: APPROVAL_GROUP_LABELS[id] }))}
					defaultValue={query.group}
					onChange={applySoon}
				/>
			</div>
		</>
	);
}
