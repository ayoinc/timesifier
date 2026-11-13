import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Radio, RadioGroup } from "~/components/Radio";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { platformData } from "~/db";
import { parseRequest } from "~/lib/validate";
import { declined, done } from "~/organisations/outcome.server";
import { nameOrEmail } from "~/organisations/people";
import { MAX_SEATS, PLAN_DETAILS, PLANS, TRIAL_DAYS } from "~/plans/plans";
import { planStanding } from "~/plans/plans.server";
import {
	CONSOLE_ZONE,
	consoleDay,
	consoleMoment,
	REASON_MAX_LENGTH,
	REASON_MISSING,
	reasonOf,
} from "~/platform/console-words";
import { platformLog } from "~/platform/events.server";
import { notFound, platformOwnerContext } from "~/platform/guard.server";
import { ORGANISATION_ID_PARAM, ORGANISATIONS_PATH, supportViewPath } from "~/platform/paths";
import { grantInForce } from "~/platform/support.server";
import { FormSheet } from "~/routes/app/FormSheet";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { addDays, Day, dayOf, startOfDay } from "~/time/calendar";

import type { Route } from "./+types/organisation";
import { EventLedger, ReasonField } from "./ConsoleParts";

// One organisation in the platform console (TS-099): what the console may
// know of it (its plan, seats, owners by name, counts and last activity),
// whether its owners have granted support access, and what the console has
// done to it. Its one tool sets the plan, the seats and any trial, with a
// reason that goes into the platform log.

const DAY_MS = 86_400_000;

/** The last day a trial ending at `endsAt` covers: a trial ends at the midnight after its last day. */
function lastDayOf(endsAt: Date): Date {
	return new Date(endsAt.getTime() - 1);
}

const NUMBER = new Intl.NumberFormat("en-GB");

export function meta({ loaderData }: Route.MetaArgs) {
	return [{ title: `${loaderData?.organisation.name ?? "Organisation"} · Timesifier` }];
}

export async function loader({ params }: Route.LoaderArgs) {
	const organisationId = params[ORGANISATION_ID_PARAM];
	const now = new Date();
	const [[row], owners, standing, grant, events] = await Promise.all([
		platformData.platformOrganisations(env.DB, { ids: [organisationId], limit: 1 }),
		platformData.organisationOwners(env.DB, organisationId),
		planStanding(organisationId, now),
		grantInForce(organisationId, now),
		platformLog({ subjectId: organisationId, limit: 50 }),
	]);
	if (!row || !standing) throw notFound();
	return {
		organisation: {
			id: row.id,
			name: row.name,
			slug: row.slug,
			created: consoleDay(row.createdAt),
			members: row.members,
			invited: row.pendingInvitations,
			lastActive: row.lastActiveAt ? consoleMoment(row.lastActiveAt) : null,
			projects: row.projects,
			entries: row.entries,
			invoices: row.invoices,
		},
		owners: owners.map((owner) => ({ id: owner.id, name: nameOrEmail(owner) })),
		plan: {
			plan: standing.plan,
			label: standing.label,
			seats: standing.seats,
			used: standing.used,
			warning: standing.warning,
			trialEnds: standing.trialEndsAt ? consoleDay(lastDayOf(standing.trialEndsAt)) : null,
			trialLastDay: standing.trialEndsAt
				? dayOf(lastDayOf(standing.trialEndsAt), CONSOLE_ZONE)
				: null,
			trialEnded: standing.trialEnded,
			// The seats the row sets, when it sets a number of its own rather than the plan's.
			ownSeats: row.seats,
		},
		support: grant ? { endsAt: consoleMoment(grant.expiresAt) } : null,
		events,
	};
}

/** A number of seats, or blank for the plan's own. */
const Seats = z.preprocess(
	(value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
	z.coerce.number().int().min(1).max(MAX_SEATS).optional(),
);

const TRIALS = ["none", "start", "until"] as const;

const form = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("plan"),
		plan: z.enum(PLANS),
		seats: Seats,
		trial: z.enum(TRIALS),
		trialEndsOn: z.preprocess((value) => (value === "" ? undefined : value), Day.optional()),
		reason: z
			.string()
			.max(REASON_MAX_LENGTH * 2)
			.optional(),
	}),
]);

export async function action({ request, params, context }: Route.ActionArgs) {
	const { user } = context.get(platformOwnerContext);
	const organisationId = params[ORGANISATION_ID_PARAM];
	const input = await parseRequest(request, form);
	const reason = reasonOf(input.reason);
	if (!reason) return declined(REASON_MISSING);

	const now = new Date();
	let trialEndsAt: Date | null = null;
	if (input.trial === "start") {
		trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
	} else if (input.trial === "until") {
		if (!input.trialEndsOn) return declined("Choose the last day of the trial.");
		// The trial runs to the end of the day chosen, on the console's clock.
		trialEndsAt = new Date(startOfDay(addDays(input.trialEndsOn, 1), CONSOLE_ZONE));
		if (trialEndsAt.getTime() <= now.getTime()) {
			return declined("The last day of a trial must be today or later.");
		}
	}

	const changed = await platformData.setOrganisationPlan(env.DB, organisationId, {
		plan: input.plan,
		seats: input.seats ?? null,
		trialEndsAt,
	});
	if (!changed) throw notFound();
	await platformData.recordPlatformEvent(env.DB, {
		actorId: user.id,
		action: "organisation.plan_changed",
		subjectType: "organisation",
		subjectId: organisationId,
		reason,
		detail: {
			plan: input.plan,
			seats: input.seats ?? null,
			trialEndsAt: trialEndsAt?.toISOString() ?? null,
		},
	});

	const seats = input.seats ?? PLAN_DETAILS[input.plan].seats;
	const label = PLAN_DETAILS[input.plan].label;
	return done(
		trialEndsAt
			? `The plan is now ${label} with ${NUMBER.format(seats)} seats, on trial to ${consoleDay(lastDayOf(trialEndsAt))}.`
			: `The plan is now ${label} with ${NUMBER.format(seats)} seats.`,
	);
}

