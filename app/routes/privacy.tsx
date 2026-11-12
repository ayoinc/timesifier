import { env } from "cloudflare:workers";
import type { ReactNode } from "react";

import { ACTIVITY_RETENTION_DAYS } from "~/activity/activity.server";
import { INVITATION_LIFETIME_SECONDS } from "~/auth/invitation-email";
import { CODE_LIFETIME_SECONDS } from "~/auth/sign-in-code-email";
import { STORED, type StoredTerm } from "~/db/personal-data";
import { ENTRY_DAYS_BACK, LEAVE_DAYS_BACK } from "~/integrations/feeds.server";
import { EVENT_LABELS } from "~/integrations/scopes";
import { SWITCH_OFF_AFTER } from "~/integrations/webhooks.server";
import { DOCUMENT_EMAILS } from "~/invoices/mail.server";
import { Document, DocumentSection, Row, Rows } from "~/landing/Document";
import {
	LINK,
	PRIVACY_EMAIL,
	PRIVACY_PATH,
	pageMeta,
	rootOrigin,
	TERMS_PATH,
} from "~/landing/Site";

import { setting } from "~/lib/deployment";

import type { Route } from "./+types/privacy";

// The privacy notice. Every statement on it is something the application does.
// What is stored is drawn from `app/db/personal-data.ts`, which names every
// table of the schema under one of the rows below; who sees what is
// `app/organisations/access.ts`; how long things are kept is the schema's
// foreign keys and the daily job in `workers/scheduled.ts`. The numbers come
// from the code through the loader. A change to any of these changes this page
// in the same pull request, and `test/claims.test.ts` fails until it does.

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: PRIVACY_PATH,
		title: "Privacy notice · Timesifier",
		description:
			"What Timesifier stores about you and your organisation's work, who can see it, how long it is kept, who else handles it, and how to have it exported or deleted.",
	});
}

/**
 * What the notice says of this deployment comes from the deployment: the host
 * the page was asked for on, and the address its mail is sent from, which is
 * `null` where none is set. The numbers it states come from the modules that
 * act on them, which are the server's.
 */
export function loader({ request }: Route.LoaderArgs) {
	return {
		host: new URL(request.url).host,
		sender: setting(env, "EMAIL_FROM") ?? null,
		facts: {
			activityDays: ACTIVITY_RETENTION_DAYS,
			webhookSwitchOff: SWITCH_OFF_AFTER,
			documentEmails: DOCUMENT_EMAILS.max,
			feedLeaveDays: LEAVE_DAYS_BACK,
			feedEntryDays: ENTRY_DAYS_BACK,
		},
	};
}

/**
 * Who runs Timesifier and answers for what it stores: the controller, in the
 * words of the data protection law. THE OWNER MUST FILL THIS IN: the legal name
 * and a postal address. While it is `null` the notice says in so many words that
 * it is incomplete, and it is. Nothing may be put here that is not true.
 */
const CONTROLLER: { name: string; address: string } | null = null;

/** This version of the notice. */
const VERSION = { date: "2026-11-12", inWords: "12 November 2026" };

const INVITATION_DAYS = INVITATION_LIFETIME_SECONDS / (24 * 60 * 60);

function Controller() {
	if (CONTROLLER) {
		return (
			<p>
				Timesifier is run by {CONTROLLER.name}, {CONTROLLER.address}, which decides what is stored
				and answers for it.
			</p>
		);
	}
	return (
		<p>
			The legal name and the postal address of who runs Timesifier are not on this page yet. Until
			they are, this notice is incomplete. To ask who that is, write to {PRIVACY_EMAIL}.
		</p>
	);
}

/** The kinds of event a webhook can be sent, as Integrations names them, in a sentence. */
const EVENTS = Object.values(EVENT_LABELS)
	.map((label, index, all) =>
		index === 0
			? label.toLowerCase()
			: `${index === all.length - 1 ? " and " : ", "}${label.toLowerCase()}`,
	)
	.join("");

