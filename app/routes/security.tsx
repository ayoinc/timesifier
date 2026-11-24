import { env } from "cloudflare:workers";

import { ACTIVITY_RETENTION_DAYS } from "~/activity/activity.server";
import { Document, DocumentSection, Row, Rows } from "~/landing/Document";
import { deploymentOperator, icoReference, OperatorDetails } from "~/landing/operator";
import {
	DPA_PATH,
	LINK,
	OUTSIDE_LINKS,
	PRIVACY_PATH,
	pageMeta,
	rootOrigin,
	SECURITY_EMAIL,
	SECURITY_PATH,
} from "~/landing/Site";
import {
	IcoRegistration,
	SubProcessorRows,
	TIME_TRAVEL_DAYS,
	WhereItIsKept,
	WORKERS_LOGS_DAYS,
} from "~/landing/trust";
import { WhoSeesWhat } from "~/landing/WhoSees";
import { NOTIFICATION_RETENTION_DAYS } from "~/notifications/kinds";
import { SIGN_IN_DAYS, SUPPORT_HOURS } from "~/platform/limits";

import type { Route } from "./+types/security";

// The security page (TS-105): what a buyer's security review asks, on one page.
// Like the privacy notice, it says only what the code and the configuration
// do, in the same words where the notice says the same thing, and each number
// comes from the constant that acts on it. test/claims.test.ts ties every part
// to its source; docs/decisions.md, entry 59.

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: SECURITY_PATH,
		title: "Security · Timesifier",
		description:
			"Where Timesifier keeps its data, how it is encrypted, who can see it, how long it is kept, who else handles it, what is not done yet, and how to report a vulnerability.",
	});
}

/** The company that runs this deployment, its ICO reference if it names one, and the activity log's retention. */
export function loader() {
	return {
		operator: deploymentOperator(env),
		ico: icoReference(env),
		activityDays: ACTIVITY_RETENTION_DAYS,
	};
}

/** The first version of the page. */
const FIRST = { date: "2026-11-23", inWords: "23 November 2026" };

