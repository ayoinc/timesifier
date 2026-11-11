import { useState } from "react";
import { useDateFormatter } from "react-aria";
import { Link, redirect } from "react-router";
import * as z from "zod";

import { INVITATION_LIFETIME_SECONDS } from "~/auth/invitation-email";
import { Button } from "~/components/Button";
import { IconButton } from "~/components/IconButton";
import { MoreVertIcon } from "~/components/icons/MoreVertIcon";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { Radio, RadioGroup } from "~/components/Radio";
import { TextField } from "~/components/TextField";
import { parseRequest } from "~/lib/validate";
import {
	cancelInvitation,
	changeRole,
	inviteMember,
	leaveOrganisation,
	listMembers,
	listOpenInvitations,
	removeMember,
} from "~/organisations/api.server";
import { membershipContext } from "~/organisations/membership.server";
import { declined, done, refused, unavailable } from "~/organisations/outcome.server";
import { AS_ROLE, nameOrEmail, ROLE_LABELS, ROLE_MEANINGS } from "~/organisations/people";
import { NEEDS_AN_OWNER, NOT_ALLOWED } from "~/organisations/problems";
import { allows, InvitedRole, mayRemove, Role, rolesToGive } from "~/organisations/roles";
import { useTimeZone } from "~/routes/auth/AccountSettings";
import { APP_PATH, destination, destinationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading } from "~/shell/PageHeading";

import type { Route } from "./+types/members";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// The people in an organisation and the invitations waiting to be accepted,
// with the actions the person's role allows and no others. Leaving out a
// control is a courtesy: the server decides every time one is used.

const TITLE = "Members";
const INVITATION_DAYS = INVITATION_LIFETIME_SECONDS / (24 * 60 * 60);

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/**
 * Everyone in the organisation, each with what the person may do to them, and
 * the invitations still waiting, for a role that may send them. The server
 * refuses the invitations to any other role, so they are not asked for.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
	const { organisation, role, user } = context.get(membershipContext);
	const canInvite = allows(role, { invitation: ["create"] });

	const [members, invitations] = await Promise.all([
		listMembers(request, organisation.id),
		canInvite ? listOpenInvitations(request, organisation.id) : null,
	]);
	if (!members.ok) throw unavailable(members);
	if (invitations && !invitations.ok) throw unavailable(invitations);

	return {
		canInvite,
		canCancel: allows(role, { invitation: ["cancel"] }),
		members: members.data.map((member) => {
			const isYou = member.userId === user.id;
			return {
				id: member.id,
				name: nameOrEmail(member.user),
				email: member.user.email,
				role: member.role,
				isYou,
				// A person's own way out is leaving, and their own role is another's to change.
				rolesToGive: isYou ? [] : rolesToGive(role, member.role),
				canRemove: !isYou && mayRemove(role, member.role),
			};
		}),
		invitations: invitations?.data.map(({ id, email, role, expiresAt }) => ({
			id,
			email,
			role,
			expiresAt,
		})),
	};
}

const Id = z.string().min(1).max(64);

/** Each thing this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	// The address is checked below, where a mistake in it can be answered in words.
	z.object({ intent: z.literal("invite"), email: z.string().trim().max(254), role: InvitedRole }),
	z.object({ intent: z.literal("cancel"), invitationId: Id }),
	z.object({ intent: z.literal("role"), memberId: Id, role: Role }),
	z.object({ intent: z.literal("remove"), memberId: Id }),
	z.object({ intent: z.literal("leave") }),
]);

/**
 * Asks the server for one of them, in the organisation the layout read from
 * the address; no form names an organisation. The server allows or refuses by
 * the person's role, and what it refuses comes back as a sentence.
 */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const { organisation, role } = context.get(membershipContext);
	const { id } = organisation;

	switch (input.intent) {
		case "invite": {
			const email = z.email().safeParse(input.email);
			if (!email.success) {
				return declined("That email address is not valid. Check it and try again.");
			}
			const invited = await inviteMember(request, id, { email: email.data, role: input.role });
			return invited.ok
				? done(
						`An invitation is on its way to ${email.data}. Its link works once and expires in ${INVITATION_DAYS} days.`,
					)
				: refused(invited);
		}

		case "cancel": {
			const cancelled = await cancelInvitation(request, id, input.invitationId);
			return cancelled.ok
				? done("Invitation cancelled. Its link no longer works.")
				: refused(cancelled);
		}

		case "role": {
			const changed = await changeRole(request, id, { memberId: input.memberId, role: input.role });
			return changed.ok
				? done(`Role changed. They are now ${AS_ROLE[input.role]}.`)
				: refused(changed);
		}

		case "remove": {
			const removed = await removeMember(request, id, input.memberId);
			if (removed.ok) return done("Member removed. They can no longer open this organisation.");
			// The server has one answer here for two refusals: an owner removed by
			// somebody who is not one, and the last owner removed by anybody. Its
			// code speaks of leaving, which this is not.
			return refused(removed, {
				YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER:
					role === "owner" ? NEEDS_AN_OWNER : NOT_ALLOWED,
			});
		}

		case "leave": {
			const left = await leaveOrganisation(request, id);
			return left.ok ? redirect(APP_PATH) : refused(left);
		}
	}
}

type Member = Route.ComponentProps["loaderData"]["members"][number];
type Invitation = NonNullable<Route.ComponentProps["loaderData"]["invitations"]>[number];

/** The sheets of this page. One is open at a time. */
type Task = "invite" | "role" | "remove" | "cancel" | "leave";

const ROW = "flex items-center gap-4 rounded-medium bg-surface-container px-4 py-3";

