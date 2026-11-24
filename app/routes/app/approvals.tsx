import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { data, Link, redirect, useNavigate } from "react-router";
import * as z from "zod";

import {
	type ApprovedAll,
	approvalsFor,
	approveAll,
	type DecisionOutcome,
	decidablePeople,
	decide,
	managersAwayOf,
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
import { namesOf, refusersNamed, refusersOfAll } from "~/approvals/refusals.server";
import {
	managersAwaySentence,
	notSubmittedSentence,
	refusedBeforeSentence,
} from "~/approvals/words";
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
	type LeaveContext,
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
import { notify } from "~/notifications/notify.server";
import { submitAsked } from "~/notifications/words";
import {
	type Access,
	isAdministrator,
	mayApproveAfterRefusals,
	mayReopenPeriods,
} from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { type Membership, membershipContext } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { nameOrEmail, shownName } from "~/organisations/people";
import { NOT_ALLOWED } from "~/organisations/problems";
import { PERIOD_COMMENT_MAX_LENGTH, periodContaining } from "~/periods/periods";
import { destination, destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead, Section } from "~/shell/PageHeading";
import type { Person } from "~/teams/people.server";
import { viewedPeriod } from "~/teams/viewed-period.server";
import { timeByProject } from "~/teams/week.server";
import { hours, periodLabel, regularAndOvertime, WEEK_PARAM } from "~/teams/words";
import { Day, dayOf, daysFrom } from "~/time/calendar";
import { formatDay, formatDayAndTime, formatDuration, formatRange } from "~/time/format";

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
// status now, and their addresses (`?tab=`) are sent to it. Time that is
// overtime is shown apart from regular time under each figure, "7:30 + 1:00
// overtime", so it is seen before it is approved (TS-095).
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
	// What waits on managers who are on leave today waits on owners and admins,
	// and they are told so (D6, decision 48).
	const away = isAdministrator(access.role)
		? await managersAwayOf(
				scope,
				[
					...approvals.pending.map((p) => p.person.id),
					...leaveRequests.pending.map((r) => r.person.id),
					...work.pending.map((w) => w.person.id),
				],
				organisation,
				now,
			)
		: new Map<string, string[]>();
	const awayNote = (personId: string) => {
		const managers = away.get(personId);
		return managers ? managersAwaySentence(managers) : null;
	};
	// A request someone else refused before, this person may not approve, and is told why (D5, decision 47).
	const [leaveRefused, workRefused] = await Promise.all([
		refusersOfAll(scope, "leave", leaveRequests.pending),
		refusersOfAll(scope, "work", work.pending),
	]);
	const refusers = await namesOf([...leaveRefused.values(), ...workRefused.values()].flat());
	const refusedNote = (by: readonly string[] | undefined) =>
		by && !mayApproveAfterRefusals(access, by)
			? refusedBeforeSentence(by.map((id) => refusers.get(id) ?? ""))
			: null;
	const notSubmitted = stillToSubmit(approvals.notSubmitted, leave, viewed.period);
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
		/** Of `seconds`, those of overtime (TS-095), so an approver sees it before approving. */
		overtimeSeconds: number;
		detail: string;
		comment: string | null;
		periodId: string | null;
		/** What their expenses in the week come to, or null when they have none (TS-070). */
		expenses: string | null;
		/** What Submit would have refused, "Over by 7:30 on Tue 10"; null when no day is over (TR-01). */
		overLimit: string | null;
		/** Why it waits for an owner or admin, when its managers are on leave (D6). */
		waits: string | null;
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
		overLimit: string | null = null,
	): Row => ({
		id: periodId ?? person.id,
		// The name, or the start of the address with the whole of it under (harvest-taste item 9).
		person: {
			id: person.id,
			name: person.address ? shownName({ email: person.address }) : person.name,
			address: person.address,
		},
		seconds: secondsOf(person.id),
		overtimeSeconds: time.reduce(
			(sum, each) => (each.userId === person.id ? sum + each.overtimeSeconds : sum),
			0,
		),
		detail,
		comment,
		periodId,
		expenses: expensesOf(person.id),
		overLimit,
		waits: periodId !== null && query.status === "pending" ? awayNote(person.id) : null,
	});
	const decided = (p: (typeof approvals.decided)[number]) =>
		row(
			p.person,
			`${p.status === "approved" ? "Approved" : "Returned"} by ${p.decidedBy || "the system"}, ${date.format(p.decidedAt)}`,
			p.id,
			p.comment,
		);
	let rows: Row[] | null;
	switch (query.status) {
		case "pending":
			rows = approvals.pending.map((p) =>
				row(
					p.person,
					`Submitted ${p.bySystem ? "by the system, " : ""}${date.format(p.submittedAt)}`,
					p.id,
					null,
					p.overLimit,
				),
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
	const totalSeconds = rows?.reduce((sum, r) => sum + r.seconds, 0) ?? 0;

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
		/**
		 * The names of those counted in Not submitted, the people the viewer
		 * decides, which the empty Pending says (TS-122, S2-12). Null while the
		 * week is open: who has not submitted it is known once it has closed.
		 */
		notSubmitted:
			notSubmitted?.map((p) => (p.address ? shownName({ email: p.address }) : p.name)) ?? null,
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
			/** Why it waits on someone else, or on owners and admins (D5, D6). */
			waits: refusedNote(leaveRefused.get(r.id)) ?? awayNote(r.person.id),
			/** The time on its days leave cannot share: "7:30 tracked on Tue 10" (TR-04). */
			inTheWay: r.inTheWay,
		})),
		/** The requests for overtime and weekend work waiting for this person's decision (TS-090). */
		workWaiting: work.pending.map((w) => ({
			id: w.id,
			person: w.person.name,
			kind: WORK_KIND_LABELS[w.kind],
			days: formatRange(w.startsOn, w.endsOn),
			perDay: `${formatDuration(w.minutesPerDay * 60)} a day`,
			reason: w.reason,
			/** Why it waits on someone else, or on owners and admins (D5, D6). */
			waits: refusedNote(workRefused.get(w.id)) ?? awayNote(w.person.id),
		})),
		rows:
			rows?.map((r) => ({ ...r, split: regularAndOvertime(r.seconds, r.overtimeSeconds) })) ?? null,
		projects:
			rows !== null && query.group === "project"
				? byProject(
						rows.map((r) => r.person),
						time,
					).map((group) => ({
						...group,
						hours: hours(group.seconds),
						split: regularAndOvertime(group.seconds, group.overtimeSeconds),
					}))
				: [],
		total: hours(totalSeconds),
		/** "7:30 + 1:00 overtime" under the total; null when none of it is overtime (TS-095). */
		totalSplit: regularAndOvertime(
			totalSeconds,
			rows?.reduce((sum, r) => sum + r.overtimeSeconds, 0) ?? 0,
		),
		expenseTotal: moneyWords(
			totalsByCurrency((rows ?? []).flatMap((r) => spent.get(r.person.id)?.total ?? [])),
		),
	};
}