export default function Organisation({ loaderData }: Route.ComponentProps) {
	const { organisation, owners, plan, support, events } = loaderData;
	const [changing, setChanging] = useState(false);
	const [said, setSaid] = useState<string | null>(null);
	const [trial, setTrial] = useState<(typeof TRIALS)[number]>(plan.trialEnds ? "until" : "none");
	const today = dayOf(Date.now(), CONSOLE_ZONE);

	return (
		<>
			<p className="mb-2 text-body-medium">
				<Link to={ORGANISATIONS_PATH} className={TEXT_LINK}>
					All organisations
				</Link>
			</p>
			<PageHeading>{organisation.name}</PageHeading>
			<PageLead>
				Made {organisation.created}, at the web address /{organisation.slug}.{" "}
				{organisation.lastActive
					? `Someone in it was last active ${organisation.lastActive}.`
					: "Nobody in it has signed in yet."}
			</PageLead>

			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section
				id="plan"
				heading="Plan"
				lead="Nothing is paid yet: the plan, its seats and any trial are set here."
			>
				<Ledger
					heading={plan.label}
					note={plan.trialEnds ? `Trial to ${plan.trialEnds}` : undefined}
				>
					<LedgerRows>
						<LedgerRow
							title="Seats used"
							detail={plan.warning ?? "Members and pending invitations each hold a seat."}
							value={`${NUMBER.format(plan.used)} of ${NUMBER.format(plan.seats)}`}
						/>
						{plan.trialEnded && (
							<LedgerRow
								title="Trial ended"
								detail="Its trial has ended, so it is on Free until a plan is set here."
							/>
						)}
					</LedgerRows>
				</Ledger>
				<div className="mt-4">
					<Button variant="outlined" onPress={() => setChanging(true)}>
						Change the plan
					</Button>
				</div>
			</Section>

			<Section id="owners" heading="Owners" lead="The people to talk to about this organisation.">
				{owners.length === 0 ? (
					<p className="text-body-large">It has no owner.</p>
				) : (
					<ul className="flex flex-col gap-1 text-body-large">
						{owners.map((owner) => (
							<li key={owner.id} className="wrap-anywhere">
								{owner.name}
							</li>
						))}
					</ul>
				)}
			</Section>

			<Section id="use" heading="How much it holds">
				<Ledger heading="Counts">
					<LedgerRows>
						<LedgerRow title="Members" value={NUMBER.format(organisation.members)} />
						<LedgerRow title="Pending invitations" value={NUMBER.format(organisation.invited)} />
						<LedgerRow title="Projects" value={NUMBER.format(organisation.projects)} />
						<LedgerRow title="Time entries" value={NUMBER.format(organisation.entries)} />
						<LedgerRow title="Invoices" value={NUMBER.format(organisation.invoices)} />
					</LedgerRows>
				</Ledger>
			</Section>

			<Section id="support" heading="Support access">
				{support ? (
					<p className="max-w-160 text-body-large">
						Its owners have granted support access until {support.endsAt}.{" "}
						<Link to={supportViewPath(organisation.id)} className={TEXT_LINK}>
							Read the organisation
						</Link>
						. Each reading is recorded in its activity log and in the platform log.
					</p>
				) : (
					<p className="max-w-160 text-body-large">
						Support access is not granted. Only the organisation's owners can grant it, from their
						settings; until then the console reads nothing of its own.
					</p>
				)}
			</Section>

			<Section id="log" heading="What the console has done here">
				{events.length === 0 ? (
					<p className="text-body-large">Nothing yet.</p>
				) : (
					<EventLedger heading="Platform log" events={events} hideSubject />
				)}
			</Section>

			<FormSheet
				title="Change the plan"
				intent="plan"
				submitLabel="Change the plan"
				isOpen={changing}
				onClose={() => setChanging(false)}
				onDone={setSaid}
			>
				<Select
					label="Plan"
					name="plan"
					defaultValue={plan.plan}
					options={PLANS.map((id) => ({
						id,
						label: `${PLAN_DETAILS[id].label}, ${NUMBER.format(PLAN_DETAILS[id].seats)} seats`,
					}))}
				/>
				<TextField
					label="Seats"
					name="seats"
					inputMode="numeric"
					pattern="[0-9]*"
					defaultValue={plan.ownSeats === null ? "" : String(plan.ownSeats)}
					description={`Leave it blank for the plan's own number. At most ${NUMBER.format(MAX_SEATS)}.`}
				/>
				<RadioGroup
					label="Trial"
					name="trial"
					value={trial}
					onChange={(value) => setTrial(value as (typeof TRIALS)[number])}
				>
					<Radio value="none">No trial</Radio>
					<Radio value="start">Start a {TRIAL_DAYS}-day trial today</Radio>
					<Radio value="until">A trial to a day of your choosing</Radio>
				</RadioGroup>
				{trial === "until" && (
					<TextField
						label="Last day of the trial"
						name="trialEndsOn"
						type="date"
						isRequired
						defaultValue={plan.trialLastDay ?? addDays(today, TRIAL_DAYS)}
						description="When the trial ends the organisation moves to Free."
					/>
				)}
				<ReasonField />
			</FormSheet>
		</>
	);
}
