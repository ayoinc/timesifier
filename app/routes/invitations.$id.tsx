import { data, Form, Link, redirect, redirectDocument, useNavigation } from "react-router";
import * as z from "zod";

import { getSession } from "~/auth/auth.server";
import { Button } from "~/components/Button";
import { parseRequest } from "~/lib/validate";
import {
	acceptInvitation,
	declineInvitation,
	findInvitation,
	type Refusal,
} from "~/organisations/api.server";
import { AS_ROLE, nameOrEmail } from "~/organisations/people";
import { TOO_MANY_ATTEMPTS } from "~/organisations/problems";
import { invitationPath, signInPath } from "~/routes/auth/paths";
import { APP_PATH, organisationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { OUTSIDE_FRAME, ProductName } from "~/shell/Outside";
import { PageHeading } from "~/shell/PageHeading";
import type { Route } from "./+types/invitations.$id";
import { SignedInAs } from "./app/SignedInAs";

// The page an invitation's link opens. It is outside `/app/<slug>`: the person
// it is for is not a member yet.
//
// It has two faces. To the person the invitation was sent to, while it can
// still be accepted, it names the organisation and asks one question. To
// everybody else, and for an invitation that was used, declined, cancelled or
// has expired, or whose sender may no longer invite, or that never existed, it
// is one page with status 410 that does not say which of those it is
// (docs/security.md, "Organisations and roles").

const GONE_TITLE = "This invitation is no longer valid";

export function meta({ loaderData }: Route.MetaArgs) {
	const title = loaderData?.invitation
		? `Join ${loaderData.invitation.organisation.name}`
		: GONE_TITLE;
	return [{ title: `${title} · Timesifier` }];
}

/**
 * The same answer for every invitation that cannot be accepted by the person
 * asking: nothing about the invitation, and status 410. It says whose session
 * this is, which the person already knows and may have got wrong. The server's
 * limiter is the one other refusal, and it is passed on as itself.
 */
function gone(refusal: Refusal, email: string) {
	if (refusal.status === 429) throw data(TOO_MANY_ATTEMPTS, { status: 429 });
	return data({ invitation: null, email }, { status: 410 });
}

/**
 * The signed-in person behind the request. Anybody else is sent to sign in and
 * brought back here afterwards, as a whole page load: the sign-in page has a
 * policy of its own (docs/security.md, "Turnstile").
 */
async function requirePerson(request: Request, id: string) {
	const signedIn = await getSession(request);
	if (!signedIn) throw redirectDocument(signInPath(invitationPath(id)));
	return signedIn;
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const { email } = (await requirePerson(request, params.id)).user;

	const invitation = await findInvitation(request, params.id);
	if (!invitation.ok) return gone(invitation, email);

	const { organisation, role, inviter } = invitation.data;
	return {
		email,
		invitation: {
			organisation: { name: organisation.name },
			role,
			inviter: {
				name: nameOrEmail(inviter),
				// Shown beside a name, so the person can tell who it is.
				email: inviter.name?.trim() ? inviter.email : null,
			},
		},
	};
}

const form = z.object({ intent: z.enum(["join", "decline"]) });

/**
 * Joins the organisation and goes to it, or declines and goes to `/app`. The
 * server decides whether the invitation is this person's to answer; where it
 * is not, the answer is the same 410.
 */
export async function action({ request, params }: Route.ActionArgs) {
	const { intent } = await parseRequest(request, form);
	const { email } = (await requirePerson(request, params.id)).user;

	if (intent === "decline") {
		const declined = await declineInvitation(request, params.id);
		return declined.ok ? redirect(APP_PATH) : gone(declined, email);
	}

	// Read first for the organisation's address: accepting does not give it.
	const invitation = await findInvitation(request, params.id);
	if (!invitation.ok) return gone(invitation, email);
	const accepted = await acceptInvitation(request, params.id);
	return accepted.ok
		? redirect(organisationPath(invitation.data.organisation.slug))
		: gone(accepted, email);
}

const LEAD = "text-body-large text-on-surface-variant";

export default function InvitationPage({ loaderData, params }: Route.ComponentProps) {
	const { invitation } = loaderData;
	const busy = useNavigation().state !== "idle";

	if (!invitation) {
		return (
			<div className={OUTSIDE_FRAME}>
				<ProductName />
				<main className="flex flex-col gap-6">
					<PageHeading>{GONE_TITLE}</PageHeading>
					<p className={LEAD}>
						It may have been used or cancelled, it may have expired, or it may have been sent to
						another address. Ask the person who invited you to send a new one.
					</p>
					<p>
						<Link to={APP_PATH} className={TEXT_LINK}>
							Go to Timesifier
						</Link>
					</p>
				</main>
				{/* An invitation sent to another address is the commonest reason to be
				    here: the way out leads back to this page, signed in as somebody else. */}
				<SignedInAs
					email={loaderData.email}
					wayOut="Use a different email"
					next={invitationPath(params.id)}
				/>
			</div>
		);
	}

	const { organisation, role, inviter } = invitation;
	return (
		<div className={OUTSIDE_FRAME}>
			<ProductName />
			<main className="flex flex-col gap-6">
				<PageHeading>Join {organisation.name}?</PageHeading>
				<p className={LEAD}>
					{inviter.name}
					{inviter.email && ` (${inviter.email})`} invited you to join {organisation.name} as{" "}
					{AS_ROLE[role]}.
				</p>
				<Form
					method="post"
					className="flex flex-wrap gap-2"
					onSubmit={(event) => {
						if (busy) event.preventDefault();
					}}
				>
					<Button type="submit" name="intent" value="join">
						Join
					</Button>
					<Button type="submit" name="intent" value="decline" variant="text">
						Decline
					</Button>
				</Form>
			</main>
		</div>
	);
}
