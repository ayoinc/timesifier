import { env } from "cloudflare:workers";
import { useState } from "react";
import { data, Form, Link, redirect } from "react-router";
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
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { nothingExpected } from "~/leave/days";
import { halfDaysLabel, LEAVE_TEXT_MAX_LENGTH } from "~/leave/kinds";
import {
	calendarOf,
	decideLeave,
	leaveContext,
	leaveDecidablePeople,
	requestsToDecide,
} from "~/leave/leave.server";
import { spanLabel } from "~/leave/words";
import { parseRequest } from "~/lib/validate";
import { mayReopenPeriods } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { PERIOD_COMMENT_MAX_LENGTH, periodContaining } from "~/periods/periods";
import { destination, destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { viewedPeriod } from "~/teams/viewed-period.server";
import { timeByProject } from "~/teams/week.server";
import { hours, periodLabel, WEEK_PARAM } from "~/teams/words";
import { Day, dayOf, daysFrom } from "~/time/calendar";
import { formatDayAndTime } from "~/time/format";

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

const { label } = destination("approvals");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** The rest of an address of Approvals that keeps `query`'s view: the values that are not the default. */
function viewSearch(query: ApprovalsQuery): string {
	return [
		query.status === "pending" ? "" : `&status=${query.status}`,
		query.group === "person" ? "" : `&group=${query.group}`,
	].join("");
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
	const query = parseApprovalsQuery(url.searchParams);
	if (!query) throw data("Bad Request", { status: 400 });

	const access = await accessOf(membership);
	const scope = organisationScope(env.DB, organisation.id);
	const people = await decidablePeople(scope, organisation, access);
	const waiting = await pendingPeriods(scope, people);

	// With no week asked for, last week: the one most people have just
	// submitted. It does not follow what is pending, so a decision that empties
	// it leaves the page where it is; other weeks waiting are linked above.
	const now = Date.now();
	const viewed = await viewedPeriod(membership, url, -1, now);
	const leavePeople = await leaveDecidablePeople(scope, organisation, access);
	const [approvals, time, leave, leaveRequests] = await Promise.all([
		approvalsFor(scope, people, viewed.period, viewed.today),
		timeByProject(scope, people, viewed.period, now),
		leaveContext(
			scope,
			people.map((p) => p.id),
			viewed.period.startsOn,
			viewed.period.endsOn,
		),
		requestsToDecide(scope, access, leavePeople, (person) => dayOf(now, person.timeZone)),
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
	const approved = approvals.decided.filter((p) => p.status === "approved");
	const returned = approvals.decided.filter((p) => p.status === "returned");

	// The timesheets in the status asked for, each with the time in it and
	// what can be done with it.
	type Row = {
		id: string;
		person: { id: string; name: string };
		seconds: number;
		detail: string;
		comment: string | null;
		periodId: string | null;
	};
	const row = (
		person: { id: string; name: string },
		detail: string,
		periodId: string | null = null,
		comment: string | null = null,
	): Row => ({
		id: periodId ?? person.id,
		person: { id: person.id, name: person.name },
		seconds: secondsOf(person.id),
		detail,
		comment,
		periodId,
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
		keep: viewSearch(query),
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
		intent: z.enum(["approve-leave", "refuse-leave"]),
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

const LEAVE_DECIDED: Record<Exclude<Decided, "done">, [string, number]> = {
	missing: ["That request is no longer there.", 404],
	"not-allowed": [NOT_ALLOWED, 403],
	stale: ["That request has changed since this page was opened. Look at it again.", 409],
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
	const { query, keep, week, rows, projects, total, counts, canReopen, elsewhere, leaveWaiting } =
		loaderData;
	const [task, setTask] = useState<
		"approve" | "all" | "return" | "reopen" | "approve-leave" | "refuse-leave" | null
	>(null);
	const [target, setTarget] = useState<Target | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const open = (next: NonNullable<typeof task>, on: Target | null) => {
		setTarget(on);
		setTask(next);
	};
	const here = destinationPath(organisation.slug, "approvals");
	const status = STATUS_LABELS[query.status];

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>The timesheets people submit for the week of {week.label}.</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			<p className="mt-6 flex max-w-200 items-center justify-between gap-4 text-body-large">
				<Link to={`${here}?${WEEK_PARAM}=${week.previous}${keep}`} className={TEXT_LINK}>
					← Previous week
				</Link>
				{week.next ? (
					<Link to={`${here}?${WEEK_PARAM}=${week.next}${keep}`} className={TEXT_LINK}>
						Next week →
					</Link>
				) : (
					<span className="text-on-surface-variant">This is the current week</span>
				)}
			</p>
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
													{p.detail}
													{p.comment && <span className="block wrap-anywhere">“{p.comment}”</span>}
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
						<LedgerTotal label="Total" value={total} />
					</Ledger>
				)}
			</div>

			{leaveWaiting.length > 0 && (
				<Section
					id="time-off-waiting"
					heading="Time off waiting"
					lead="Requests for leave waiting for your decision, whatever week they fall in."
					className="max-w-200"
				>
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
				</Section>
			)}

			<FormSheet
				title={`Approve ${target?.name ?? "this request"}?`}
				intent="approve-leave"
				submitLabel="Approve"
				isOpen={task === "approve-leave"}
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
				intent="refuse-leave"
				submitLabel="Refuse"
				isOpen={task === "refuse-leave"}
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

/** The status and the grouping, chosen together; the week shown stays. */
function ViewChoice({ query, counts, week }: Pick<Loaded, "query" | "counts" | "week">) {
	return (
		<Form
			method="get"
			aria-label="Choose timesheets"
			className="mt-8 flex max-w-200 flex-wrap items-end gap-6"
		>
			<input type="hidden" name={WEEK_PARAM} value={week.period.startsOn} />
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
				/>
			</div>
			<div className="min-w-0 flex-1 basis-56">
				<Select
					label="Group by"
					name="group"
					options={APPROVAL_GROUPS.map((id) => ({ id, label: APPROVAL_GROUP_LABELS[id] }))}
					defaultValue={query.group}
				/>
			</div>
			<Button type="submit">Show</Button>
		</Form>
	);
}
