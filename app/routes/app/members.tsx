import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { parseRequest } from "~/lib/validate";
import { changeRole, listMembers, removeMember } from "~/organisations/api.server";
import { membershipContext } from "~/organisations/membership.server";
import { done, refused, unavailable } from "~/organisations/outcome.server";
import { AS_ROLE, nameOrEmail, ROLE_LABELS } from "~/organisations/people";
import { NEEDS_AN_OWNER, NOT_ALLOWED } from "~/organisations/problems";
import { allows, mayRemove, Role, rolesToGive } from "~/organisations/roles";
import { destination, destinationPath, invitationsPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/members";
import { FormSheet } from "./FormSheet";
import { RoleChoice } from "./RoleChoice";
import { useOrganisation } from "./useOrganisation";

// The people in an organisation, a page of Team, with the actions the person's
// role allows and no others. Leaving out a control is a courtesy: the server
// decides every time one is used. Invitations are the page beside it; leaving
// the organisation is on My account.

const TITLE = "Members";

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** Everyone in the organisation, each with what the person may do to them. */
export async function loader({ request, context }: Route.LoaderArgs) {
	const { organisation, role, user } = context.get(membershipContext);
	const members = await listMembers(request, organisation.id);
	if (!members.ok) throw unavailable(members);

	return {
		canInvite: allows(role, { invitation: ["create"] }),
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
	};
}

const Id = z.string().min(1).max(64);

/** Each thing this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("role"), memberId: Id, role: Role }),
	z.object({ intent: z.literal("remove"), memberId: Id }),
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
	}
}

type Member = Route.ComponentProps["loaderData"]["members"][number];

/** The sheets of this page. One is open at a time. */
type Task = "role" | "remove";

export default function Members({ loaderData }: Route.ComponentProps) {
	const { members, canInvite } = loaderData;
	const organisation = useOrganisation();

	const [task, setTask] = useState<Task | null>(null);
	// Whom the open sheet is about. Kept after it closes, so the sheet goes on
	// saying the same thing while it leaves.
	const [member, setMember] = useState<Member | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	return (
		<>
			<p>
				<Link to={destinationPath(organisation.slug, "team")} className={TEXT_LINK}>
					{destination("team").label}
				</Link>
			</p>
			<div className="mt-4">
				<PageHeading>{TITLE}</PageHeading>
			</div>
			<PageLead>The people in {organisation.name} and what each of them may do.</PageLead>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<div className="max-w-200">
				<div className="mt-10">
					<Ledger heading="Members" note={members.length}>
						<LedgerRows label="Members">
							{members.map((each) => (
								<LedgerRow
									key={each.id}
									title={
										<span className="wrap-anywhere">
											{each.name}
											{each.isYou && <span className="text-on-surface-variant"> (you)</span>}
										</span>
									}
									detail={
										each.name !== each.email && <span className="wrap-anywhere">{each.email}</span>
									}
									value={
										<span className="text-label-large text-on-surface-variant">
											{ROLE_LABELS[each.role]}
										</span>
									}
									action={
										(each.rolesToGive.length > 0 || each.canRemove) && (
											<MenuTrigger>
												<Button variant="text" aria-label={`Actions for ${each.name}`}>
													Actions
												</Button>
												<Menu
													onAction={(chosen) => {
														setMember(each);
														setTask(chosen === "role" ? "role" : "remove");
													}}
												>
													{each.rolesToGive.length > 0 ? (
														<MenuItem id="role">Change role</MenuItem>
													) : null}
													{each.canRemove ? (
														<MenuItem id="remove">Remove from organisation</MenuItem>
													) : null}
												</Menu>
											</MenuTrigger>
										)
									}
								/>
							))}
						</LedgerRows>
					</Ledger>
				</div>
				{canInvite && (
					<p className="mt-4 max-w-160 text-body-medium text-on-surface-variant">
						{members.length === 1 && "You are the only one here. "}People join by invitation, from{" "}
						<Link to={invitationsPath(organisation.slug)} className={TEXT_LINK}>
							Invitations
						</Link>
						.
					</p>
				)}
			</div>

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
		</>
	);
}
