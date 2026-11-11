import { Document, DocumentSection, Row, Rows } from "~/landing/Document";
import { LINK, PRIVACY_EMAIL, PRIVACY_PATH, pageMeta, TERMS_PATH } from "~/landing/Site";

import type { Route } from "./+types/terms";

// The terms. Like the privacy notice, they say what the application does and
// what it expects, and no more: the limits are the ones docs/security.md gives,
// the roles the ones in BOARD.md under TS-009. Nothing here is a legal promise
// that the repository cannot back.

export function meta(_: Route.MetaArgs) {
	return pageMeta({
		path: TERMS_PATH,
		title: "Terms · Timesifier",
		description:
			"What Timesifier is today, how accounts and organisations work, the limits on its use, and how to leave.",
	});
}

export default function Terms() {
	return (
		<Document
			path={TERMS_PATH}
			title="Terms"
			lead="What Timesifier is today, what an account and an organisation are, the limits on their use, and how to leave. They will change as the product does, and their date with them."
		>
			<DocumentSection id="what" title="What Timesifier is">
				<p>
					Timesifier is a web application for keeping track of time, for one person or a small team.
					It is an early version. Today you can sign in with your email address, create an
					organisation and invite people into it. The timer, the projects and the weekly report that
					the home page shows are being built, and are not in the product yet.
				</p>
				<p>
					Being an early version, it can be unavailable for a time, and what it does will change.
				</p>
			</DocumentSection>

			<DocumentSection id="account" title="Your account">
				<p>
					An account is for one person and stands on an email address that person can read.
					Timesifier has no passwords: you sign in with a code sent to that address, so whoever can
					read the mailbox can sign in. Keep the mailbox your own.
				</p>
				<p>You can sign out of the browser you are using, or end every session you have at once.</p>
			</DocumentSection>

			<DocumentSection id="organisations" title="Organisations">
				<p>
					What you keep in Timesifier belongs to an organisation. The person who creates one is its
					owner, and an organisation always has at least one owner.
				</p>
				<Rows>
					<Row term="Owners">
						Everything an admin can do. An owner can also make another person an owner, change an
						owner's role, and delete the organisation. The last owner cannot leave, be removed or be
						given a lesser role.
					</Row>
					<Row term="Admins">
						Rename the organisation, invite people and cancel invitations, change a role between
						admin and member, and remove anyone except an owner.
					</Row>
					<Row term="Members">See the organisation and who is in it, and leave it.</Row>
				</Rows>
				<p>
					To anyone who is not in it, an organisation answers exactly as one that does not exist.
				</p>
			</DocumentSection>

			<DocumentSection id="limits" title="Limits">
				<p>
					The application holds everyone to the same limits, so that nobody can use it against
					someone else.
				</p>
				<Rows>
					<Row term="Sign-in codes">
						An address is sent at most five codes in an hour. A code works once, for five minutes,
						and stops working after three wrong attempts.
					</Row>
					<Row term="Invitations">
						One person can send at most twenty invitations in 24 hours. An invitation works once,
						for seven days, and only for the address it was sent to.
					</Row>
					<Row term="Organisations">One person can own at most five.</Row>
				</Rows>
				<p>
					Do not invite people who are not expecting it, try to reach an organisation you do not
					belong to, or try to get around these limits.
				</p>
			</DocumentSection>

			<DocumentSection id="price" title="Price">
				<p>
					Timesifier costs nothing today. If that changes, these terms will say so first, with a new
					date.
				</p>
			</DocumentSection>

			<DocumentSection id="leaving" title="Your data, and leaving">
				<p>
					What you put into Timesifier is yours. The{" "}
					<a href={PRIVACY_PATH} className={LINK}>
						privacy notice
					</a>{" "}
					says what is stored, where, and for how long.
				</p>
				<p>
					You can stop using Timesifier whenever you like. To have your account deleted, or to ask
					anything about these terms, write to{" "}
					<a href={`mailto:${PRIVACY_EMAIL}`} className={LINK}>
						{PRIVACY_EMAIL}
					</a>
					.
				</p>
			</DocumentSection>
		</Document>
	);
}