export default function Members({ loaderData }: Route.ComponentProps) {
	const { members, invitations, canInvite, canCancel } = loaderData;
	const organisation = useOrganisation();

	const [task, setTask] = useState<Task | null>(null);
	// Whom the open sheet is about. Kept after it closes, so the sheet goes on
	// saying the same thing while it leaves.
	const [member, setMember] = useState<Member | null>(null);
	const [invitation, setInvitation] = useState<Invitation | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	const expires = useDateFormatter({ dateStyle: "medium", timeZone: useTimeZone() });
	const alone = members.length === 1 && !invitations?.length;

	return (
		<>
			<p>
				<Link to={destinationPath(organisation.slug, "settings")} className={TEXT_LINK}>
					{destination("settings").label}
				</Link>
			</p>
			<div className="mt-2">
				<PageHeading>{TITLE}</PageHeading>
			</div>
			<p className="mt-2 text-body-large text-on-surface-variant">
				The people in {organisation.name} and what each of them may do.
			</p>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-2 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			{canInvite && (
				<div className="mt-6">
					<Button onPress={() => setTask("invite")}>Invite a person</Button>
				</div>
			)}

			<ul aria-label="Members" className="mt-6 flex flex-col gap-2">
				{members.map((each) => (
					<li key={each.id} className={ROW}>
						<div className="min-w-0 flex-1">
							<p className="wrap-anywhere text-body-large">
								{each.name}
								{each.isYou && <span className="text-on-surface-variant"> (you)</span>}
							</p>
							{each.name !== each.email && (
								<p className="wrap-anywhere text-body-medium text-on-surface-variant">
									{each.email}
								</p>
							)}
						</div>
						<p className="text-label-large text-on-surface-variant">{ROLE_LABELS[each.role]}</p>
						{(each.rolesToGive.length > 0 || each.canRemove) && (
							<MenuTrigger>
								<IconButton label={`Actions for ${each.name}`}>
									<MoreVertIcon />
								</IconButton>
								<Menu
									onAction={(chosen) => {
										setMember(each);
										setTask(chosen === "role" ? "role" : "remove");
									}}
								>
									{each.rolesToGive.length > 0 ? <MenuItem id="role">Change role</MenuItem> : null}
									{each.canRemove ? (
										<MenuItem id="remove">Remove from organisation</MenuItem>
									) : null}
								</Menu>
							</MenuTrigger>
						)}
					</li>
				))}
			</ul>
			{alone && (
				<p className="mt-4 text-body-medium text-on-surface-variant">
					You are the only one here. Invite a person and they get an email with a link to join. The
					link works once and expires after {INVITATION_DAYS} days.
				</p>
			)}

			{invitations && invitations.length > 0 && (
				<section aria-labelledby="invitations" className="mt-8">
					<h2 id="invitations" className="text-title-large">
						Invitations
					</h2>
					<p className="mt-2 text-body-medium text-on-surface-variant">
						Sent and not yet accepted.
					</p>
					<ul aria-labelledby="invitations" className="mt-4 flex flex-col gap-2">
						{invitations.map((each) => (
							<li key={each.id} className={ROW}>
								<div className="min-w-0 flex-1">
									<p className="wrap-anywhere text-body-large">{each.email}</p>
									<p className="text-body-medium text-on-surface-variant">
										Invited as {AS_ROLE[each.role]}. Expires{" "}
										{expires.format(new Date(each.expiresAt))}.
									</p>
								</div>
								{canCancel && (
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
								)}
							</li>
						))}
					</ul>
				</section>
			)}

			<section aria-labelledby="leave" className="mt-8">
				<h2 id="leave" className="text-title-large">
					Leave organisation
				</h2>
				<p className="mt-2 text-body-medium text-on-surface-variant">
					You stop being a member of {organisation.name} and can no longer open it. Your account
					stays.
				</p>
				<div className="mt-4">
					<Button variant="outlined" onPress={() => setTask("leave")}>
						Leave organisation
					</Button>
				</div>
			</section>

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
				<RoleChoice roles={InvitedRole.options} defaultValue="member" />
			</FormSheet>

			<FormSheet
				title={`Change the role of ${member?.name ?? "this member"}`}
				intent="role"
				submitLabel="Save"
				isOpen={task === "role"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="memberId" value={member?.id ?? ""} />
				{/* Keyed by the member, so the choice starts at the role they hold. */}
				<RoleChoice
					key={member?.id}
					roles={member?.rolesToGive ?? []}
					defaultValue={member?.role ?? "member"}
				/>
			</FormSheet>

			<FormSheet
				title={`Remove ${member?.name ?? "this member"}?`}
				intent="remove"
				submitLabel="Remove"
				isOpen={task === "remove"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="memberId" value={member?.id ?? ""} />
				<p>
					They stop being a member of {organisation.name} and can no longer open it. Their account
					stays, and you can invite them again.
				</p>
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

			<FormSheet
				title={`Leave ${organisation.name}?`}
				intent="leave"
				submitLabel="Leave"
				isOpen={task === "leave"}
				onClose={close}
			>
				<p>
					You will no longer be able to open {organisation.name}. To come back, an owner or an admin
					has to invite you.
				</p>
			</FormSheet>
		</>
	);
}

/** The role to give, each with what it may do. */
function RoleChoice({ roles, defaultValue }: { roles: readonly Role[]; defaultValue: Role }) {
	return (
		<RadioGroup label="Role" name="role" defaultValue={defaultValue} isRequired>
			{roles.map((role) => (
				<Radio key={role} value={role}>
					<span className="py-2">
						<span className="block">{ROLE_LABELS[role]}</span>
						<span className="block text-body-medium text-on-surface-variant">
							{ROLE_MEANINGS[role]}
						</span>
					</span>
				</Radio>
			))}
		</RadioGroup>
	);
}
