import { Document, DocumentSection, Row, Rows } from "~/landing/Document";
import {
	LINK,
	PRIVACY_EMAIL,
	PRIVACY_PATH,
	pageMeta,
	rootOrigin,
	TERMS_PATH,
} from "~/landing/Site";

import type { Route } from "./+types/terms";

// The terms. Like the privacy notice, they say what the application does and
// what it expects, and no more: the limits are the ones docs/security.md gives,
// the roles the ones in app/organisations/roles.ts and access.ts. Nothing here
// is a legal promise that the repository cannot back.

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: TERMS_PATH,
		title: "Terms · Timesifier",
		description:
			"What Timesifier is today, how accounts, organisations and roles work, the limits on its use, and how to leave.",
	});
}

/** This version of the terms. */
const VERSION = { date: "2026-11-12", inWords: "12 November 2026" };

export default function Terms() {
	return (
		<Document
			path={TERMS_PATH}
			title="Terms"
			version={VERSION}
			lead="What Timesifier is today, what an account and an organisation are, the limits on their use, and how to leave. They change as the product does, and their date with them."
		>
			<DocumentSection id="what" title="What Timesifier is">
				<p>
					Timesifier is a web application that keeps track of time, for one person or a team. In it
					you track time with a timer or by hand, submit your timesheet for approval, ask for leave,
					and record expenses with their receipts; reports add the time up. Owners, admins and
					Finance also set rates and budgets, and send clients invoices and estimates.
				</p>
				<p>
					It is an early version. It can be unavailable for a time, and what it does will change.
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
					owner, and an organisation always has at least one owner. Each person in it has one role.
				</p>
				<Rows>
					<Row term="Owners">
						Everything an admin can do. An owner can also make another person an owner, change an
						owner's role, and delete the organisation. The last owner cannot leave, be removed or be
						given a lesser role.
					</Row>
					<Row term="Admins">
						Rename the organisation and set how it works; invite people and cancel invitations; make
						anyone but an owner an admin, Finance or a member; remove anyone except an owner; manage
						teams, clients, tasks and the integrations; see everyone's time, expenses and leave, and
						approve timesheets and leave.
					</Row>
					<Row term="Finance">
						See everyone's time and expenses, set rates, and make and send invoices and estimates
						and record their payments. Finance manages no people.
					</Row>
					<Row term="Members">
						Track their own time, submit their timesheet, ask for leave and record their expenses;
						see the organisation's projects and who is in it; leave it.
					</Row>
				</Rows>
				<p>
					Whatever their role, a person an owner or admin makes the manager of a team also sees the
					time, expenses and leave of the people in it, and approves their timesheets and leave, but
					never their own. Nobody changes another person's time entries or expenses. The privacy
					notice says in full who sees what.
				</p>
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
						An address is sent at most five codes in an hour to browsers that have signed in as it
						before, and five to all others. A code works once, for five minutes, and stops working
						after three wrong attempts.
					</Row>
					<Row term="Invitations">
						One person can send at most twenty invitations in 24 hours. An invitation works once,
						for seven days, and only for the address it was sent to.
					</Row>
					<Row term="Organisations">One person can own at most five.</Row>
					<Row term="Invoices and estimates by email">
						An organisation can send at most 200 in 24 hours.
					</Row>
				</Rows>
				<p>
					Do not invite people who are not expecting it, send invoices or estimates to anyone who is
					not your client's contact, try to reach an organisation you do not belong to, or try to
					get around these limits.
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
					What you put into Timesifier is yours and your organisation's. The{" "}
					<a href={PRIVACY_PATH} className={LINK}>
						privacy notice
					</a>{" "}
					says what is stored, who sees it, where, for how long, and how to export it.
				</p>
				<p>
					You can stop using Timesifier whenever you like. You can leave an organisation from My
					account; the time and expenses you recorded in it stay with it. An owner can delete an
					organisation, and everything in it goes with it. To have your account deleted, or to ask
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
