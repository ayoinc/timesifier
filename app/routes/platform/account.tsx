import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link } from "react-router";
import * as z from "zod";

import { sendEmail } from "~/auth/email.server";
import { invitationEmail } from "~/auth/invitation-email";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { platformData } from "~/db";
import { parseRequest } from "~/lib/validate";
import { declined, done } from "~/organisations/outcome.server";
import { nameOrEmail, ROLE_LABELS } from "~/organisations/people";
import { InvitedRole, Role } from "~/organisations/roles";
import { deletePersonAccount } from "~/platform/account-deletion.server";
import { consoleDay, consoleMoment, REASON_MISSING, reasonOf } from "~/platform/console-words";
import { dataExportEmail } from "~/platform/emails";
import { platformLog } from "~/platform/events.server";
import { notFound, platformOwnerContext } from "~/platform/guard.server";
import { mailOrigin } from "~/platform/mail.server";
import { organisationConsolePath } from "~/platform/paths";
import { FormSheet } from "~/routes/app/FormSheet";
import { invitationPath } from "~/routes/auth/paths";
import { APP_PATH, accountPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";

import type { Route } from "./+types/account";
import { EventLedger, ReasonField } from "./ConsoleParts";

// One account in the platform console (TS-099): who the person is, the
// organisations they are in and as what, their recent sign-ins and waiting
// invitations, and the platform's own steps about them. Nothing an
// organisation keeps is read here (app/db/platform.ts).
//
// The tools below help a person who wrote in: end their sessions, close or
// restore the account, send an invitation again, send the link to their own
// data, or delete the account on their request. Each is confirmed in its
// sheet, needs a reason, and is recorded in the platform log with it.

/** How long sign-ins are kept: app/db/platform.ts deletes older ones. */
const SIGN_INS_KEPT_DAYS = 90;

/** What may be typed to confirm a deletion: an address, compared and never used as one. */
const Confirmation = z.string().max(254);

/** Each tool of the page. A reason is checked after parsing, so its refusal is a sentence. */
const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("revoke-sessions"), reason: z.string().optional() }),
	z.object({ intent: z.literal("close"), reason: z.string().optional() }),
	z.object({ intent: z.literal("restore"), reason: z.string().optional() }),
	z.object({
		intent: z.literal("resend-invitation"),
		invitationId: z.string().min(1).max(64),
		reason: z.string().optional(),
	}),
	z.object({ intent: z.literal("send-export-link"), reason: z.string().optional() }),
	z.object({
		intent: z.literal("delete"),
		confirmation: Confirmation,
		reason: z.string().optional(),
	}),
]);

function roleWords(role: string): string {
	const known = Role.safeParse(role);
	return known.success ? ROLE_LABELS[known.data] : role;
}

