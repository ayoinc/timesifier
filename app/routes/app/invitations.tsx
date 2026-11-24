import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { changes, record } from "~/activity/activity.server";
import { INVITATION_LIFETIME_SECONDS } from "~/auth/invitation-email";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import { knownOf, plansOf, roomFor, sendInvitations } from "~/onboarding/onboarding.server";
import { decidePeople, MANY_MAX, rowsOfAddresses, splitAddresses } from "~/onboarding/people";
import { cancelInvitation, inviteMember, listOpenInvitations } from "~/organisations/api.server";
import { membershipContext } from "~/organisations/membership.server";
import { declined, done, refused, unavailable } from "~/organisations/outcome.server";
import { AS_ROLE } from "~/organisations/people";
import { NOT_ALLOWED } from "~/organisations/problems";
import { allows, InvitedRole } from "~/organisations/roles";
import { mailOrigin } from "~/platform/mail.server";
import { useTimeZone } from "~/routes/auth/AccountSettings";
import { peopleImportPath } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";
import { TeamTabs } from "~/teams/TeamTabs";
import { dayOf } from "~/time/calendar";
import { formatDayWithYear } from "~/time/format";

import type { Route } from "./+types/invitations";
import { FormSheet } from "./FormSheet";
import { RoleChoice } from "./RoleChoice";
import { useOrganisation } from "./useOrganisation";

// The invitations of an organisation, a page of Team: sending one, sending
// many at once with one role and perhaps a team (TS-108), and the ones waiting
// to be accepted, for a role that may send them. The server refuses them to
// any other role, so for that role they are not asked for. A CSV of people is
// imported on a page of its own below this one.

const TITLE = "Invitations";
/** The roles an invitation can give, the usual one first. */
const INVITED_ROLES = ["member", "finance", "admin"] as const satisfies readonly z.output<
	typeof InvitedRole
