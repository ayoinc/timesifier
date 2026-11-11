import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import * as z from "zod";

import {
	approvalsFor,
	approveAll,
	type Decided,
	decidablePeople,
	decide,
	pendingPeriods,
} from "~/approvals/approvals.server";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Tab, TabList, TabPanel, Tabs } from "~/components/Tabs";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import { mayReopenPeriods } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { PERIOD_COMMENT_MAX_LENGTH, periodContaining } from "~/periods/periods";
import { destination, destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";
import { viewedPeriod } from "~/teams/viewed-period.server";
import { periodLabel, WEEK_PARAM } from "~/teams/words";
import { Day } from "~/time/calendar";

import type { Route } from "./+types/approvals";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Approvals (TS-047): the periods people submit, decided one period at a
// time. Owners and admins decide everyone's; a manager decides those of the
// members of the teams they manage, never their own; a member is not shown it
// and gets 404 (app/shell/destinations.ts). A period is approved, alone or
// with every other pending one of the same week, or returned with a comment;
// an owner or admin reopens an approved one with a reason.

const { label } = destination("approvals");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation } = membership;
	const access = await accessOf(membership);
	const scope = organisationScope(env.DB, organisation.id);
	const people = await decidablePeople(scope, organisation, access);
	const waiting = await pendingPeriods(scope, people);

	// With no week asked for, the latest week with something pending, or else last week.
	const url = new URL(request.url);
	if (!url.searchParams.has(WEEK_PARAM) && waiting[0]) {
		url.searchParams.set(WEEK_PARAM, waiting[0].startsOn);
	}
	const viewed = await viewedPeriod(membership, url, -1);
	const approvals = await approvalsFor(scope, people, viewed.period, viewed.today);
	const date = new Intl.DateTimeFormat("en-GB", {
		day: "numeric",
		month: "long",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZone: viewed.zone,
	});
	const pick = ({ id, name }: { id: string; name: string }) => ({ id, name });
	return {
		week: { label: periodLabel(viewed.period), ...viewed },
		canReopen: mayReopenPeriods(access),
		elsewhere: waiting
			.filter((w) => w.startsOn !== viewed.period.startsOn)
			.map((w) => ({
				startsOn: w.startsOn,
				count: w.count,
				label: periodLabel(periodContaining(w.startsOn, organisation.weekStartsOn)),
			})),
		pending: approvals.pending.map((p) => ({
			id: p.id,
			person: pick(p.person),
			submittedAt: date.format(p.submittedAt),
		})),
		notSubmitted: approvals.notSubmitted?.map(pick) ?? null,
		decided: approvals.decided.map((p) => ({
			id: p.id,
			person: pick(p.person),
			status: p.status,
			decidedBy: p.decidedBy,
			decidedAt: date.format(p.decidedAt),
			comment: p.comment,
		})),
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

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	const access = await accessOf(membership);
	const scope = organisationScope(env.DB, membership.organisation.id);

	switch (input.intent) {
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
const TABS = ["pending", "not-submitted", "decided"] as const;
type Target = { id: string; name: string };

export default function Approvals({ loaderData }: Route.ComponentProps) {
	const organisation = useOrganisation();
	const { week, pending, notSubmitted, decided, canReopen, elsewhere } = loaderData;
	const [task, setTask] = useState<"approve" | "all" | "return" | "reopen" | null>(null);
	const [target, setTarget] = useState<Target | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const open = (next: NonNullable<typeof task>, on: Target | null) => {
		setTarget(on);
		setTask(next);
	};
	const here = destinationPath(organisation.slug, "approvals");
	// `?tab=decided` or `?tab=not-submitted` opens on that tab, so a link can point at it.
	const [search, setSearch] = useSearchParams();
	// The week on screen goes into the address, so a decision that empties it
	// does not move the page to another week when the page is read again.
	const startsOn = week.period.startsOn;
	useEffect(() => {
		if (search.has(WEEK_PARAM)) return;
		setSearch(
			(current) => {
				current.set(WEEK_PARAM, startsOn);
				return current;
			},
			{ replace: true, preventScrollReset: true },
		);
	}, [search, setSearch, startsOn]);
	const tab = TABS.find((each) => each === search.get("tab")) ?? "pending";

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>The timesheets people submit for the week of {week.label}.</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			<p className="mt-6 flex max-w-200 items-center justify-between gap-4 text-body-large">
				<Link to={`${here}?${WEEK_PARAM}=${week.previous}`} className={TEXT_LINK}>
					← Previous week
				</Link>
				{week.next ? (
					<Link to={`${here}?${WEEK_PARAM}=${week.next}`} className={TEXT_LINK}>
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
							<Link to={`${here}?${WEEK_PARAM}=${w.startsOn}`} className={TEXT_LINK}>
								{w.label}
							</Link>{" "}
							({w.count})
						</span>
					))}
					.
				</p>
			)}

			<div className="mt-6 max-w-200">
				<Tabs defaultSelectedKey={tab}>
					<TabList label="Timesheets">
						<Tab id="pending">Pending ({pending.length})</Tab>
						<Tab id="not-submitted">Not submitted{notSubmitted && ` (${notSubmitted.length})`}</Tab>
						<Tab id="decided">Decided ({decided.length})</Tab>
					</TabList>
					<TabPanel id="pending">
						<Pending
							slug={organisation.slug}
							startsOn={week.period.startsOn}
							pending={pending}
							onApprove={(on) => open("approve", on)}
							onReturn={(on) => open("return", on)}
							onApproveAll={() => open("all", null)}
						/>
					</TabPanel>
					<TabPanel id="not-submitted">
						{notSubmitted === null ? (
							<EmptySheet heading="Not submitted">
								This week has not ended yet. Who has not submitted it is listed once it has.
							</EmptySheet>
						) : notSubmitted.length === 0 ? (
							<EmptySheet heading="Not submitted">Everyone has submitted this week.</EmptySheet>
						) : (
							<div className="mt-6">
								<Ledger heading="Not submitted" note={notSubmitted.length}>
									<LedgerRows label="Not submitted">
										{notSubmitted.map((p) => (
											<LedgerRow
												key={p.id}
												title={<span className="wrap-anywhere">{p.name}</span>}
											/>
										))}
									</LedgerRows>
								</Ledger>
							</div>
						)}
					</TabPanel>
					<TabPanel id="decided">
						{decided.length === 0 ? (
							<EmptySheet heading="Decided">Nothing has been decided for this week.</EmptySheet>
						) : (
							<div className="mt-6">
								<Ledger heading="Decided" note={decided.length}>
									<LedgerRows label="Decided">
										{decided.map((p) => (
											<LedgerRow
												key={p.id}
												title={<span className="wrap-anywhere">{p.person.name}</span>}
												detail={
													<>
														{p.status === "approved" ? "Approved" : "Returned"} by {p.decidedBy},{" "}
														{p.decidedAt}
														{p.comment && (
															<span className="block wrap-anywhere">“{p.comment}”</span>
														)}
													</>
												}
												action={
													canReopen &&
													p.status === "approved" && (
														<Button
															variant="text"
															aria-label={`Reopen ${p.person.name}'s timesheet`}
															onPress={() =>
																open("reopen", { id: p.id, name: `${p.person.name}'s` })
															}
														>
															Reopen
														</Button>
													)
												}
											/>
										))}
									</LedgerRows>
								</Ledger>
							</div>
						)}
					</TabPanel>
				</Tabs>
			</div>

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
				title={`Approve all ${pending.length} pending?`}
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

