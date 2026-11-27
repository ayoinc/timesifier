import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { data, Link, redirect, useNavigate } from "react-router";
import * as z from "zod";

import {
	type ApprovedAll,
	approvalsFor,
	approveAll,
	approveAllParts,
	type DecisionOutcome,
	decidablePeople,
	decide,
	managersAwayOf,
	type PartSummary,
	pendingPeriods,
	pendingProjectWeeks,
	projectApprovals,
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
import {
	APPROVAL_VIEWS,
	type ApprovalView,
	PART_STATUS_LABELS,
	projectsApprovalsPath,
	VIEW_PARAM,
} from "~/approvals/parts";
import { namesOf, refusersNamed, refusersOfAll } from "~/approvals/refusals.server";
import {
	managersAwaySentence,
	notSubmittedSentence,
	refusedBeforeSentence,
} from "~/approvals/words";
import { Button } from "~/components/Button";
import { FilterBar, useApplyFilters } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows, LedgerTotal } from "~/components/Ledger";
import { LinkTabs } from "~/components/LinkTabs";
import { PeriodStepper } from "~/components/PeriodStepper";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { type OrganisationScope, organisationScope } from "~/db";
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
//
// Approval by project (TS-117, decision 79): a week with time on a client
// project that has a delivery manager is held in parts. The page has two
// tabs, `?view=`: People, for line managers, owners and admins, the weeks as
// above, each held in parts decided on its line part and showing its project
// parts as decided or waiting; and Projects, for delivery managers, owners
// and admins, each project's people and their days on it, decided a part at
// a time. A person shown one tab alone sees no tabs; an organisation with no
// delivery manager sees the page as it was.

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
	const views = await viewsOf(scope, membership, access);
	const askedView = APPROVAL_VIEWS.find((each) => each === url.searchParams.get(VIEW_PARAM));
	const view = askedView && views.includes(askedView) ? askedView : (views[0] ?? "people");
	if (view === "projects") return projectsView(membership, access, url, views);
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
		/** Of a week held in parts (TS-117), each project part and where it stands; null for one decided whole. */
		parts: string[] | null;
		/** Whether the whole week is approved, so an owner or admin may reopen it. */
		reopenable: boolean;
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
		projects: PartSummary[] | null = null,
		reopenable = false,
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
		parts:
			projects?.map(
				(part) =>
					`Time on ${part.project}: ${
						part.status === "submitted"
							? "waiting for its delivery manager"
							: `${PART_STATUS_LABELS[part.status].toLowerCase()} by ${part.decidedBy}`
					}`,
			) ?? null,
		reopenable,
	});
	const decided = (p: (typeof approvals.decided)[number]) =>
		row(
			p.person,
			`${p.status === "approved" ? "Approved" : "Returned"} by ${p.decidedBy || "the system"}, ${date.format(p.decidedAt)}`,
			p.id,
			p.comment,
			null,
			p.projects,
			p.reopenable,
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
					p.projects,
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
		view: "people" as const,
		views,
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
		/**
		 * Whether nobody's weeks come to the viewer at all, as for the only owner
		 * of an organisation, whose own week is never theirs to decide (D5, 47).
		 */
		decidesOnNobody: people.length === 0,
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
 * The tabs `membership` is shown (TS-117): People to an owner, an admin or a
 * manager of a team, who decide whole weeks and line parts; Projects to a
 * delivery manager, and to an owner or admin once the organisation has a
 * delivery manager, as they decide any part.
 */
async function viewsOf(
	scope: OrganisationScope,
	membership: Membership,
	access: Access,
): Promise<ApprovalView[]> {
	const administrator = isAdministrator(access.role);
	const projects =
		membership.leadsProjects ||
		(administrator &&
			(
				await scope.projectMembers.select((m) => eq(m.role, "delivery_manager"), {
					limit: 1,
				})
			).length > 0);
	return APPROVAL_VIEWS.filter((view) =>
		view === "people" ? administrator || membership.managesTeams : projects,
	);
}

/**
 * The Projects tab (TS-117): the week's project parts the viewer sees, each
 * project's people and their days, and the other weeks with parts waiting for
 * them. With no week asked for, the latest week with a part waiting.
 */
async function projectsView(
	membership: Membership,
	access: Access,
	url: URL,
	views: ApprovalView[],
) {
	const { organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const now = Date.now();
	const waiting = await pendingProjectWeeks(scope, access);
	const opened = new URL(url);
	const latest = waiting[0];
	if (!url.searchParams.has(WEEK_PARAM) && latest)
		opened.searchParams.set(WEEK_PARAM, latest.startsOn);
	const viewed = await viewedPeriod(membership, opened, 0, now);
	const groups = await projectApprovals(scope, organisation, access, viewed.period, now);
	const date = (instant: number) => formatDayAndTime(instant, viewed.zone);
	const projects = groups.map((group) => ({
		id: group.id,
		name: group.name,
		total: hours(group.parts.reduce((sum, part) => sum + part.seconds, 0)),
		parts: group.parts.map((part) => ({
			periodId: part.periodId,
			person: {
				id: part.person.id,
				name: part.person.address ? shownName({ email: part.person.address }) : part.person.name,
				address: part.person.address,
			},
			status: part.status,
			/** Each day with time on the project, "Mon 9 7:30". */
			days: part.days.flatMap((d) =>
				d.seconds > 0 ? [`${formatDay(d.day, "short")} ${hours(d.seconds)}`] : [],
			),
			total: hours(part.seconds),
			split: regularAndOvertime(part.seconds, part.overtimeSeconds),
			detail:
				part.status === "submitted"
					? `Submitted ${date(part.submittedAt)}`
					: `${PART_STATUS_LABELS[part.status]} by ${part.decidedBy || "the system"}${part.decidedAt ? `, ${date(part.decidedAt)}` : ""}`,
			comment: part.comment,
			mayDecide: part.mayDecide && part.status === "submitted",
			/** Their own time, waiting: nobody approves their own (D5, decision 47). */
			own: part.person.id === access.userId && part.status === "submitted",
			waits: part.waits,
		})),
	}));
	return {
		view: "projects" as const,
		views,
		opensAt: url.searchParams.has(WEEK_PARAM)
			? null
			: projectsApprovalsPath(organisation.slug, viewed.period.startsOn),
		week: { label: periodLabel(viewed.period), ...viewed },
		elsewhere: waiting
			.filter((w) => w.startsOn !== viewed.period.startsOn)
			.map((w) => ({
				startsOn: w.startsOn,
				count: w.count,
				label: periodLabel(periodContaining(w.startsOn, organisation.weekStartsOn)),
			})),
		/** How many parts of the week wait for this viewer's decision. */
		pending: projects.reduce(
			(sum, project) => sum + project.parts.filter((part) => part.mayDecide).length,
			0,
		),
		projects,
	};
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
	z.object({ intent: z.literal("approve-part"), periodId: Id, projectId: Id }),
	z.object({ intent: z.literal("return-part"), periodId: Id, projectId: Id, comment: z.string() }),
	z.object({ intent: z.literal("approve-all-parts"), startsOn: z.string() }),
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

/** What Approve all says it did, and what it left and why (TR-01, TR-02); of parts on the Projects tab (TS-117). */
function approvedAllSaid(
	{ approved, over, running }: ApprovedAll,
	[one, many]: [string, string] = ["timesheet", "timesheets"],
): string {
	if (approved + over + running === 0) return "Nothing was waiting.";
	const said = [
		approved === 0 ? `No ${one} approved.` : `${approved} ${approved === 1 ? one : many} approved.`,
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
		case "approve-part":
			return outcome(
				await decide(
					scope,
					access,
					input.periodId,
					{ action: "approved" },
					{ projectId: input.projectId },
				),
				"Their time on the project approved.",
			);
		case "return-part": {
			const comment = Comment.safeParse(input.comment);
			if (!comment.success) return declined(COMMENT_PROBLEM);
			return outcome(
				await decide(
					scope,
					access,
					input.periodId,
					{ action: "returned", comment: comment.data },
					{ projectId: input.projectId },
				),
				"Their time on the project returned. They can change it and submit it again.",
			);
		}
		case "approve-all-parts": {
			const startsOn = Day.safeParse(input.startsOn);
			if (!startsOn.success) return declined("That week is not one this page knows.");
			const period = periodContaining(startsOn.data, membership.organisation.weekStartsOn);
			return done(
				approvedAllSaid(await approveAllParts(scope, membership.organisation, access, period), [
					"person's time",
					"people's time",
				]),
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
type PeopleLoaded = Extract<Loaded, { view: "people" }>;
type ProjectsLoaded = Extract<Loaded, { view: "projects" }>;
/** What a sheet acts on; `held`: a week held in parts, of which the People tab decides the rest (TS-117). */
type Target = { id: string; name: string; overLimit?: string | null; held?: boolean };

/** What Not submitted says when nobody's weeks come to the viewer at all. */
const NOBODY = "Nobody's weeks come to you to approve.";

/** What a status with nothing in it says, for the week shown. */
const NOTHING: Record<(typeof STATUSES)[number], string> = {
	pending: "Nothing is waiting for you this week.",
	approved: "Nothing has been approved for this week.",
	returned: "Nothing has been returned for this week.",
	"not-submitted": "Everyone has submitted this week.",
};

export default function Approvals({ loaderData }: Route.ComponentProps) {
	return loaderData.view === "projects" ? (
		<ProjectsApprovals loaderData={loaderData} />
	) : (
		<PeopleApprovals loaderData={loaderData} />
	);
}

/** The tabs People and Projects (TS-117), to a person shown both; nothing to one shown one. */
function ViewTabs({ views, view, week }: { views: ApprovalView[]; view: ApprovalView; week: Day }) {
	const organisation = useOrganisation();
	if (views.length < 2) return null;
	return (
		<div className="mt-6 max-w-200">
			<LinkTabs
				label="Approve by"
				current={view}
				tabs={[
					{
						id: "people",
						to: `${destinationPath(organisation.slug, "approvals")}?${WEEK_PARAM}=${week}`,
						label: "People",
					},
					{ id: "projects", to: projectsApprovalsPath(organisation.slug, week), label: "Projects" },
				]}
			/>
		</div>
	);
}

/**
 * The Projects tab (TS-117): the week's time on each project the viewer
 * approves, by person and day, each person's time approved or returned on
 * its own, and all of it at once.
 */
function ProjectsApprovals({ loaderData }: { loaderData: ProjectsLoaded }) {
	const organisation = useOrganisation();
	const { opensAt, week, elsewhere, projects, pending, views } = loaderData;
	const navigate = useNavigate();
	// The week it opened on goes into the address (W13).
	useEffect(() => {
		if (opensAt) navigate(opensAt, { replace: true, preventScrollReset: true });
	}, [opensAt, navigate]);
	const [task, setTask] = useState<"approve" | "return" | "all" | null>(null);
	const [target, setTarget] = useState<{
		periodId: string;
		projectId: string;
		name: string;
	} | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const open = (next: NonNullable<typeof task>, on: typeof target) => {
		setTarget(on);
		setTask(next);
	};
	const at = (startsOn: Day) => projectsApprovalsPath(organisation.slug, startsOn);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>The timesheets people submit, a week at a time.</PageLead>
			<ViewTabs views={views} view="projects" week={week.period.startsOn} />
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			<div className="mt-6 max-w-200">
				<PeriodStepper
					label="Weeks"
					period={week.label}
					previous={{ to: at(week.previous), label: "Previous week" }}
					next={week.next ? { to: at(week.next), label: "Next week" } : null}
					current={week.next ? { to: at(week.current.startsOn), label: "This week" } : undefined}
				/>
			</div>
			{elsewhere.length > 0 && (
				<p className="mt-4 max-w-200 text-body-medium text-on-surface-variant">
					Also waiting:{" "}
					{elsewhere.map((w, index) => (
						<span key={w.startsOn}>
							{index > 0 && ", "}
							<Link to={at(w.startsOn)} className={TEXT_LINK}>
								{w.label}
							</Link>{" "}
							({w.count})
						</span>
					))}
					.
				</p>
			)}
			<div className="mt-8 max-w-200">
				{pending > 1 && (
					<div className="mb-4">
						<Button onPress={() => open("all", null)}>Approve all {pending}</Button>
					</div>
				)}
				{projects.length === 0 ? (
					<EmptySheet heading="Projects">
						No time on the projects you approve was submitted for this week.
					</EmptySheet>
				) : (
					projects.map((project) => (
						<div key={project.id} className="mt-6 first:mt-0">
							<Ledger
								heading={<span className="wrap-anywhere">{project.name}</span>}
								note={project.total}
							>
								<LedgerRows label={`${project.name}, by person`}>
									{project.parts.map((part) => {
										const on = {
											periodId: part.periodId,
											projectId: project.id,
											name: `${part.person.name}'s time on ${project.name}`,
										};
										return (
											<LedgerRow
												key={part.periodId}
												title={<span className="wrap-anywhere">{part.person.name}</span>}
												detail={
													<>
														{part.person.address && (
															<span className="block wrap-anywhere">{part.person.address}</span>
														)}
														<span className="block">
															{part.days.length > 0 ? part.days.join(" · ") : "No time on it"}
														</span>
														{part.detail}
														{part.own && (
															<span className="block">
																Your own time: another delivery manager, an owner or an admin
																approves it.
															</span>
														)}
														{part.waits && <span className="block">{part.waits}</span>}
														{part.comment && (
															<span className="block wrap-anywhere">“{part.comment}”</span>
														)}
													</>
												}
												value={
													<>
														{part.total}
														{part.split && (
															<span className="block text-body-medium text-on-surface-variant">
																{part.split}
															</span>
														)}
													</>
												}
												action={
													part.mayDecide && (
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
																aria-label={`Return ${on.name}`}
																onPress={() => open("return", on)}
															>
																Return
															</Button>
														</span>
													)
												}
											/>
										);
									})}
								</LedgerRows>
							</Ledger>
						</div>
					))
				)}
			</div>

			<FormSheet
				title={`Approve ${target?.name ?? "this time"}?`}
				intent="approve-part"
				submitLabel="Approve"
				isOpen={task === "approve"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="periodId" value={target?.periodId ?? ""} />
				<input type="hidden" name="projectId" value={target?.projectId ?? ""} />
				<p>
					Its entries stay locked. The rest of their week is approved by their line manager, and the
					week is approved once every part of it is.
				</p>
			</FormSheet>

			<FormSheet
				title={`Return ${target?.name ?? "this time"}`}
				intent="return-part"
				submitLabel="Return"
				isOpen={task === "return"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="periodId" value={target?.periodId ?? ""} />
				<input type="hidden" name="projectId" value={target?.projectId ?? ""} />
				<TextField
					label="What needs changing"
					name="comment"
					autoFocus
					isRequired
					maxLength={PERIOD_COMMENT_MAX_LENGTH}
					description="They read this with their timesheet, and correct this time alone."
				/>
			</FormSheet>

			<FormSheet
				title={`Approve all ${pending} waiting?`}
				intent="approve-all-parts"
				submitLabel="Approve all"
				isOpen={task === "all"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="startsOn" value={week.period.startsOn} />
				<p>
					Everyone's time on your projects waiting for the week of {week.label} is approved at once,
					but for anyone whose timer is still running in it: theirs is left for you to approve
					later.
				</p>
			</FormSheet>
		</>
	);
}

/** The People tab: the weeks of the people the viewer decides for, as Approvals was before TS-117. */
function PeopleApprovals({ loaderData }: { loaderData: PeopleLoaded }) {
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
			<ViewTabs views={loaderData.views} view="people" week={week.period.startsOn} />
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
				{query.status === "not-submitted" && loaderData.decidesOnNobody ? (
					<EmptySheet heading={status}>{NOBODY}</EmptySheet>
				) : rows === null ? (
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
										held: p.parts !== null,
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
													{p.parts?.map((part) => (
														<span key={part} className="block wrap-anywhere">
															{part}
														</span>
													))}
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
													query.status === "approved" &&
													p.reopenable && (
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
						? `Approve ${target.held ? "the rest of " : ""}${target.name} timesheet over its limit?`
						: `Approve ${target?.held ? "the rest of " : ""}${target?.name ?? "this"} timesheet?`
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
				<p>
					{target?.held
						? "Its entries stay locked. Their time on projects with a delivery manager is approved by each project's delivery managers, and the week is approved once every part of it is."
						: "Its entries stay locked. An owner or admin can reopen it if it needs changing."}
				</p>
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
				title={`Return ${target?.held ? "the rest of " : ""}${target?.name ?? "this"} timesheet`}
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
function ViewChoice({ query, counts, week }: Pick<PeopleLoaded, "query" | "counts" | "week">) {
	return (
		<div className="mt-8 max-w-200">
			<FilterBar name="Choose timesheets" keep={{ [WEEK_PARAM]: week.period.startsOn }}>
				<ViewFields query={query} counts={counts} />
			</FilterBar>
		</div>
	);
}

function ViewFields({ query, counts }: Pick<PeopleLoaded, "query" | "counts">) {
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