export default function Privacy({ loaderData: { host, sender, facts } }: Route.ComponentProps) {
	/** What each row of "What is stored" says. Every row of `STORED` has its words here. */
	const stored: Record<StoredTerm, ReactNode> = {
		"Your account": (
			<>
				Your name, your email address, whether a sign-in code has proved the address is yours, and
				your time zone once it is set.
			</>
		),
		"Your sessions": (
			<>
				For each browser you are signed in on: a session token, when it expires, and the internet
				address and the browser description the session was started from.
			</>
		),
		"Sign-in codes": (
			<>
				A keyed hash of each code sent to you, never the code itself, with a count of the attempts
				made on it. A count of the codes sent to your address in the last hour, kept under a keyed
				hash of the address.
			</>
		),
		"Limits on requests": (
			<>
				A count of the requests each internet address makes to sign in and to manage an
				organisation, minute by minute. Each count is deleted about a minute after it is made.
			</>
		),
		"The organisation and its people": (
			<>
				The organisation's name, the name in its address on {host}, and its settings. Who belongs to
				it, each person's role, and whether they work as a contractor. Its teams, who is in each and
				who manages it. Each invitation: the email address invited, the role offered, who sent it,
				when it expires and what became of it.
			</>
		),
		"Time and approvals": (
			<>
				Each time entry: whose it is, its project and task, its start and its end, its description
				and tags, whether it is billable or overtime, and the import that brought it, if one did.
				Each timesheet period once it is submitted, with every step it took (submitted, withdrawn,
				approved, returned or reopened), who took it, when, and the comment given. Each request to
				work overtime or on a day off: its days, the hours asked for, the reason, and who decided
				it, when and what they said.
			</>
		),
		Leave: (
			<>
				Each request for leave: whose it is, the kind of leave (sick leave is one), its days and
				half days, the note given with it, how much notice it gave and the reason given when that
				was short, and who decided or cancelled it, when and what they said. The organisation's
				kinds of leave with their allowances, its public holidays and its working week.
			</>
		),
		"Projects, tasks and budgets": (
			<>
				The organisation's projects, tasks and tags, how each project bills, and its budgets,
				including a budget for one person on a project. A record of each budget alert sent.
			</>
		),
		"Clients and their contacts": (
			<>
				The organisation's clients, and each client's billing contacts: an email address and, when
				one is given, a name. These are people outside the organisation, whose addresses an owner,
				admin or Finance enters so that invoices and estimates can be sent to them.
			</>
		),
		"Rates, invoices and estimates": (
			<>
				Billable and cost rates, including a rate for one person. The organisation's invoicing
				details: its legal name, its address and its tax number. Invoices, estimates, recurring
				invoices and retainers, with their lines, notes and totals; payments and write-offs, with
				who recorded them. An invoice's line names a person, or carries an entry's description, when
				the person invoicing groups its time that way.
			</>
		),
		"Expenses and receipts": (
			<>
				Each expense: whose it is, its day, project, category, amount, notes and tags, whether it is
				billable and whether it is to be paid back. A receipt, a PDF or an image, is kept as a file
				in Cloudflare R2, with its file name and type in the database. The organisation's expense
				categories and their prices.
			</>
		),
		"Saved reports": (
			<>A report a member saves: its name, what it shows, and who it is shared with.</>
		),
		"API tokens": (
			<>
				Each token's name, what it may do, who made it, when it was last used, when it expires and
				whether it was revoked. Of the token itself only a keyed hash and its first eight characters
				are kept.
			</>
		),
		Webhooks: (
			<>
				The address an owner or admin gives each webhook, the kinds of event it is sent, whether it
				includes descriptions, who added it, and how its last deliveries went. Each delivery is kept
				exactly as it was sent: what it holds is under "Who else handles it". Of its signing secret
				only a hash is kept.
			</>
		),
		Imports: (
			<>
				Each CSV import: its file's name, what it imported, who made it, and how many rows it took
				or skipped, with why. The file's text is kept while the import waits to be confirmed, and
				emptied once it is imported.
			</>
		),
		"Calendar feeds": (
			<>
				Each calendar address a person makes: whose it is, whether it is their own or a team's,
				whether it lists their time entries, and whether it was revoked. Of the address's secret
				only a keyed hash is kept.
			</>
		),
		"The activity log": (
			<>
				A record of each change made in the organisation, by a person, through the API, by an import
				or by Timesifier itself: who made it, how, what was changed, whose record it was, and the
				values before and after. Words a person typed, such as a description, a note or a comment,
				are never copied into it: the log says only that they changed.
			</>
		),
	};

	return (
		<Document
			path={PRIVACY_PATH}
			title="Privacy notice"
			version={VERSION}
			lead="What Timesifier stores about you and your organisation's work, who can see it, where and how long it is kept, who else handles it, and how to have it exported or deleted. It does not yet name who runs Timesifier, so it is not complete. It changes as the product does, and its date with it."
		>
			<DocumentSection id="who-we-are" title="Who is responsible">
				<Controller />
			</DocumentSection>

			<DocumentSection id="stored" title="What is stored">
				<p>
					What you and the people in your organisation put into Timesifier, and what it needs to
					sign you in. Everything except your account belongs to one organisation.
				</p>
				{STORED.map(({ heading, rows }) => (
					<div key={heading} className="flex flex-col gap-4">
						<h3 className="mt-4 text-title-large">{heading}</h3>
						<Rows>
							{rows.map(({ term }) => (
								<Row key={term} term={term}>
									{stored[term]}
								</Row>
							))}
						</Rows>
					</div>
				))}
			</DocumentSection>

			<DocumentSection id="who-sees" title="Who sees what">
				<p>
					Nobody outside an organisation can read anything in it, or learn that it exists. Inside
					it, what a person sees depends on their role, and on whether they manage a team.
				</p>
				<Rows>
					<Row term="Owners and admins">
						Everyone's time, timesheets, expenses with their receipts, and leave, with its kind;
						every rate and amount, the invoices and estimates, and the clients' contacts; the whole
						activity log; the integrations. They invite and remove people. Only an owner deletes the
						organisation.
					</Row>
					<Row term="Finance">
						Everyone's time, timesheets, expenses with their receipts, every rate and amount, the
						invoices and estimates, the clients' contacts and the whole activity log. That a
						colleague is on leave, but not which kind, unless Finance manages their team. Finance
						approves no timesheet or leave except as a manager.
					</Row>
					<Row term="Managers">
						Any member of the organisation can be made the manager of a team. A manager sees the
						time, timesheets, expenses with their receipts, leave with its kind, and records in the
						activity log of the people in the teams they manage, and approves or returns their
						timesheets and leave, never their own. A manager sees no rate, invoice or estimate.
					</Row>
					<Row term="Members">
						Their own time, timesheets, expenses and leave, and the history of their own entries;
						the organisation's projects; who belongs to the organisation, with their names and email
						addresses; and that a colleague is on leave, but not which kind. A member can share a
						report they saved with other members, who see in it only what their own role lets them.
					</Row>
					<Row term="Contractors">
						A member an owner or admin marks as a contractor sees what their role lets them, the
						same as anyone else with it. Owners, admins and Finance see contractors' hours in the
						Contractors report.
					</Row>
				</Rows>
				<p>
					Nobody changes another person's time entries or expenses, except that an owner or admin
					can import time entries for people in the organisation and undo that import. What leaves
					the organisation leaves because someone in it sends it: an invoice or an estimate to a
					client, a webhook, an API token or a calendar feed. Each is under "Who else handles it".
				</p>
			</DocumentSection>

			<DocumentSection id="where" title="Where it is kept">
				<p>
					In one database, Cloudflare D1, restricted to the European Union: it runs and stores its
					data only inside the EU. Receipts are kept in Cloudflare R2, in a bucket restricted to the
					EU, whose files are stored only inside the EU.
				</p>
				<p>
					The application runs on Cloudflare Workers in Frankfurt, near the database. Your request
					reaches Cloudflare at the data centre nearest to you, which may be outside the EU, and is
					passed to Frankfurt, where it is handled and the database is read. The files a page loads
					(its scripts, styles and fonts) are sent from the data centre nearest to you.
				</p>
				<p>
					Cloudflare’s log of requests, its record of each email sent, and what Turnstile and Web
					Analytics collect are not restricted to the EU.
				</p>
			</DocumentSection>

			<DocumentSection id="who" title="Who else handles it">
				<p>
					Cloudflare, for everything the application does. Every service Timesifier runs on is
					Cloudflare’s. Cloudflare, Inc. is a company in the United States.
				</p>
				<p>Mail you send to {PRIVACY_EMAIL} is received by Microsoft, which hosts that mailbox.</p>
				<Rows>
					<Row term="Hosting, the database and receipts">
						Cloudflare Workers answers every request, Cloudflare D1 holds the database and
						Cloudflare R2 holds the receipts.
					</Row>
					<Row term="Email">
						<p>
							Every email is sent through Cloudflare's email service
							{sender ? `, from ${sender}` : ""}. Timesifier sends these and no others:
						</p>
						<ul className="mt-2 list-disc ps-6">
							<li>a sign-in code, to the address entered on the sign-in page;</li>
							<li>
								an invitation, to the address an owner or admin invites, with the address of the
								person who invited them, the organisation's name and the role offered;
							</li>
							<li>
								an invoice or an estimate, as a PDF, to the billing contacts of a client, when an
								owner, admin or Finance sends it, or when a recurring invoice is set to send itself;
								an estimate's email holds a link with which anyone who has it can read the estimate
								and accept or decline it, without an account;
							</li>
							<li>
								a reminder of an overdue invoice, with its PDF, to the client's billing contacts,
								when the organisation has reminders on;
							</li>
							<li>
								a budget alert, to the organisation's owners and admins and, for a budget in hours,
								to the managers of the teams of the people who tracked time to the project;
							</li>
							<li>a notice that a webhook was switched off, to the person who added it.</li>
						</ul>
						<p className="mt-2">
							An organisation sends at most {facts.documentEmails} invoice and estimate emails in 24
							hours. No email holds an image or anything that tells Timesifier it was opened, and
							the email with a code holds no link.
						</p>
					</Row>
					<Row term="Webhooks">
						An owner or admin can give Timesifier an address to tell about {EVENTS}. For each such
						event that the person who added the webhook may see, Timesifier posts to that address,
						signed: the event, when and how it happened, who made it (their identifier and name),
						the fields that changed, and the record as the API shows it. For a time entry that is
						whose it is, its project, client, task, day, start, end and hours, and whether it is
						billable or overtime; its description only if the webhook includes descriptions. Whoever
						runs the address receives all of it. A delivery that fails is tried again; after{" "}
						{facts.webhookSwitchOff} failures in a row the webhook is switched off.
					</Row>
					<Row term="API tokens">
						An owner or admin can make a token for Timesifier's API. It works as the person who made
						it, with their role at the time of each request, limited to what the token may do:
						reading time entries, their descriptions, projects, people and their leave, expenses or
						invoices, and adding, changing and deleting the maker's own time entries. Whoever holds
						the token can do with it what it allows.
					</Row>
					<Row term="Calendar feeds">
						A person can make a calendar address of their own approved leave, from the last{" "}
						{facts.feedLeaveDays} days on and, if they choose, of their time entries of the last{" "}
						{facts.feedEntryDays} days, by project and task; a manager, one of a team's approved
						leave. Anyone with the address, such as the calendar it is added to, can read it without
						an account, until it is revoked.
					</Row>
					<Row term="The check that you are a person">
						Before a sign-in code is sent, the page that asks for it runs Cloudflare Turnstile,
						which loads from challenges.cloudflare.com. No other page loads it. Turnstile receives
						your internet address and details of your browser, and Cloudflare also uses them to
						improve Turnstile.
					</Row>
					<Row term="Analytics">
						Cloudflare adds its Web Analytics script to each page. It loads from
						static.cloudflareinsights.com and sends what it measures of the page to Cloudflare.
					</Row>
					<Row term="Logs">
						Cloudflare keeps a log of each request the application answers. A line holds the address
						of the page asked for, which for a calendar feed or an estimate's link includes its
						secret, and details of the request, and Cloudflare keeps it for at most seven days. For
						one request in ten Cloudflare also keeps a trace for seven days: how long each step
						took, the addresses the request was for and posted to, and the text of each database
						statement, whose values are sent apart from it. The lines Timesifier itself writes never
						hold an email address, a sign-in code, a cookie or a session token.
					</Row>
					<Row term="Reports of failed connections">
						Cloudflare asks your browser to tell it when the browser cannot reach {host}. Such a
						report goes from your browser to a.nel.cloudflare.com, with your internet address.
					</Row>
				</Rows>
				<p>Timesifier carries no advertising.</p>
			</DocumentSection>

			<DocumentSection id="cookies" title="Cookies">
				<p>
					Timesifier sets five cookies and no others. Each is sent only to {host}, and only over
					HTTPS. None is for advertising or for following you from site to site.
				</p>
				<Rows>
					<Row term="__Host-timesifier.session_token">
						Keeps you signed in. It is set when you sign in and lasts seven days, renewed while you
						use Timesifier. Script on the page cannot read it.
					</Row>
					<Row term="__Host-timesifier.sign_in_code">
						Shows that this browser asked for the sign-in code you are about to type. It holds no
						email address and is kept for one hour.
					</Row>
					<Row term="__Host-timesifier.known_browser">
						Shows that this browser has signed in as your address before, so that somebody else
						asking for codes for your address cannot use up yours. It holds a keyed hash of up to
						five addresses, never an address, and is kept for one year. Signing out does not remove
						it. Script on the page cannot read it.
					</Row>
					<Row term="__Host-color-scheme">
						The word light, dark or system, once you choose a colour scheme in Settings. It is kept
						for one year. Until you choose, it is not set and the pages are light.
					</Row>
					<Row term="__Host-timesifier.getting_started">
						Shows that you have opened the Week view of your timesheet, and that you put its
						getting-started list away, so that the list ticks that step or stays hidden. It holds
						your account's identifier beside each of these marks, for the last people to use
						Timesifier in this browser, and is kept for one year. Script on the page cannot read it.
					</Row>
				</Rows>
				<p>
					Two things are kept in your browser that are not cookies, both in the tab you are using
					and nowhere else. The first is how far down each page you had scrolled, so that going back
					returns you to the same place. The second is kept when you ask for a sign-in code: your
					email address and the time, for {CODE_LIFETIME_SECONDS / 60} minutes, so that you can
					leave for your mail, come back and type the code. Neither is sent to {host} or anywhere
					else. The second is removed when you sign in, and when the {CODE_LIFETIME_SECONDS / 60}{" "}
					minutes have passed.
				</p>
			</DocumentSection>

			<DocumentSection id="how-long" title="How long it is kept">
				<Rows>
					<Row term="Your account">
						Until it is deleted at your request: see "Export and deletion". Leaving an organisation,
						or its deletion, does not delete your account.
					</Row>
					<Row term="A session">
						It works for seven days from when it was last renewed, and ends at once when you sign
						out or end all your sessions. The record of an expired session, with its internet
						address and browser description, is removed the next time that browser visits; until
						then it is kept.
					</Row>
					<Row term="A sign-in code">
						A code works for five minutes, and its hash is deleted soon after. The email that
						carried it stays in your mailbox, and Cloudflare keeps its record of sending it for up
						to 30 days. The counts of codes sent to an address stop counting after one hour.
					</Row>
					<Row term="An invitation">
						It can be accepted for {INVITATION_DAYS} days. Its record stays with the organisation.
					</Row>
					<Row term="Your organisation's work">
						<p>
							Until it is deleted in Timesifier, or the organisation is. Nothing in it is deleted
							for its age, except the activity log.
						</p>
						<ul className="mt-2 list-disc ps-6">
							<li>
								When a person leaves an organisation or is removed from it, their time entries and
								expenses stay with it, so that its totals still add up. Their requests for leave and
								for overtime, their places in teams, their saved reports and their calendar feeds
								are deleted with their membership.
							</li>
							<li>
								A person can delete their own time entry or expense while it is not locked by an
								approved or submitted timesheet, the organisation's lock date, or an invoice.
								Deleting an expense, or its receipt, deletes the receipt's file.
							</li>
							<li>
								Clients, projects, tasks, tags, expense categories and taxes are archived, never
								deleted. An invoice that has been sent is never deleted, only voided, and keeps its
								payments.
							</li>
							<li>
								A webhook's deliveries are kept until the webhook is deleted. A revoked API token or
								calendar feed keeps its record.
							</li>
						</ul>
					</Row>
					<Row term="The activity log">
						Each record is deleted {facts.activityDays} days after it was made, by a job that runs
						every day.
					</Row>
					<Row term="Deleting an organisation">
						An owner can delete an organisation. Everything in it goes at once: its memberships,
						invitations and all its work, and first its receipts. If a receipt cannot be deleted,
						the organisation is not deleted, and the owner is asked to try again. The accounts of
						the people in it are not deleted.
					</Row>
					<Row term="Copies">
						Cloudflare keeps the means to restore the database to any minute of the last 30 days, so
						what is deleted from the database is gone for good 30 days later. Timesifier keeps no
						other copy, of the database or of a receipt.
					</Row>
				</Rows>
			</DocumentSection>

			<DocumentSection id="rights" title="Your rights">
				<p>
					Where the General Data Protection Regulation of the European Union or of the United
					Kingdom applies to you, you may ask for a copy of what is stored about you, have it
					corrected or deleted, ask for its use to be limited or object to it, and receive it in a
					form another service can read.
				</p>
				<p>
					To use any of them, write to the address below. You may also complain to the data
					protection authority of the country you live in.
				</p>
			</DocumentSection>

			<DocumentSection id="your-data" title="Export and deletion">
				<Rows>
					<Row term="A copy">
						Anyone in an organisation can download from Reports, as CSV, the time, expenses and
						leave they may see, their own at least, and from the Activity log the records they may
						read. Owners and admins can download every time entry of the organisation as CSV and
						every invoice as a PDF in one ZIP, from Integrations. Owners, admins and Finance can
						download the reports of invoices, the Contractors report and a file for Xero, as CSV.
					</Row>
					<Row term="Corrections">
						You can change your name and your time zone in My account, and your own time entries and
						expenses while they are not locked. Your email address cannot be changed in Timesifier.
					</Row>
					<Row term="Deletion">
						You can leave an organisation from My account, and an owner can delete one in Workspace
						settings: "How long it is kept" says what goes with each. There is no control in
						Timesifier to delete your account.
					</Row>
				</Rows>
				<p>
					For anything else, a copy of what is stored about you, a correction, or your account
					deleted, write to{" "}
					<a href={`mailto:${PRIVACY_EMAIL}`} className={LINK}>
						{PRIVACY_EMAIL}
					</a>{" "}
					from the address of your account, and say what you want.
				</p>
				<p>
					The{" "}
					<a href={TERMS_PATH} className={LINK}>
						terms
					</a>{" "}
					say what Timesifier is today and what using it involves.
				</p>
			</DocumentSection>
		</Document>
	);
}
