import { env } from "cloudflare:workers";
import { useState } from "react";
import * as z from "zod";

import { changes, record } from "~/activity/activity.server";
import { INVITATION_LIFETIME_SECONDS } from "~/auth/invitation-email";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import { cancelInvitation, inviteMember, listOpenInvitations } from "~/organisations/api.server";
import { membershipContext } from "~/organisations/membership.server";
import { declined, done, refused, unavailable } from "~/organisations/outcome.server";
import { AS_ROLE } from "~/organisations/people";
import { allows, InvitedRole } from "~/organisations/roles";
import { useTimeZone } from "~/routes/auth/AccountSettings";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";
import { TeamTabs } from "~/teams/TeamTabs";
import { dayOf } from "~/time/calendar";
import { formatDayWithYear } from "~/time/format";

import type { Route } from "./+types/invitations";
import { FormSheet } from "./FormSheet";
import { RoleChoice } from "./RoleChoice";
import { useOrganisation } from "./useOrganisation";

// The invitations of an organisation, a page of Team: sending one, and the
// ones waiting to be accepted, for a role that may send them. The server
// refuses them to any other role, so for that role they are not asked for.

const TITLE = "Invitations";
/** The roles an invitation can give, the usual one first. */
const INVITED_ROLES = ["member", "finance", "admin"] as const satisfies readonly z.output<
	typeof InvitedRole
>[];
const INVITATION_DAYS = INVITATION_LIFETIME_SECONDS / (24 * 60 * 60);

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** The invitations still waiting, for a role that may send them. */
export async function loader({ request, context }: Route.LoaderArgs) {
	const { organisation, role } = context.get(membershipContext);
	const canInvite = allows(role, { invitation: ["create"] });
	const invitations = canInvite ? await listOpenInvitations(request, organisation.id) : null;
	if (invitations && !invitations.ok) throw unavailable(invitations);

	return {
		canInvite,
		canCancel: allows(role, { invitation: ["cancel"] }),
		invitations:
			invitations?.data.map(({ id, email, role, expiresAt }) => ({ id, email, role, expiresAt })) ??
			[],
	};
}

const Id = z.string().min(1).max(64);

/** Each thing this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	// The address is checked below, where a mistake in it can be answered in words.
	z.object({ intent: z.literal("invite"), email: z.string().trim().max(254), role: InvitedRole }),
	z.object({ intent: z.literal("cancel"), invitationId: Id }),
]);

/**
 * Asks the server for one of them, in the organisation the layout read from
 * the address; no form names an organisation. The server allows or refuses by
 * the person's role, and what it refuses comes back as a sentence. An
 * invitation sent or cancelled is recorded in the activity log.
 */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const { organisation, user } = context.get(membershipContext);
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
	}
}

type Invitation = Route.ComponentProps["loaderData"]["invitations"][number];

/** The sheets of this page. One is open at a time. */
type Task = "invite" | "cancel";

export default function Invitations({ loaderData }: Route.ComponentProps) {
	const { invitations, canInvite, canCancel } = loaderData;
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
					? `A person joins ${organisation.name} by an invitation sent to their email address. Its link works once and expires after ${INVITATION_DAYS} days.`
					: `Owners and admins invite people to ${organisation.name}.`}
			</PageLead>
			<TeamTabs slug={organisation.slug} current="invitations" />
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			{canInvite && (
				<div className="max-w-200">
					<div className="mt-10">
						<Button onPress={() => setTask("invite")}>Invite a person</Button>
					</div>

					{invitations.length > 0 ? (
						<div className="mt-10">
							<Ledger heading="Not yet accepted" note={invitations.length}>
								<LedgerRows label="Invitations">
									{invitations.map((each) => (
										<LedgerRow
											key={each.id}
											title={<span className="wrap-anywhere">{each.email}</span>}
											detail={
												<>
													Invited as {AS_ROLE[each.role]}. Expires{" "}
													{formatDayWithYear(dayOf(Date.parse(each.expiresAt), zone))}.
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