/** "1 receipt", "2 receipts". */
function counted(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

export function meta({ loaderData }: Route.MetaArgs) {
	return [{ title: `${loaderData ? loaderData.account.title : "Account"} · Timesifier` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
	const owner = context.get(platformOwnerContext);
	const account = await platformData.platformAccount(env.DB, params.accountId, new Date());
	if (!account) throw notFound();
	return {
		account: {
			id: account.id,
			// Without a name, the address is what the page and its sheets call them.
			title: account.name.trim() || account.email,
			named: account.name.trim() !== "",
			email: account.email,
			joined: consoleDay(account.createdAt),
			closed: account.closedAt ? consoleDay(account.closedAt) : null,
			deleted: platformData.isDeletedEmail(account.email),
			isYou: account.id === owner.user.id,
			newsletter: account.newsletter,
			announcements: account.announcements,
			sessions: account.sessions,
		},
		organisations: account.organisations.map((organisation) => ({
			id: organisation.id,
			name: organisation.name,
			role: roleWords(organisation.role),
		})),
		signIns: account.signIns.map((signIn) => ({
			id: signIn.id,
			device: signIn.device,
			when: consoleMoment(signIn.createdAt),
		})),
		invitations: account.invitations.map((invitation) => ({
			id: invitation.id,
			organisation: invitation.organisation,
			role: roleWords(invitation.role),
			until: consoleDay(invitation.expiresAt),
		})),
		events: await platformLog({ subjectId: account.id, limit: 50 }),
	};
}

export async function action({ request, params, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const owner = context.get(platformOwnerContext);
	const now = new Date();
	const account = await platformData.platformAccount(env.DB, params.accountId, now);
	if (!account) throw notFound();
	const reason = reasonOf(input.reason);
	if (!reason) return declined(REASON_MISSING);
	const name = nameOrEmail(account);

	const record = (action: string, detail: Record<string, string | number> = {}) =>
		platformData.recordPlatformEvent(env.DB, {
			actorId: owner.user.id,
			action,
			subjectType: "account",
			subjectId: account.id,
			reason,
			detail,
		});

	// A deleted account keeps its row, under an address that identifies nobody,
	// so the organisations' records still add up. Nothing of the person is left
	// to reopen, write to or delete again.
	if (platformData.isDeletedEmail(account.email)) {
		return declined(
			input.intent === "restore"
				? "A deleted account cannot be restored. Nothing of the person is left to restore it with."
				: "This account was deleted on request. Nothing of the person is left to act on.",
			409,
		);
	}

	switch (input.intent) {
		case "revoke-sessions": {
			const ended = await platformData.revokeSessions(env.DB, account.id);
			await record("account.sessions_revoked", { sessions: ended });
			return done(`Ended ${counted(ended, "session")}.`);
		}

		case "close": {
			if (account.id === owner.user.id) {
				return declined("You cannot close your own account from the console.", 403);
			}
			if (account.closedAt) return declined("This account is already closed.", 409);
			await platformData.setAccountClosed(env.DB, account.id, now);
			await record("account.closed");
			return done(
				`Closed ${name}'s account. Every session ended, and they cannot sign in until it is restored.`,
			);
		}

		case "restore": {
			if (!account.closedAt) return declined("This account is not closed.", 409);
			await platformData.setAccountClosed(env.DB, account.id, null);
			await record("account.restored");
			return done(`Restored ${name}'s account. They can sign in again.`);
		}

		case "resend-invitation": {
			const invitation = await platformData.pendingInvitation(env.DB, input.invitationId, now);
			const role = InvitedRole.safeParse(invitation?.role);
			if (
				!invitation ||
				!role.success ||
				invitation.email.toLowerCase() !== account.email.toLowerCase()
			) {
				return declined(
					"That invitation is no longer waiting: it was accepted or cancelled, or it ran out.",
					409,
				);
			}
			// The very message the organisation's own invitation sent, with the
			// same link: the platform makes no invitation of its own.
			const message = invitationEmail({
				link: `${mailOrigin(request)}${invitationPath(invitation.id)}`,
				organisationName: invitation.organisation,
				inviterEmail: invitation.inviterEmail,
				role: role.data,
			});
			if (!(await sendEmail({ to: invitation.email, ...message }))) {
				return declined("The invitation could not be sent. Nothing was recorded. Try again.", 500);
			}
			await record("account.invitation_resent", { invitationId: invitation.id });
			return done(`Sent ${name} the invitation to ${invitation.organisation} again.`);
		}

		case "send-export-link": {
			if (account.closedAt) {
				return declined(
					"This account is closed, so they could not sign in to download their data. Restore it first.",
					409,
				);
			}
			// A link to My account, where the person downloads their data after
			// signing in. The platform never makes or sees the download.
			const [first] = account.organisations;
			const link = `${mailOrigin(request)}${first ? accountPath(first.slug) : APP_PATH}`;
			if (!(await sendEmail({ to: account.email, ...dataExportEmail(link) }))) {
				return declined("The email could not be sent. Nothing was recorded. Try again.", 500);
			}
			await record("account.export_link_sent");
			return done(`Sent ${name} the link to download their data.`);
		}

		case "delete": {
			if (account.id === owner.user.id) {
				return declined("You cannot delete your own account from the console.", 403);
			}
			if (input.confirmation.trim().toLowerCase() !== account.email.toLowerCase()) {
				return declined("That is not the account's address.");
			}
			const deleted = await deletePersonAccount(account.id);
			if (!deleted.ok) {
				const names = new Intl.ListFormat("en-GB", { type: "conjunction" }).format(
					deleted.blocking.map((organisation) => organisation.name),
				);
				return declined(
					`${name} is the only owner of ${names}, which ${deleted.blocking.length === 1 ? "has" : "have"} other people in ${deleted.blocking.length === 1 ? "it" : "them"}. Someone else must be made an owner first. Nothing was deleted.`,
					409,
				);
			}
			await record("account.deleted", {
				receiptsDeleted: deleted.receiptsDeleted,
				organisationsDeleted: deleted.organisationsDeleted,
			});
			return done(
				`Deleted the account. ${counted(deleted.receiptsDeleted, "receipt")} and ${counted(deleted.organisationsDeleted, "organisation")} they were alone in went with it.`,
			);
		}
	}
}

/** The sheet open, if any. A resent invitation names which one. */
type Task =
	| { tool: "revoke-sessions" | "close" | "restore" | "send-export-link" | "delete" }
	| { tool: "resend-invitation"; invitationId: string; organisation: string };

export default function Account({ loaderData }: Route.ComponentProps) {
	const { account, organisations, signIns, invitations, events } = loaderData;
	const [task, setTask] = useState<Task | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	// The address typed to confirm a deletion. The confirmation waits until it is the address.
	const [typed, setTyped] = useState("");
	const close = () => setTask(null);
	const open = (tool: Exclude<Task["tool"], "resend-invitation">) => setTask({ tool });

	const state = account.deleted
		? "Deleted on request."
		: account.closed
			? `Closed on ${account.closed}.`
			: "Open.";

	return (
		<>
			<PageHeading>
				<span className="wrap-anywhere">{account.title}</span>
			</PageHeading>
			<PageLead>
				{account.named ? <span className="wrap-anywhere">{account.email}</span> : "No name yet"}.
				Joined {account.joined}. {state}
			</PageLead>
			{/* What the last tool did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section id="account" heading="Account" className="max-w-200">
				<Ledger heading="This account">
					<LedgerRows>
						<LedgerRow
							title={
								account.sessions === 0
									? "Signed in nowhere"
									: `Signed in on ${account.sessions === 1 ? "1 browser or device" : `${account.sessions} browsers or devices`}`
							}
							detail="Sessions that have not ended or run out."
						/>
						<LedgerRow
							title={`Product announcements ${account.announcements ? "on" : "off"}, newsletter ${account.newsletter ? "on" : "off"}`}
							detail="The mail they chose. Only they change it, on My account or from a message."
						/>
					</LedgerRows>
				</Ledger>
			</Section>

			<Section
				id="organisations"
				heading="Organisations"
				lead="Where they are a member, and as what."
				className="max-w-200"
			>
				{organisations.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">
						They are not a member of any organisation.
					</p>
				) : (
					<Ledger heading="Member of" note={organisations.length}>
						<LedgerRows>
							{organisations.map((organisation) => (
								<LedgerRow
									key={organisation.id}
									title={
										<Link
											to={organisationConsolePath(organisation.id)}
											className={`${TEXT_LINK} wrap-anywhere`}
										>
											{organisation.name}
										</Link>
									}
									detail={organisation.role}
								/>
							))}
						</LedgerRows>
					</Ledger>
				)}
			</Section>

			<Section
				id="invitations"
				heading="Waiting invitations"
				lead="Invitations to this address that have not been accepted and have not run out."
				className="max-w-200"
			>
				{invitations.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">No invitation is waiting.</p>
				) : (
					<Ledger heading="Invited to" note={invitations.length}>
						<LedgerRows>
							{invitations.map((invitation) => (
								<LedgerRow
									key={invitation.id}
									title={<span className="wrap-anywhere">{invitation.organisation}</span>}
									detail={`As ${invitation.role.toLowerCase()}, until ${invitation.until}.`}
									action={
										!account.deleted && (
											<Button
												variant="text"
												aria-label={`Send the invitation to ${invitation.organisation} again`}
												onPress={() =>
													setTask({
														tool: "resend-invitation",
														invitationId: invitation.id,
														organisation: invitation.organisation,
													})
												}
											>
												Send again
											</Button>
										)
									}
								/>
							))}
						</LedgerRows>
					</Ledger>
				)}
			</Section>

			<Section
				id="sign-ins"
				heading="Sign-ins"
				lead={`The latest 20, kept for ${SIGN_INS_KEPT_DAYS} days. Only the kind of browser is kept, never where the sign-in came from.`}
				className="max-w-200"
			>
				{signIns.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">
						No sign-in in the last {SIGN_INS_KEPT_DAYS} days.
					</p>
				) : (
					<Ledger heading="Signed in" note={signIns.length}>
						<LedgerRows>
							{signIns.map((signIn) => (
								<LedgerRow key={signIn.id} title={signIn.device} detail={signIn.when} />
							))}
						</LedgerRows>
					</Ledger>
				)}
			</Section>

			<Section
				id="tools"
				heading="Help with this account"
				lead="Each asks for a reason, which is kept in the platform log with your name."
				className="max-w-200"
			>
				{account.deleted ? (
					<p className="text-body-large text-on-surface-variant">
						This account was deleted on request. Nothing of the person is left to act on.
					</p>
				) : (
					<Ledger heading="Tools">
						<LedgerRows>
							<LedgerRow
								title="End every session"
								detail="Signs them out on every browser and device. They can sign in again."
								action={
									<Button variant="outlined" onPress={() => open("revoke-sessions")}>
										End sessions
									</Button>
								}
							/>
							<LedgerRow
								title="Send the link to their data"
								detail="Emails them where to download everything Timesifier holds about them, after they sign in. The console never sees it."
								action={
									<Button
										variant="outlined"
										isDisabled={account.closed !== null}
										onPress={() => open("send-export-link")}
									>
										Send link
									</Button>
								}
							/>
							{account.isYou ? (
								<LedgerRow
									title="Close or delete the account"
									detail="This is your own account. Nobody closes or deletes their own account from the console."
								/>
							) : (
								<>
									{account.closed ? (
										<LedgerRow
											title="Restore the account"
											detail="They can sign in again. Their organisations and data are as they were."
											action={
												<Button variant="outlined" onPress={() => open("restore")}>
													Restore
												</Button>
											}
										/>
									) : (
										<LedgerRow
											title="Close the account"
											detail="Ends every session and stops them signing in. Nothing is deleted, and it can be restored."
											action={
												<Button variant="outlined-danger" onPress={() => open("close")}>
													Close
												</Button>
											}
										/>
									)}
									<LedgerRow
										title="Delete the account"
										detail="On their request only. Their name, address, sessions and memberships go; the organisations' records stay under “Deleted person”. It cannot be undone."
										action={
											<Button
												variant="outlined-danger"
												onPress={() => {
													setTyped("");
													open("delete");
												}}
											>
												Delete
											</Button>
										}
									/>
								</>
							)}
						</LedgerRows>
					</Ledger>
				)}
			</Section>

			<Section
				id="log"
				heading="Platform log"
				lead="What platform owners did to this account, newest first."
				className="max-w-200"
			>
				{events.length === 0 ? (
					<p className="text-body-large text-on-surface-variant">Nothing yet.</p>
				) : (
					<EventLedger heading="Steps" events={events} hideSubject />
				)}
			</Section>

			<FormSheet
				title="End every session?"
				intent="revoke-sessions"
				submitLabel="End sessions"
				isOpen={task?.tool === "revoke-sessions"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					{account.title} is signed out on every browser and device at once. They can sign in again
					with a code.
				</p>
				<ReasonField />
			</FormSheet>

			<FormSheet
				title="Send the link to their data?"
				intent="send-export-link"
				submitLabel="Send link"
				isOpen={task?.tool === "send-export-link"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					An email goes to <span className="wrap-anywhere">{account.email}</span> with a link to My
					account, where they download their data after signing in. Nothing of their data is in the
					email, and the console never sees it.
				</p>
				<ReasonField />
			</FormSheet>

			<FormSheet
				title={`Close ${account.title}'s account?`}
				intent="close"
				submitLabel="Close account"
				submitVariant="danger"
				isOpen={task?.tool === "close"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					Every session ends and they cannot sign in until the account is restored. Nothing is
					deleted, and their organisations keep them as members.
				</p>
				<ReasonField />
			</FormSheet>

			<FormSheet
				title={`Restore ${account.title}'s account?`}
				intent="restore"
				submitLabel="Restore account"
				isOpen={task?.tool === "restore"}
				onClose={close}
				onDone={setSaid}
			>
				<p>They can sign in again, and everything is as it was before it was closed.</p>
				<ReasonField />
			</FormSheet>

			<FormSheet
				title="Send the invitation again?"
				intent="resend-invitation"
				submitLabel="Send again"
				isOpen={task?.tool === "resend-invitation"}
				onClose={close}
				onDone={setSaid}
			>
				{task?.tool === "resend-invitation" && (
					<>
						<input type="hidden" name="invitationId" value={task.invitationId} />
						<p>
							The invitation to {task.organisation} goes to{" "}
							<span className="wrap-anywhere">{account.email}</span> again, as the organisation
							first sent it. It still runs out on the same day.
						</p>
					</>
				)}
				<ReasonField />
			</FormSheet>

			<FormSheet
				title={`Delete ${account.title}'s account?`}
				intent="delete"
				submitLabel="Delete account"
				submitVariant="danger"
				isSubmitDisabled={typed.trim().toLowerCase() !== account.email.toLowerCase()}
				isOpen={task?.tool === "delete"}
				onClose={close}
				onDone={setSaid}
			>
				<p>
					Only when they asked for it. Their name, address, sessions, sign-ins, mail choices and
					memberships go, with any organisation they are alone in. The organisations' time and
					expenses stay under “Deleted person”; receipts go unless an issued invoice holds them. It
					cannot be undone. To confirm, type their address:{" "}
					<strong className="wrap-anywhere text-on-surface">{account.email}</strong>
				</p>
				<TextField
					label="Their address"
					name="confirmation"
					autoComplete="off"
					value={typed}
					onChange={setTyped}
					isRequired
					validate={(value) =>
						value.trim().toLowerCase() === account.email.toLowerCase()
							? null
							: "Type the address exactly as it is shown."
					}
				/>
				<ReasonField />
			</FormSheet>
		</>
	);
}