>[];
const INVITATION_DAYS = INVITATION_LIFETIME_SECONDS / (24 * 60 * 60);
/** The longest list of addresses "Invite many" reads: each at most 254 characters and a separator. */
const ADDRESSES_MAX_LENGTH = MANY_MAX * 256;
/** The Team field's choice of no team. */
const NO_TEAM = "none";

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** The invitations still waiting, with what each is to bring, and the room for more, for a role that may send them. */
export async function loader({ request, context }: Route.LoaderArgs) {
	const { organisation, role, user } = context.get(membershipContext);
	const canInvite = allows(role, { invitation: ["create"] });
	const invitations = canInvite ? await listOpenInvitations(request, organisation.id) : null;
	if (invitations && !invitations.ok) throw unavailable(invitations);
	const scope = organisationScope(env.DB, organisation.id);
	const open = invitations?.data ?? [];
	const [plans, teams, room] = canInvite
		? await Promise.all([
				plansOf(
					scope,
					open.map((each) => each.id),
				),
				scope.teams.select(),
				roomFor(organisation.id, user.id, new Date()),
			])
		: [new Map(), [], null];

	return {
		canInvite,
		canCancel: allows(role, { invitation: ["cancel"] }),
		invitations: open.map(({ id, email, role, expiresAt }) => {
			const plan = plans.get(id);
			return {
				id,
				email,
				role,
				expiresAt,
				name: plan?.name ?? null,
				team: plan?.team ?? null,
				emailWaiting: plan?.emailWaiting === true,
			};
		}),
		teams: teams
			.map((team) => ({ id: team.id, name: team.name }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		room,
	};
}

const Id = z.string().min(1).max(64);

/** Each thing this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	// The address is checked below, where a mistake in it can be answered in words.
	z.object({ intent: z.literal("invite"), email: z.string().trim().max(254), role: InvitedRole }),
	z.object({ intent: z.literal("cancel"), invitationId: Id }),
	z.object({
		intent: z.literal("many"),
		addresses: z.string().max(ADDRESSES_MAX_LENGTH),
		role: InvitedRole,
		teamId: Id.default(NO_TEAM),
	}),
]);

/**
 * Asks the server for one of them, in the organisation the layout read from
 * the address; no form names an organisation. The server allows or refuses by
 * the person's role, and what it refuses comes back as a sentence. An
 * invitation sent or cancelled is recorded in the activity log.
 */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const { organisation, user, role } = context.get(membershipContext);
	const { id } = organisation;
	const scope = organisationScope(env.DB, id);

	switch (input.intent) {
		case "invite": {
			const email = z.email().safeParse(input.email);
			if (!email.success) {
				return declined("That email address is not valid. Check it and try again.");
			}
			const invited = await inviteMember(request, id, { email: email.data, role: input.role });
			if (!invited.ok) return refused(invited);
			await record(
				scope,
				user.id,
				"invitation.created",
				{ type: "invitation", id: invited.data.id },
				// The role alone: the address stays in the invitation, which is deleted
				// with it, and is not kept in the log for two years.
				changes(null, { role: input.role }, ["role"]),
			);
			return done(
				`An invitation is on its way to ${email.data}. Its link works once and expires in ${INVITATION_DAYS} days.`,
			);
		}

		case "cancel": {
			const cancelled = await cancelInvitation(request, id, input.invitationId);
			if (!cancelled.ok) return refused(cancelled);
			await record(
				scope,
				user.id,
				"invitation.cancelled",
				{ type: "invitation", id: input.invitationId },
				changes({ status: "pending" }, { status: "canceled" }, ["status"]),
			);
			return done("Invitation cancelled. Its link no longer works.");
		}

		case "many": {
			if (!allows(role, { invitation: ["create"] })) return declined(NOT_ALLOWED, 403);
			const addresses = splitAddresses(input.addresses);
			if (addresses.length === 0) return declined("Enter at least one email address.");
			if (addresses.length > MANY_MAX) {
				return declined(
					`That is ${addresses.length} addresses. Send at most ${MANY_MAX} at once, or import a CSV of people.`,
				);
			}
			const known = await knownOf(scope, Date.now());
			const wantsTeam = input.teamId !== NO_TEAM;
			const team = wantsTeam
				? [...known.teams.values()].find((each) => each.id === input.teamId)
				: undefined;
			if (wantsTeam && !team) return declined("That team is no longer there. Choose another.");
			// An address pasted twice, in any case, is sent once and reported once.
			const seen = new Set<string>();
			const firsts: string[] = [];
			const repeats = new Set<string>();
			for (const address of addresses) {
				const key = address.toLowerCase();
				if (seen.has(key)) repeats.add(address);
				else {
					seen.add(key);
					firsts.push(address);
				}
			}
			const twice = [...repeats];
			const outcomes = decidePeople(rowsOfAddresses(firsts, input.role, team?.name ?? ""), known);
			const notSent = [
				...outcomes.flatMap((o) => (o.ok ? [] : [`${o.email}: ${o.problems.join(" ")}`])),
				...twice.map((address) => `${address}: It is in the list twice; one invitation is enough.`),
			];
			const report = notSent.length > 0 ? ` Not sent: ${notSent.join(" ")}` : "";
			const plans = outcomes.flatMap((o) => (o.ok ? [o.plan] : []));
			if (plans.length === 0) return declined(`Nothing was sent.${report}`);
			const sent = await sendInvitations(scope, user.id, plans, {
				origin: mailOrigin(request),
			});
			if (!sent.ok) return declined(`${sent.problem}${report}`, 403);
			return done(
				`${sent.sent === 1 ? "An invitation is" : `${sent.sent} invitations are`} on the way${team ? `, each into ${team.name}` : ""}. Their links work once and expire in ${INVITATION_DAYS} days.${report}`,
			);
		}
	}
}

type Invitation = Route.ComponentProps["loaderData"]["invitations"][number];

/** The sheets of this page. One is open at a time. */
type Task = "invite" | "many" | "cancel";

/** The room left, in a sentence: the seats, and the sender's invitations today when they are fewer. */
function roomSentence(room: { seats: number; seatsLeft: number; cap: number; capLeft: number }) {
	const seats = `${room.seatsLeft === 0 ? "No seat is" : room.seatsLeft === 1 ? "One seat is" : `${room.seatsLeft} seats are`} left on the plan, of ${room.seats}.`;
	return room.capLeft < room.seatsLeft
		? `${seats} You may send ${room.capLeft} more ${room.capLeft === 1 ? "invitation" : "invitations"} in the next 24 hours.`
		: seats;
}

export default function Invitations({ loaderData }: Route.ComponentProps) {
	const { invitations, canInvite, canCancel, teams, room } = loaderData;
	const organisation = useOrganisation();

	const [task, setTask] = useState<Task | null>(null);
	// Which invitation the open sheet is about. Kept after it closes, so the
	// sheet goes on saying the same thing while it leaves.
	const [invitation, setInvitation] = useState<Invitation | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	// An invitation expires on a day on the browser's clock, once the page is the browser's.
	const zone = useTimeZone();

	return (
		<>
			<PageHeading>{TITLE}</PageHeading>
			<PageLead>
				{canInvite
					? `A person joins ${organisation.name} by a link sent to their email address, good once for ${INVITATION_DAYS} days.`
					: `Owners and admins invite people to ${organisation.name}.`}
			</PageLead>
			<TeamTabs slug={organisation.slug} current="invitations" />
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			{canInvite && (
				<div className="max-w-200">
					<div className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-3">
						<Button onPress={() => setTask("invite")}>Invite a person</Button>
						<Button variant="outlined" onPress={() => setTask("many")}>
							Invite many
						</Button>
						<Link className={ACTION_LINK} to={peopleImportPath(organisation.slug)}>
							Import people from a CSV
						</Link>
					</div>
					{room && (
						<p className="mt-3 text-body-medium text-on-surface-variant">{roomSentence(room)}</p>
					)}

					{invitations.length > 0 ? (
						<div className="mt-10">
							<Ledger heading="Not yet accepted" note={invitations.length}>
								<LedgerRows label="Invitations">
									{invitations.map((each) => (
										<LedgerRow
											key={each.id}
											title={
												<span className="wrap-anywhere">
													{each.name ? `${each.name} · ${each.email}` : each.email}
												</span>
											}
											detail={
												<>
													Invited as {AS_ROLE[each.role]}
													{each.team ? `, into ${each.team}` : ""}. Expires{" "}
													{formatDayWithYear(dayOf(Date.parse(each.expiresAt), zone))}.
													{each.emailWaiting ? " Its email is waiting its turn to be sent." : ""}
												</>
											}
											action={
												canCancel && (
													<Button
														variant="text"
														aria-label={`Cancel the invitation to ${each.email}`}
														onPress={() => {
															setInvitation(each);
															setTask("cancel");
														}}
													>
														Cancel
													</Button>
												)
											}
										/>
									))}
								</LedgerRows>
							</Ledger>
						</div>
					) : (
						<EmptySheet heading="Not yet accepted">
							No invitation is waiting. The ones you send are listed here until they are accepted.
						</EmptySheet>
					)}
				</div>
			)}

			<FormSheet
				title="Invite a person"
				intent="invite"
				submitLabel="Send invitation"
				isOpen={task === "invite"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					They get an email with a link to join {organisation.name}. The link works once, for that
					address, and expires after {INVITATION_DAYS} days.
				</p>
				<TextField
					label="Email address"
					name="email"
					type="email"
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={254}
				/>
				<RoleChoice roles={INVITED_ROLES} defaultValue="member" />
			</FormSheet>

			<FormSheet
				title="Invite many people"
				intent="many"
				submitLabel="Send invitations"
				isOpen={task === "many"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					Each address gets its own invitation to {organisation.name}, with the same role
					{teams.length > 0 ? " and team" : ""}. Members, addresses already invited and any listed
					twice are named and not sent.
				</p>
				<TextField
					label="Email addresses"
					name="addresses"
					rows={6}
					autoFocus
					isRequired
					maxLength={ADDRESSES_MAX_LENGTH}
					description={`One a line, or separated by commas. At most ${MANY_MAX}.`}
				/>
				<RoleChoice roles={INVITED_ROLES} defaultValue="member" />
				{teams.length > 0 && (
					<Select
						label="Team"
						name="teamId"
						defaultValue={NO_TEAM}
						options={[
							{ id: NO_TEAM, label: "No team" },
							...teams.map((team) => ({ id: team.id, label: team.name })),
						]}
						description="They join it when they accept."
					/>
				)}
				{room && <p>{roomSentence(room)}</p>}
			</FormSheet>

			<FormSheet
				title="Cancel this invitation?"
				intent="cancel"
				submitLabel="Cancel invitation"
				cancelLabel="Keep it"
				isOpen={task === "cancel"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="invitationId" value={invitation?.id ?? ""} />
				<p>
					The link sent to <strong className="text-on-surface">{invitation?.email}</strong> stops
					working. You can invite the same address again.
				</p>
			</FormSheet>
		</>
	);
}