function Pending({
	slug,
	startsOn,
	pending,
	onApprove,
	onReturn,
	onApproveAll,
}: {
	/** The organisation, and the period, whose people's weeks the names open on Team. */
	slug: string;
	startsOn: string;
	pending: Loaded["pending"];
	onApprove: (on: Target) => void;
	onReturn: (on: Target) => void;
	onApproveAll: () => void;
}) {
	if (pending.length === 0) {
		return <EmptySheet heading="Pending">Nothing is waiting for you this week.</EmptySheet>;
	}
	return (
		<div className="mt-6">
			{pending.length > 1 && (
				<div className="mb-4">
					<Button onPress={onApproveAll}>Approve all {pending.length}</Button>
				</div>
			)}
			<Ledger heading="Pending" note={pending.length}>
				<LedgerRows label="Pending">
					{pending.map((p) => {
						const on = { id: p.id, name: `${p.person.name}'s` };
						return (
							<LedgerRow
								key={p.id}
								title={
									<Link
										to={`${destinationPath(slug, "team")}?${WEEK_PARAM}=${startsOn}&person=${p.person.id}`}
										className={`${TEXT_LINK} wrap-anywhere`}
									>
										{p.person.name}
									</Link>
								}
								detail={`Submitted ${p.submittedAt}`}
								action={
									<span className="flex gap-1">
										<Button
											variant="text"
											aria-label={`Approve ${p.person.name}'s timesheet`}
											onPress={() => onApprove(on)}
										>
											Approve
										</Button>
										<Button
											variant="text"
											aria-label={`Return ${p.person.name}'s timesheet`}
											onPress={() => onReturn(on)}
										>
											Return
										</Button>
									</span>
								}
							/>
						);
					})}
				</LedgerRows>
			</Ledger>
		</div>
	);
}