/**
 * Of those who have not submitted `period`, the ones with something to
 * submit: a person whose whole period was leave, public holidays and days not
 * worked had nothing to submit (TS-061). Null while the period is open.
 */
function stillToSubmit(
	notSubmitted: Person[] | null,
	leave: LeaveContext,
	period: { startsOn: Day; endsOn: Day },
): Person[] | null {
	const days = daysFrom(period.startsOn, period.endsOn);
	return (
		notSubmitted?.filter((person) => !nothingExpected(calendarOf(leave, person.id), days)) ?? null
	);
}

/**
 * Asks `personId`, or everyone Not submitted lists, to submit the week that
 * starts on `startsOn` (TS-049): those the asker decides for, as the list
 * shows them, once a day for each week (`submitAsked`).
 */
async function remindToSubmit(
	request: Request,
	membership: Membership,
	access: Access,
	startsOn: string,
	personId: string | null,
) {
	const day = Day.safeParse(startsOn);
	if (!day.success) return declined("That week is not one this page knows.");
	const scope = organisationScope(env.DB, membership.organisation.id);
	const url = new URL(request.url);
	url.searchParams.set(WEEK_PARAM, day.data);
	const now = Date.now();
	const viewed = await viewedPeriod(membership, url, 0, now);
	const people = await decidablePeople(scope, membership.organisation, access);
	const ids = people.map((p) => p.id);
	const [approvals, leave] = await Promise.all([
		approvalsFor(scope, people, viewed.period, viewed.today),
		leaveContext(scope, ids, viewed.period.startsOn, viewed.period.endsOn),
	]);
	const listed = stillToSubmit(approvals.notSubmitted, leave, viewed.period);
	if (listed === null) {
		return declined("This week has not ended yet, so nobody is asked to submit it.", 409);
	}
	const asked = personId === null ? listed : listed.filter((p) => p.id === personId);
	if (asked.length === 0) {
		return declined(
			personId === null
				? "Everyone has submitted this week."
				: "They have submitted this week, or it is not yours to ask for.",
			409,
		);
	}
	const by = nameOrEmail(membership.user);
	await notify(
		scope,
		asked.map((p) => submitAsked({ userId: p.id, ...viewed.period }, by, viewed.today)),
	);
	const [one] = asked;
	return done(
		asked.length === 1 && one
			? `${one.name} is asked to submit the week of ${periodLabel(viewed.period)}.`
			: `${asked.length} people are asked to submit the week of ${periodLabel(viewed.period)}.`,
	);
}

