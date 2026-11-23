import { env } from "cloudflare:workers";

import { PROCESSED_FOR_ORGANISATIONS, STORED } from "~/db/personal-data";
import { Document, DocumentSection, Row, Rows } from "~/landing/Document";
import { deploymentOperator, OperatorDetails } from "~/landing/operator";
import {
	DPA_PATH,
	LINK,
	OUTSIDE_LINKS,
	PRIVACY_EMAIL,
	PRIVACY_PATH,
	pageMeta,
	rootOrigin,
	SECURITY_EMAIL,
	SECURITY_PATH,
	TERMS_PATH,
} from "~/landing/Site";
import {
	BREACH_NOTICE_HOURS,
	DPA_VERSION,
	SUB_PROCESSOR_NOTICE_DAYS,
	SubProcessorRows,
	TIME_TRAVEL_DAYS,
	WhereItIsKept,
} from "~/landing/trust";
import { SUPPORT_HOURS } from "~/platform/limits";

import type { Route } from "./+types/dpa";

// The data processing agreement (TS-105, slice 105d): what UK GDPR Article
// 28(3) asks of a processor's contract, in plain words, each term as the code
// does it. The terms incorporate it, and an owner accepts it for their
// organisation when they create it or, for one made before, in Settings
// (`app/organisations/dpa.server.ts`). The numbers come from the constants in
// `landing/trust.tsx`, the sub-processors from `SUB_PROCESSORS` and the data
// from `STORED`; test/claims.test.ts ties each to the page. docs/decisions.md,
// entry 60.

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: DPA_PATH,
		title: "Data processing agreement · Timesifier",
		description:
			"The terms on which Timesifier processes an organisation's personal data for it, under Article 28 of the UK GDPR: what, why and for how long, who else handles it, breaches, and what happens at the end.",
	});
}

/** The company that runs this deployment, which is the processor, from its settings. */
export function loader() {
	return { operator: deploymentOperator(env) };
}

/** The data an organisation controls: the rows of "What is stored" under its headings. */
const PROCESSED = STORED.filter(({ heading }) =>
	(PROCESSED_FOR_ORGANISATIONS as readonly string[]).includes(heading),
).flatMap(({ rows }) => rows.map(({ term }) => term));