export default function Security({
	loaderData: { operator, ico, activityDays },
}: Route.ComponentProps) {
	return (
		<Document
			path={SECURITY_PATH}
			title="Security"
			first={FIRST}
			lead="What a security review asks of Timesifier: where its data is kept, how it is protected, who can see it, how long it is kept, who else handles it, and what is not done yet. Each statement is something the application or its configuration does."
			operator={operator}
		>
			<DocumentSection id="where" title="Where data is kept">
				<WhereItIsKept />
			</DocumentSection>

			<DocumentSection id="encryption" title="Encryption">
				<Rows>
					<Row term="At rest">
						Cloudflare encrypts the database and the files in D1 and R2 with AES-256, under keys it
						manages.
					</Row>
					<Row term="In transit">
						Pages are served over HTTPS, and every answer tells the browser, with
						Strict-Transport-Security, to use nothing but HTTPS on this host for two years.
					</Row>
					<Row term="Secrets">
						Sign-in codes, API tokens and calendar feed addresses are kept only as keyed hashes:
						HMAC-SHA-256 under a secret that is not in the database, so a copy of the database signs
						nobody in and opens no token or feed. A webhook's signing secret is never stored: it is
						shown once, and made again from that secret when it is needed.
					</Row>
				</Rows>
			</DocumentSection>

			<DocumentSection id="roles" title="Who sees what">
				<WhoSeesWhat
					leaving={
						<>
							Each is under{" "}
							<a href={`${PRIVACY_PATH}#who`} className={LINK}>
								"Who else handles it"
							</a>{" "}
							in the privacy notice.
						</>
					}
				/>
			</DocumentSection>

			<DocumentSection id="activity" title="The activity log">
				<p>
					Each organisation's activity log records who changed what, and when: the person, or the
					system; whether it came from the web, the API or an import; and the fields before and
					after. A description, a note or a comment is recorded as changed, never copied.
				</p>
				<p>
					The log is only added to. The database refuses any change to a record, and the only
					deletion is the daily job's: each record is deleted {activityDays} days after it was made.
					Who reads which records is the role's, as above.
				</p>
			</DocumentSection>

			<DocumentSection id="backups" title="Backups">
				<p>
					Cloudflare D1's Time Travel is always on: it can restore the database to any minute of the
					last {TIME_TRAVEL_DAYS} days. It is the only copy. Timesifier keeps no other copy of the
					database, a receipt or a logo.
				</p>
				<p>A restore has not been rehearsed yet.</p>
			</DocumentSection>

			<DocumentSection id="retention" title="How long data is kept">
				<Rows>
					<Row term="The activity log">
						Each record is deleted {activityDays} days after it was made.
					</Row>
					<Row term="Sign-ins">Each is deleted {SIGN_IN_DAYS} days after it was made.</Row>
					<Row term="Notifications">
						Each is deleted {NOTIFICATION_RETENTION_DAYS} days after it was made, read or not.
					</Row>
					<Row term="Cloudflare's logs and traces">At most {WORKERS_LOGS_DAYS} days.</Row>
					<Row term="What is deleted">
						Gone from the database at once; gone for good {TIME_TRAVEL_DAYS} days later, when Time
						Travel no longer reaches it. That includes a whole organisation, which its owner can
						delete with everything in it.
					</Row>
					<Row term="Everything else">
						Until it is deleted, by the person or the organisation it belongs to. The privacy notice
						says what of each,{" "}
						<a href={`${PRIVACY_PATH}#how-long`} className={LINK}>
							under "How long it is kept"
						</a>
						.
					</Row>
				</Rows>
			</DocumentSection>

			<DocumentSection id="sub-processors" title="Sub-processors">
				<p>Two companies process personal data for Timesifier, and no others.</p>
				<SubProcessorRows />
				<p>
					An organisation's webhook addresses, and its clients' billing contacts, are sent what the
					organisation chooses to send them. They are its choice, and not Timesifier's
					sub-processors.
				</p>
			</DocumentSection>

			<DocumentSection id="platform-access" title="Access by the people who run Timesifier">
				<p>
					The platform console shows each organisation's name, plan and seats, how many members,
					invitations, time entries, projects and invoices it has, and when it was last used: never
					what is in them. Each platform owner proves their session with a code emailed to them.
				</p>
				<p>
					To read an organisation's people, projects, latest time entries and invoices, a platform
					owner needs support access, which only an owner of that organisation grants, for{" "}
					{SUPPORT_HOURS.join(" or ")} hours. It changes nothing, and each reading is recorded in
					the organisation's activity log.
				</p>
			</DocumentSection>

			<DocumentSection id="not-done" title="What is not done yet">
				<ul className="list-disc ps-6">
					<li>No independent penetration test has been done.</li>
					<li>
						Timesifier holds no certification of its own, such as SOC 2 or ISO 27001.{" "}
						<a href={OUTSIDE_LINKS.cloudflareCompliance.href} className={LINK}>
							Cloudflare's certifications
						</a>{" "}
						are Cloudflare's.
					</li>
					<li>Cloudflare's logs are not restricted to the EU.</li>
					<li>No restore of the database has been rehearsed.</li>
					<li>Sign-in is by a code emailed to the address; there is no second factor yet.</li>
				</ul>
			</DocumentSection>

			<DocumentSection id="reporting" title="Reporting a vulnerability">
				<p>
					Write to{" "}
					<a href={`mailto:${SECURITY_EMAIL}`} className={LINK}>
						{SECURITY_EMAIL}
					</a>{" "}
					with what you found and how to see it. The same address is in this site's security.txt.
					Please give us the chance to fix it before you tell anyone else, and test only with an
					account and an organisation of your own.
				</p>
			</DocumentSection>

			<DocumentSection id="company" title="Who runs Timesifier">
				<p>
					<OperatorDetails operator={operator} />
				</p>
				{ico && (
					<p>
						<IcoRegistration reference={ico} />
					</p>
				)}
				<p>
					What Timesifier does with an organisation's data on its behalf is set out in{" "}
					<a href={DPA_PATH} className={LINK}>
						the data processing agreement
					</a>
					, under Article 28 of the UK GDPR, which is part of the terms. A signed copy is available
					on request, from{" "}
					<a href={`mailto:${SECURITY_EMAIL}`} className={LINK}>
						{SECURITY_EMAIL}
					</a>
					.
				</p>
				<p>
					Whether Timesifier is up, checked from outside it, is shown in{" "}
					<a href={OUTSIDE_LINKS.status.href} className={LINK}>
						its status checks
					</a>
					, where every outage is recorded.
				</p>
			</DocumentSection>
		</Document>
	);
}
