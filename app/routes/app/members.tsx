import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import * as z from "zod";

import { changes, record, recordStatement } from "~/activity/activity.server";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { mayMarkContractor } from "~/contractors/contractors";
import { type Contract, spansOf } from "~/contracts/contracts";
import { contractsOf } from "~/contracts/read.server";
import { type ContractSpan, contractorOn, spanOn } from "~/contracts/spans";
import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import { isAdministrator } from "~/organisations/access";
import { changeRole, removeMember } from "~/organisations/api.server";
import { membershipContext } from "~/organisations/membership.server";
import { declined, done, refused } from "~/organisations/outcome.server";
import { AS_ROLE, nameOrEmail, ROLE_LABELS } from "~/organisations/people";
import { NEEDS_AN_OWNER, NOT_ALLOWED, type Outcome } from "~/organisations/problems";
import { allows, mayRemove, Role, rolesToGive } from "~/organisations/roles";
import { contractPath, invitationsPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { membersByJoining } from "~/teams/people.server";
import { TeamTabs } from "~/teams/TeamTabs";
import { addDays, type Day, dayOf } from "~/time/calendar";
import { formatDayOfMonth, formatWeekday } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";

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
export async function loader({ context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const { organisation, role, user } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const seesContracts = isAdministrator(role);
	const [members, rows, contracts, zone] = await Promise.all([
		membersByJoining(scope),
		scope.memberships.select(),
		seesContracts ? contractsOf(scope) : new Map<string, Contract[]>(),
		zoneOfMember(membership),
	]);
	const contractors = new Set(rows.filter((row) => row.isContractor).map(({ id }) => id));
	const today = dayOf(Date.now(), zone);

	return {
		canInvite: allows(role, { invitation: ["create"] }),
		members: members.map((member) => {
			const isYou = member.userId === user.id;
			// A contract that covers today says whether they are a contractor (TS-098a); the mark, when none does.
			const theirs = spansOf(contracts.get(member.userId) ?? []);
			const covering = spanOn(theirs, today);
			return {
				id: member.id,
				userId: member.userId,
				name: nameOrEmail(member.user),
				email: member.user.email,
				role: member.role,
				isYou,
				isContractor: contractorOn(theirs, contractors.has(member.id), today),
				contract: seesContracts ? contractWords(covering, today) : null,
				// A person's own way out is leaving, and their own role is another's to change.
				rolesToGive: isYou ? [] : rolesToGive(role, member.role),
				canRemove: !isYou && mayRemove(role, member.role),
				canMarkContractor: !covering && mayMarkContractor(role, member.role, isYou),
			};
		}),
	};
}

/**
 * What Members says of a person's contract to those who change contracts, as
 * the link to it: none today, a fixed term's end within 60 days, or that
 * there is one.
 */
function contractWords(covering: ContractSpan | undefined, today: Day): string {
	if (!covering) return "No contract";
	if (covering.endsOn && covering.endsOn <= addDays(today, CONTRACT_ENDS_WITHIN_DAYS)) {
		return `Contract ends ${formatWeekday(covering.endsOn, "short")} ${formatDayOfMonth(covering.endsOn)}`;
	}
	return "Contract";
}

/** How near the end of a contract Members says when it ends. */
const CONTRACT_ENDS_WITHIN_DAYS = 60;

/** Why a person a contract covers today is not marked by hand. */
const CONTRACT_DECIDES =
	"Their contract says whether they are a contractor. Change it on their Contract page.";

const Id = z.string().min(1).max(64);

/** Each thing this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("role"), memberId: Id, role: Role }),
	z.object({ intent: z.literal("remove"), memberId: Id }),
	// Employee or contractor (TS-079). It grants nothing.
	z.object({
		intent: z.literal("contractor"),
		memberId: Id,
		isContractor: z.enum(["true", "false"]).transform((value) => value === "true"),
	}),
]);

/**
 * Asks the server for one of them, in the organisation the layout read from
 * the address; no form names an organisation. The server allows or refuses by
 * the person's role, and what it refuses comes back as a sentence. A change it
 * makes is recorded in the activity log, about the member it was made to.
 */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	const { organisation, role, user } = membership;
	const { id } = organisation;
	const scope = organisationScope(env.DB, id);
	const [member] = await scope.memberships.select((m) => eq(m.id, input.memberId), { limit: 1 });
	const subject = { type: "membership", id: input.memberId, ownerId: member?.userId } as const;

	switch (input.intent) {
		case "role": {
			const changed = await changeRole(request, id, { memberId: input.memberId, role: input.role });
			if (!changed.ok) return refused(changed);
			if (member && member.role !== input.role) {
				await record(
					scope,
					user.id,
					"membership.role_changed",
					subject,
					changes(member, { role: input.role }, ["role"]),
				);
			}
			return done(`Role changed. They are now ${AS_ROLE[input.role]}.`);
		}

		case "remove": {
			const removed = await removeMember(request, id, input.memberId);
			if (removed.ok) {
				await record(
					scope,
					user.id,
					"membership.removed",
					subject,
					changes(member ?? null, null, ["role", "isContractor"]),
				);
				return done("Member removed. They can no longer open this organisation.");
			}
			// The server has one answer here for two refusals: an owner removed by
			// somebody who is not one, and the last owner removed by anybody. Its
			// code speaks of leaving, which this is not.
			return refused(removed, {
				YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER:
					role === "owner" ? NEEDS_AN_OWNER : NOT_ALLOWED,
			});
		}

		case "contractor": {
			// Marked by owners and admins alone; anybody else learns nothing of the member.
			if (!isAdministrator(role)) return declined(NOT_ALLOWED, 403);
			if (!member) return refused({ ok: false, status: 404, code: "MEMBER_NOT_FOUND" });
			if (!mayMarkContractor(role, Role.parse(member.role), member.userId === user.id)) {
				return declined(NOT_ALLOWED, 403);
			}
			// While a contract covers today, its kind says whether they are a contractor.
			const today = dayOf(Date.now(), await zoneOfMember(membership));
			const theirs = (await contractsOf(scope, [member.userId])).get(member.userId) ?? [];
			if (spanOn(theirs, today)) return declined(CONTRACT_DECIDES, 409);
			if (member.isContractor !== input.isContractor) {
				await scope.batch([
					scope.memberships.statements.update(
						{ isContractor: input.isContractor, updatedAt: new Date() },
						(m) => eq(m.id, member.id),
					),
					recordStatement(
						scope,
						user.id,
						"membership.contractor_changed",
						subject,
						changes(member, { isContractor: input.isContractor }, ["isContractor"]),
					),
				]);
			}
			return done(input.isContractor ? "Marked as a contractor." : "Marked as an employee.");
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

	// Marking a member as a contractor or an employee needs no sheet: it is
	// undone by the same menu. What the server said is read out like a sheet's.
	const marking = useFetcher<Outcome>();
	const marked = marking.state === "idle" ? marking.data : undefined;
	useEffect(() => {
		if (marked) setSaid(marked.ok ? marked.said : marked.problem);
	}, [marked]);

	return (
		<>
			<PageHeading>{TITLE}</PageHeading>
			<PageLead>The people in {organisation.name} and what each of them may do.</PageLead>
			<TeamTabs slug={organisation.slug} current="members" />
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
										(each.name !== each.email || each.contract) && (
											<span className="wrap-anywhere">
												{each.name !== each.email && each.email}
												{each.name !== each.email && each.contract && " · "}
												{each.contract && (
													<Link
														to={contractPath(organisation.slug, each.userId)}
														className={TEXT_LINK}
														aria-label={`${each.contract}: the contract of ${each.name}`}
													>
														{each.contract}
													</Link>
												)}
											</span>
										)
									}
									value={
										<span className="text-label-large text-on-surface-variant">
											{ROLE_LABELS[each.role]}
											{each.isContractor && " · Contractor"}
										</span>
									}
									action={
										(each.rolesToGive.length > 0 || each.canRemove || each.canMarkContractor) && (
											<MenuTrigger>
												<Button variant="text" aria-label={`Actions for ${each.name}`}>
													Actions
												</Button>
												<Menu
													onAction={(chosen) => {
														if (chosen === "contractor") {
															marking.submit(
																{
																	intent: "contractor",
																	memberId: each.id,
																	isContractor: String(!each.isContractor),
																},
																{ method: "post" },
															);
															return;
														}
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
													{each.canMarkContractor ? (
														<MenuItem id="contractor">
															{each.isContractor ? "Mark as employee" : "Mark as contractor"}
														</MenuItem>
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