export default function Dpa({ loaderData: { operator } }: Route.ComponentProps) {
	return (
		<Document
			path={DPA_PATH}
			title="Data processing agreement"
			first={DPA_VERSION}
			lead="The terms on which Timesifier processes the personal data in an organisation for that organisation, as Article 28 of the UK GDPR requires: what is processed, why and for how long, what Timesifier undertakes, who else handles the data, and what happens at the end."
			operator={operator}
		>
			<DocumentSection id="parties" title="Who it is between">
				<p>
					This agreement is between an organisation in Timesifier, the controller, and the company
					that runs Timesifier, the processor. <OperatorDetails operator={operator} />
				</p>
				<p>
					It is part of the{" "}
					<a href={TERMS_PATH} className={LINK}>
						terms
					</a>
					. An owner accepts it for their organisation when they create the organisation, or, for an
					organisation made before it, once in Workspace settings. The organisation keeps which
					version was accepted, by whom and when, and the activity log records it. This is the
					version of {DPA_VERSION.inWords}.
				</p>
				<p>
					A copy signed by the company is available on request, from{" "}
					<a href={`mailto:${SECURITY_EMAIL}`} className={LINK}>
						{SECURITY_EMAIL}
					</a>
					.
				</p>
			</DocumentSection>

			<DocumentSection id="subject" title="What is processed, why and for how long">
				<Rows>
					<Row term="Subject matter">
						The personal data the organisation and its people put into Timesifier, or that
						Timesifier records as they use it.
					</Row>
					<Row term="Nature and purpose">
						Keeping, showing and adding up that data in the organisation's workspace; sending the
						emails the organisation asks for, such as invitations, invoices and estimates; and the
						exports, webhooks and calendar feeds it sets up. Nothing else: the data is not sold,
						used for advertising, or used to train anything.
					</Row>
					<Row term="Duration">
						For as long as the organisation exists. Each thing is kept until it is deleted, as the{" "}
						<a href={`${PRIVACY_PATH}#how-long`} className={LINK}>
							privacy notice says under "How long it is kept"
						</a>
						.
					</Row>
				</Rows>
			</DocumentSection>

			<DocumentSection id="data" title="The personal data, and whose it is">
				<p>
					The kinds of personal data are those the privacy notice lists as the organisation's, each
					described in full{" "}
					<a href={`${PRIVACY_PATH}#stored`} className={LINK}>
						under "What is stored"
					</a>
					:
				</p>
				<ul className="list-disc ps-6">
					{PROCESSED.map((term, at) => (
						<li key={term}>
							{term}
							{at === PROCESSED.length - 1 ? "." : ";"}
						</li>
					))}
				</ul>
				<p>
					The people it is about are the organisation's members and the people it invites; its
					clients' contacts, to whom it sends invoices and estimates; and anyone its people write
					about in a description, a note or a comment.
				</p>
				<p>
					Not covered: a person's account, their sign-ins and sessions, the mail Timesifier sends
					them about their account, and Timesifier's own records. The company decides what is kept
					of those and is their controller.
				</p>
			</DocumentSection>

			<DocumentSection id="controller" title="The organisation's obligations and rights">
				<p>
					The organisation decides why its people's data is in Timesifier and what is done with it.
					It is responsible for having a lawful basis for that, for telling its people, and for the
					instructions it gives.
				</p>
				<p>
					It may give instructions, object to a new sub-processor, ask for information and audit,
					and have its data exported or deleted, each as this agreement says.
				</p>
			</DocumentSection>

			<DocumentSection id="processor" title="What Timesifier undertakes">
				<Rows>
					<Row term="Only on the organisation's instructions">
						The terms, this agreement and what the organisation's owners and admins set and do in
						Timesifier are its documented instructions, and the company processes the data only on
						them, transfers included, unless the law requires otherwise; it then tells the
						organisation first, unless the law forbids that. It tells the organisation at once if it
						thinks an instruction breaks data protection law. <Cites>Article 28(3)(a)</Cites>
					</Row>
					<Row term="Confidentiality">
						Of the company's people, only its platform owners can reach the data, and the company
						ensures each is bound to keep it confidential. The platform console shows them an
						organisation's name, plan and counts, never what is in it. To read its people, projects,
						latest time entries and invoices, they need support access, which only an owner of the
						organisation grants, for {SUPPORT_HOURS.join(" or ")} hours, and each reading is
						recorded in its activity log. <Cites>Article 28(3)(b)</Cites>
					</Row>
					<Row term="Security">
						The measures on{" "}
						<a href={SECURITY_PATH} className={LINK}>
							the security page
						</a>
						, which says what is done and what is not done yet.{" "}
						<Cites>Article 28(3)(c), Article 32</Cites>
					</Row>
					<Row term="Sub-processors">
						The organisation authorises the sub-processors listed below. The company tells every
						organisation's owners by email at least {SUB_PROCESSOR_NOTICE_DAYS} days before a new
						one starts. An organisation that objects within that time may download its data and
						delete the organisation before the new one starts. The company binds each sub-processor
						by contract to the same obligations as this agreement, and answers to the organisation
						for them. <Cites>Article 28(2), 28(3)(d) and 28(4)</Cites>
					</Row>
					<Row term="People's rights">
						The organisation's owners and admins can download its data and delete it in Timesifier,
						as the privacy notice says{" "}
						<a href={`${PRIVACY_PATH}#your-data`} className={LINK}>
							under "Export and deletion"
						</a>
						. A request from one of its people that reaches the company is passed to the
						organisation, and the company helps with anything else the organisation asks of it at{" "}
						<a href={`mailto:${PRIVACY_EMAIL}`} className={LINK}>
							{PRIVACY_EMAIL}
						</a>
						. <Cites>Article 28(3)(e)</Cites>
					</Row>
					<Row term="Breaches, and assessments">
						The company tells the organisation's owners of a personal data breach that affects the
						organisation without undue delay, and at the latest {BREACH_NOTICE_HOURS} hours after it
						becomes aware of it, with what it knows then and the rest as it learns it. It gives the
						organisation, on request, the information it needs for a data protection impact
						assessment or to consult the ICO. <Cites>Article 28(3)(f), Articles 32 to 36</Cites>
					</Row>
					<Row term="At the end">
						The organisation's data ends when an owner deletes the organisation: everything in it is
						deleted from the database at once, and is gone from Cloudflare's restore copies{" "}
						{TIME_TRAVEL_DAYS} days later. Before that, its owners and admins can download its time
						entries, invoices, reports and activity log, which is how it is returned, and ask{" "}
						<a href={`mailto:${PRIVACY_EMAIL}`} className={LINK}>
							{PRIVACY_EMAIL}
						</a>{" "}
						for anything else. The company keeps none of it after that, unless the law requires it
						to. <Cites>Article 28(3)(g)</Cites>
					</Row>
					<Row term="Information and audits">
						The company makes available what the organisation needs to show that this agreement is
						kept: the security page, and answers to a security questionnaire. It allows an audit by
						the organisation or an auditor it chooses, with reasonable notice and at the
						organisation's cost. <Cites>Article 28(3)(h)</Cites>
					</Row>
				</Rows>
			</DocumentSection>

			<DocumentSection id="sub-processors" title="Sub-processors">
				<p>Two companies process personal data for Timesifier, and no others.</p>
				<SubProcessorRows />
			</DocumentSection>

			<DocumentSection id="transfers" title="Where the data is, and transfers">
				<WhereItIsKept />
				<p>
					UK law treats the EU as giving personal data adequate protection, so keeping it there
					needs no further safeguard. What leaves the UK and the EU is a request on its way to
					Frankfurt, Cloudflare's logs, its record of each email, and what Turnstile and Web
					Analytics collect, all handled by Cloudflare, Inc. in the United States; and mail to the
					company's mailbox, which Microsoft hosts. Each is covered by the provider's own agreement:
					Cloudflare's, by the{" "}
					<a href={OUTSIDE_LINKS.cloudflareDpa.href} className={LINK}>
						ICO's International Data Transfer Addendum and the UK Extension to the Data Privacy
						Framework
					</a>
					; Microsoft's, by{" "}
					<a href={OUTSIDE_LINKS.microsoftDpa.href} className={LINK}>
						its data protection addendum
					</a>
					.
				</p>
			</DocumentSection>

			<DocumentSection id="changes" title="Changes to this agreement">
				<p>
					A change is a new version, with its date on this page. The company tells every
					organisation's owners, and they are asked to accept it in Workspace settings. A new
					sub-processor is told {SUB_PROCESSOR_NOTICE_DAYS} days ahead, as above.
				</p>
			</DocumentSection>
		</Document>
	);
}

/**
 * The articles of the UK GDPR a term answers, kept on one line: a narrow
 * window would otherwise break "28(3)(b)" between its brackets.
 */
function Cites({ children }: { children: string }) {
	return <span className="whitespace-nowrap">({children}.)</span>;
}