const Id = z.string().min(1).max(64);
/** A reason: required, on as many lines as it takes, up to the limit. */
const Comment = z.string().trim().min(1).max(PERIOD_COMMENT_MAX_LENGTH);

const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("approve"), periodId: Id, overLimit: z.literal("on").optional() }),
	z.object({ intent: z.literal("approve-all"), startsOn: z.string() }),
	z.object({ intent: z.literal("return"), periodId: Id, comment: z.string() }),
	z.object({ intent: z.literal("reopen"), periodId: Id, comment: z.string() }),
	z.object({
		intent: z.enum(["approve-leave", "refuse-leave", "approve-work", "refuse-work"]),
		requestId: Id,
		comment: z.string().trim().max(LEAVE_TEXT_MAX_LENGTH).optional(),
	}),
	z.object({ intent: z.literal("remind"), startsOn: z.string(), personId: Id }),
	z.object({ intent: z.literal("remind-all"), startsOn: z.string() }),
]);

const COMMENT_PROBLEM = `Say why, in 1 to ${PERIOD_COMMENT_MAX_LENGTH} characters.`;

function outcome({ result, overLimit, lockedThrough }: DecisionOutcome, said: string) {
	switch (result) {
		case "done":
			return done(said);
		case "missing":
			return declined("That timesheet is no longer there.", 404);
		case "not-allowed":
			return declined(NOT_ALLOWED, 403);
		case "stale":
			return declined(
				"That timesheet has changed since this page was opened. Look at it again.",
				409,
			);
		case "running":
			return declined(
				"A timer of theirs is running in this week. It can be approved once the timer has stopped.",
				409,
			);
		case "over":
			return declined(
				`${overLimit}. Approve it over its limit only if that is what should be paid.`,
				409,
			);
		case "locked":
			return declined(
				`This week is on or before the lock date${lockedThrough ? `, ${formatDay(lockedThrough)}` : ""}. Move the lock date back first, or approve it as it is.`,
				409,
			);
	}
}

/** What Approve all says it did, and what it left and why (TR-01, TR-02). */
function approvedAllSaid({ approved, over, running }: ApprovedAll): string {
	if (approved + over + running === 0) return "Nothing was waiting.";
	const said = [
		approved === 0
			? "No timesheet approved."
			: `${approved} ${approved === 1 ? "timesheet" : "timesheets"} approved.`,
	];
	if (over > 0) {
		said.push(
			`${over} ${over === 1 ? "was left: it has" : "were left: each has"} a day over its limit.`,
		);
	}
	if (running > 0) {
		said.push(
			`${running} ${running === 1 ? "was left: a timer is still running in it" : "were left: a timer is still running in each"}.`,
		);
	}
	return said.join(" ");
}

