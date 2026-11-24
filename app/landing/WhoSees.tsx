import type { ReactNode } from "react";

import { SUPPORT_HOURS } from "~/platform/limits";

import { Row, Rows } from "./Document";

// Who sees what in an organisation, by role: `app/organisations/access.ts` in
// words. The privacy notice and the security page say it in these same words,
// so the one test that ties them to access.ts holds both (test/claims.test.ts,
// "Who sees what names every role").

export interface WhoSeesWhatProps {
	/** Where the page says what leaves the organisation, and to whom. */
	leaving: ReactNode;
}

export function WhoSeesWhat({ leaving }: WhoSeesWhatProps) {
	return (
		<>
			<p>
				Nobody outside an organisation can read anything in it, or learn that it exists, except
				Timesifier's platform owners, as their row below says. Inside it, what a person sees depends
				on their role, and on whether they manage a team.
			</p>
			<Rows>
				<Row term="Owners and admins">
					Everyone's time, timesheets, expenses with their receipts, and leave, with its kind; every
					rate and amount, the invoices and estimates, and the clients' contacts; the whole activity
					log; the integrations. They invite and remove people. Only an owner deletes the
					organisation.
				</Row>
				<Row term="Finance">
					Everyone's time, timesheets, expenses with their receipts, every rate and amount, the
					invoices and estimates, the clients' contacts and the whole activity log. That a colleague
					is on leave, but not which kind, unless Finance manages their team. Finance approves no
					timesheet or leave except as a manager.
				</Row>
				<Row term="Managers">
					Any member of the organisation can be made the manager of a team. A manager sees the time,
					timesheets, expenses with their receipts, leave with its kind, and records in the activity
					log of the people in the teams they manage, and approves or returns their timesheets and
					leave, never their own. A manager sees no rate, invoice or estimate.
				</Row>
				<Row term="Members">
					Their own time, timesheets, expenses and leave, and the history of their own entries; the
					organisation's projects; who belongs to the organisation, with their names and email
					addresses; and that a colleague is on leave, but not which kind. A member can share a
					report they saved with other members, who see in it only what their own role lets them.
				</Row>
				<Row term="Account managers">
					Any member an owner or admin names as a client's account manager creates that client's
					projects, and sees what their role lets them, nothing more. Owners, admins and Finance see
					who each client's account managers are.
				</Row>
				<Row term="Contractors">
					A member an owner or admin marks as a contractor sees what their role lets them, the same
					as anyone else with it. Owners, admins and Finance see contractors' hours in the
					Contractors report.
				</Row>
				<Row term="Timesifier's platform owners">
					The people who run Timesifier, each of whom must prove their session with a code emailed
					to them, see every account's name, email address, organisations and sign-ins, and each
					organisation's name, plan and seats, how many members, invitations, time entries, projects
					and invoices it has, and when it was last used: never what is in them. Only while an owner
					of the organisation grants support access, for {SUPPORT_HOURS.join(" or ")} hours, can
					they read its people, projects, latest time entries and invoices, and change nothing; each
					reading is recorded in the organisation's activity log. They never see the organisation's
					wellbeing figures, which only its owners see.
				</Row>
			</Rows>
			<p>
				Nobody changes another person's time entries or expenses, except that an owner or admin can
				import time entries for people in the organisation and undo that import. What leaves the
				organisation leaves because someone in it sends it: an invoice or an estimate to a client, a
				webhook, an API token or a calendar feed. {leaving}
			</p>
		</>
	);
}
