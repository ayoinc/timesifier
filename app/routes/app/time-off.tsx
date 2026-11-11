import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { cx } from "~/components/cx";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
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
	withdrawLeave,
	workingWeekOf,
} from "~/leave/leave.server";
import { spanLabel } from "~/leave/words";
import { parseRequest } from "~/lib/validate";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, viewerOf } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { canSee, destination, destinationPath } from "~/shell/destinations";
import { EmptySheet, PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { Day, dayOf } from "~/time/calendar";
import { zoneOfMember } from "~/time/zones.server";

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

const { label } = destination("time-off");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** The query that opens the Requests tab. */
const SHOW_PARAM = "show";

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

	const [mine, week, holidays, decidedByOthers] = await Promise.all([
		myLeave(scope, user.id, year),
		workingWeekOf(scope),
		publicHolidaysOf(scope, { first: today, last: `${year + 1}-12-31` }),
		someoneElseDecides(scope, user.id),
	]);
	const holidayKind = mine.kinds.find((k) => k.key === HOLIDAY_KIND);
	const calendar = {
		week,
		holidays: new Map(holidayKind?.enabled === false ? [] : holidays.map((h) => [h.day, h.name])),
	};

	let requests = null;
	let waiting = 0;
	if (decides) {
		const access = await accessOf(membership);
		const people = await leaveDecidablePeople(scope, organisation, access);
		const listed = await requestsToDecide(scope, access, people, (person) =>
			dayOf(Date.now(), person.timeZone),
		);
		waiting = listed.pending.length;
		if (show === "requests") {
			const shape = (r: (typeof listed.pending)[number]) => ({
				id: r.id,
				person: r.person.name,
				kind: r.kindName,
				days: spanLabel(r),
				takes: halfDaysLabel(r.halfDays),
				note: r.note,
				cancellable: r.cancellable,
			});
			requests = { pending: listed.pending.map(shape), upcoming: listed.upcoming.map(shape) };
		}
	}

	return {
		show,
		decides,
		waiting,
		year,
		today,
		kinds: requestableKinds(mine.kinds).map(({ id, name }) => ({ id, name })),
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
	}),
	z.object({ intent: z.literal("withdraw"), requestId: Id }),
	z.object({ intent: z.literal("approve"), requestId: Id, comment: Text.optional() }),
	z.object({ intent: z.literal("refuse"), requestId: Id, comment: Text.optional() }),
	z.object({ intent: z.literal("cancel"), requestId: Id, comment: z.string() }),
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

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const access = await accessOf(membership);

	switch (input.intent) {
		case "request": {
			const made = await requestLeave(scope, membership.user.id, {
				kindId: input.kindId,
				startsOn: input.startsOn,
				endsOn: input.endsOn,
				startsHalf: input.startsHalf,
				endsHalf: input.endsHalf,
				note: input.note || null,
			});
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
			if (reason.length === 0 || reason.length > LEAVE_TEXT_MAX_LENGTH) {
				return declined(`Say why, in 1 to ${LEAVE_TEXT_MAX_LENGTH} characters.`);
			}
			const people = await leaveDecidablePeople(scope, membership.organisation, access);
			return outcome(
				await cancelLeave(scope, access, input.requestId, reason, async (userId) =>
					dayOf(Date.now(), people.find((p) => p.id === userId)?.timeZone ?? "UTC"),
				),
				"Leave cancelled.",
			);
		}
	}
}

type Loaded = Route.ComponentProps["loaderData"];
type Task = "request" | "withdraw" | "approve" | "refuse" | "cancel";
type Target = { id: string; name: string };

export default function TimeOff({ loaderData }: Route.ComponentProps) {
	const organisation = useOrganisation();
	const { show, decides, waiting } = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [target, setTarget] = useState<Target | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const open = (next: Task, on: Target | null) => {
		setTarget(on);
		setTask(next);
	};
	const here = destinationPath(organisation.slug, "time-off");

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
				<Mine data={loaderData} open={open} />
			)}

			<FormSheet
				title="Request time off"
				intent="request"
				submitLabel="Request"
				isOpen={task === "request"}
				onClose={close}
				onDone={setSaid}
			>
				<RequestFields kinds={loaderData.kinds} today={loaderData.today} />
				{loaderData.alone && (
					<p className="text-body-medium text-on-surface-variant">
						Nobody else here can decide your leave, so leave that needs approval is approved as soon
						as you send it.
					</p>
				)}
			</FormSheet>

			<FormSheet
				title={`Withdraw your request for ${target?.name ?? "leave"}?`}
				intent="withdraw"
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
				intent="approve"
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
				intent="refuse"
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
				intent="cancel"
				submitLabel="Cancel leave"
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
					description="They read this with the request. The days are theirs to work again."
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

function RequestFields({ kinds, today }: Pick<Loaded, "kinds" | "today">) {
	const [startsOn, setStartsOn] = useState(today);
	const [endsOn, setEndsOn] = useState(today);
	const oneDay = startsOn === endsOn || endsOn === "";
	return (
		<>
			<Select
				label="Kind of leave"
				name="kindId"
				options={kinds.map(({ id, name }) => ({ id, label: name }))}
				defaultValue={kinds[0]?.id ?? null}
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

function Mine({ data, open }: { data: Loaded; open: (task: Task, on: Target | null) => void }) {
	const { balances, requests, holidays, year, kinds } = data;
	return (
		<>
			{kinds.length > 0 && (
				<div className="mt-6">
					<Button onPress={() => open("request", null)}>Request time off</Button>
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

function Requests({
	decisions,
	open,
}: {
	decisions: Decisions;
	open: (task: Task, on: Target | null) => void;
}) {
	const { pending, upcoming } = decisions;
	return (
		<>
			<Section id="waiting" heading="Waiting for you" className="max-w-200">
				{pending.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">No request is waiting for you.</p>
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
										detail={`${r.days} · ${r.takes}`}
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
		</>
	);
}