const LEAVE_DECIDED: Record<Exclude<Stepped, "done">, [string, number]> = {
	missing: ["That request is no longer there.", 404],
	"not-allowed": [NOT_ALLOWED, 403],
	stale: ["That request has changed since this page was opened. Look at it again.", 409],
	locked: ["Those days are on or before the lock date, so the request can no longer change.", 409],
	"refused-before": ["", 403],
	begun: ["That leave has begun, so it can no longer be cancelled.", 409],
};

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	const access = await accessOf(membership);
	const scope = organisationScope(env.DB, membership.organisation.id);

	switch (input.intent) {
		case "remind":
			return remindToSubmit(request, membership, access, input.startsOn, input.personId);
		case "remind-all":
			return remindToSubmit(request, membership, access, input.startsOn, null);
		case "approve-leave":
		case "refuse-leave": {
			const result = await decideLeave(scope, access, input.requestId, {
				action: input.intent === "approve-leave" ? "approved" : "refused",
				comment: input.comment || null,
			});
			if (result === "done") {
				return done(input.intent === "approve-leave" ? "Leave approved." : "Leave refused.");
			}
			if (typeof result === "object") return declined(result.problem, 409);
			if (result === "refused-before") {
				return declined(
					refusedBeforeSentence(await refusersNamed(scope, "leave", input.requestId)),
					403,
				);
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
			if (result === "refused-before") {
				return declined(
					refusedBeforeSentence(await refusersNamed(scope, "work", input.requestId)),
					403,
				);
			}
			const [problem, status] = LEAVE_DECIDED[result];
			return declined(problem, status);
		}
		case "approve":
			return outcome(
				await decide(
					scope,
					access,
					input.periodId,
					{ action: "approved" },
					{ overLimitConfirmed: input.overLimit === "on" },
				),
				"Timesheet approved.",
			);
		case "approve-all": {
			const startsOn = Day.safeParse(input.startsOn);
			if (!startsOn.success) return declined("That week is not one this page knows.");
			const people = await decidablePeople(scope, membership.organisation, access);
			return done(approvedAllSaid(await approveAll(scope, access, people, startsOn.data)));
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
type Target = { id: string; name: string; overLimit?: string | null };

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
		| "remind"
		| "remind-all"
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
				{query.status === "not-submitted" && (counts["not-submitted"] ?? 0) > 1 && (
					<div className="mb-4">
						<Button variant="outlined" onPress={() => open("remind-all", null)}>
							Remind all {counts["not-submitted"]}
						</Button>
					</div>
				)}
				{rows === null ? (
					<EmptySheet heading={status}>
						This week has not ended yet. Who has not submitted it is listed once it has.
					</EmptySheet>
				) : rows.length === 0 ? (
					<EmptySheet heading={status}>
						{NOTHING[query.status]}
						{query.status === "pending" &&
							loaderData.notSubmitted !== null &&
							loaderData.notSubmitted.length > 0 && (
								<>
									{" "}
									{notSubmittedSentence(loaderData.notSubmitted)}{" "}
									<Link
										to={`${here}?${WEEK_PARAM}=${week.period.startsOn}&status=not-submitted${grouped}`}
										className={TEXT_LINK}
									>
										Show them
									</Link>
								</>
							)}
					</EmptySheet>
				) : (
					<Ledger heading={status} note={`By ${query.group}`}>
						{query.group === "person" ? (
							<LedgerRows label={`${status}, by person`}>
								{rows.map((p) => {
									const on = {
										id: p.periodId ?? "",
										name: `${p.person.name}'s`,
										overLimit: p.overLimit,
									};
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
													{p.overLimit && <span className="block text-error">{p.overLimit}</span>}
													{p.waits && <span className="block">{p.waits}</span>}
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
											value={
												<>
													{hours(p.seconds)}
													{p.split && (
														<span className="block text-body-medium text-on-surface-variant">
															{p.split}
														</span>
													)}
												</>
											}
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
												) : query.status === "not-submitted" ? (
													<Button
														variant="text"
														aria-label={`Remind ${p.person.name} to submit`}
														onPress={() => open("remind", { id: p.person.id, name: p.person.name })}
													>
														Remind
													</Button>
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
										value={
											<>
												{project.hours}
												{project.split && (
													<span className="block text-body-medium text-on-surface-variant">
														{project.split}
													</span>
												)}
											</>
										}
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
						<LedgerTotal
							label="Total"
							value={
								<>
									{total}
									{loaderData.totalSplit && (
										<span className="block text-body-medium text-on-surface-variant">
											{loaderData.totalSplit}
										</span>
									)}
								</>
							}
						/>
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
													{r.inTheWay && (
														<span className="block text-error">
															{r.inTheWay}: leave and time cannot share a day. Approving is refused
															until the time is removed.
														</span>
													)}
													{r.note && <span className="block wrap-anywhere">“{r.note}”</span>}
													{r.waits && <span className="block">{r.waits}</span>}
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
														{w.waits && <span className="block">{w.waits}</span>}
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
				title={
					target?.overLimit
						? `Approve ${target.name} timesheet over its limit?`
						: `Approve ${target?.name ?? "this"} timesheet?`
				}
				intent="approve"
				submitLabel={target?.overLimit ? "Approve over its limit" : "Approve"}
				isOpen={task === "approve"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="periodId" value={target?.id ?? ""} />
				{target?.overLimit && (
					<>
						<input type="hidden" name="overLimit" value="on" />
						<p>
							{target.overLimit}. Its person could not have submitted it as it is. Approved, it is
							paid as it is, and the activity log says it was approved over its limit.
						</p>
					</>
				)}
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
				<p>
					Every timesheet waiting for the week of {week.label} is approved at once, but for any with
					a day over its limit or a timer still running: those are left for you to look at one at a
					time.
				</p>
			</FormSheet>

			<FormSheet
				title={`Remind ${target?.name ?? ""} to submit?`}
				intent="remind"
				submitLabel="Remind"
				isOpen={task === "remind"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="startsOn" value={week.period.startsOn} />
				<input type="hidden" name="personId" value={target?.id ?? ""} />
				<p>
					{target?.name} is told, in the bell and by email unless they have turned that off, that
					you asked them to submit their timesheet for the week of {week.label}.
				</p>
			</FormSheet>

			<FormSheet
				title={`Remind all ${counts["not-submitted"] ?? 0} to submit?`}
				intent="remind-all"
				submitLabel="Remind all"
				isOpen={task === "remind-all"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="startsOn" value={week.period.startsOn} />
				<p>
					Everyone who has not submitted the week of {week.label} is told, in the bell and by email
					unless they have turned that off, that you asked them to submit it.
				</p>
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
