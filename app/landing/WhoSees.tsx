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
					rate and amount, the invoices and estimates, and the clients' contacts; everyone's
					contracts with their pay and the adjustments to their leave; the whole activity log; the
					integrations. They invite and remove people, give, change and end contracts and adjust
					leave, never their own while another owner or admin could. Only an owner deletes the
					organisation.
				</Row>
				<Row term="Finance">
					Everyone's time, timesheets, expenses with their receipts, every rate and amount,
					everyone's contracts with their pay and the adjustments to their leave, the invoices and
					estimates, the clients' contacts and the whole activity log. That a colleague is on leave,
					but not which kind, unless Finance manages their team. Finance changes no contract, and
					approves no timesheet or leave except as a manager.
				</Row>
				<Row term="Managers">
					Any member of the organisation can be made the manager of a team. A manager sees the time,
					timesheets, expenses with their receipts, leave with its kind, contracts without their pay
					but with the adjustments to their leave, and records in the activity log of the people in
					the teams they manage, and approves or returns their timesheets and leave, never their
					own. A manager sees no rate, pay, invoice or estimate. A manager also sees their people's
					time shares of every project, week by week in Team › Allocation.
				</Row>
				<Row term="Members">
					Their own time, timesheets, expenses, leave with its adjustments and contract with its
					pay, their own time shares, and the history of their own entries; the organisation's
					projects; who belongs to the organisation, with their names and email addresses; and that
					a colleague is on leave, but not which kind. A member can share a report they saved with
					other members, who see in it only what their own role lets them.
				</Row>
				<Row term="Account managers">
					Any member an owner or admin names as a client's account manager creates that client's
					projects, manages their work packages, their teams and their people's time shares, names
					their delivery managers, and sees each of those projects' team, the hours tracked to it
					and its budget in hours, but no rate or money unless their role shows it. In Team ›
					Allocation they see the people on those projects week by week, and of other projects only
					how much is planned in all. Owners, admins and Finance see who each client's account
					managers are.
				</Row>
				<Row term="Delivery managers">
					A person an owner, admin or account manager puts on a project's team as its delivery
					manager, while they are, sees that project's team, the hours tracked to it and its budget
					in hours, assigns members to it, sets their time shares and manages its work packages, but
					names no other delivery manager and sees no rate or money unless their role shows it. Like
					an account manager, they see that project's people in Team › Allocation. Where a submitted
					week has time on their project, they approve or return that time, each person's days on it,
					never their own; the rest of the week stays with the person's manager. Everyone else on a
					team sees their own days and time share on it.
				</Row>
				<Row term="Contractors">
					A person whose contract is a contractor's, or whom an owner or admin marks as a contractor
					while no contract covers the day, sees what their role lets them, the same as anyone else
					with it. Owners, admins and Finance see contractors' hours in the Contractors report.
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
