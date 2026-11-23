import { Row, Rows } from "./Document";
import { LINK, OUTSIDE_LINKS, type OutsideLink, PRIVACY_EMAIL, SECURITY_EMAIL } from "./Site";

// What the privacy notice, the security page and the data processing agreement
// state about Timesifier's hosting, each fact once (TS-105). Every number here
// is a provider's, quoted beside it, or the agreement's own; test/claims.test.ts
// ties each page to these constants.

/**
 * This version of the data processing agreement (`/dpa`), by the date it was
 * written. An organisation keeps the version an owner accepted
 * (`organisations.dpa_version`); while it is not this one, its owners are asked
 * in Settings. A new version is a new date here: every organisation is then
 * asked again (docs/decisions.md, entry 60).
 */
export const DPA_VERSION = { date: "2026-11-23", inWords: "23 November 2026" } as const;

/** How soon after becoming aware of a personal data breach the company tells an organisation's owners, at the latest (owner's answer 2, 23 November 2026). */
export const BREACH_NOTICE_HOURS = 48;

/** How many days before a new sub-processor starts the company tells every organisation's owners (owner's answer 2, 23 November 2026). */
export const SUB_PROCESSOR_NOTICE_DAYS = 30;

/**
 * How far back the database can be restored. D1's Time Travel "can restore a
 * database to any minute within the last 7 days on the Workers Free plan or 30
 * days on the Workers Paid plan"; it is always on.
 * https://developers.cloudflare.com/d1/reference/time-travel/
 * Timesifier is on Workers Paid (docs/architecture.md, "Plan and budget"). On
 * 23 November 2026 `wrangler d1 time-travel info timesifier` gave a bookmark
 * for 11 days back, as far as the database then existed, and refused one 40
 * days back: "Please provide a timestamp within the last 30 days". No restore
 * has been rehearsed (TS-022a), and no page says one has.
 */
export const TIME_TRAVEL_DAYS = 30;

/**
 * How long Cloudflare keeps the Worker's logs and traces. Workers Logs on
 * Workers Paid: "Maximum log retention period | 7 Days"; traces: "Workers
 * traces have seven-day retention".
 * https://developers.cloudflare.com/workers/observability/logs/workers-logs/
 * https://developers.cloudflare.com/workers/observability/traces/
 */
export const WORKERS_LOGS_DAYS = 7;

/** The parts of wrangler.jsonc that send data to a provider. Each is one sub-processor's. */
export type Binding = "d1_databases" | "r2_buckets" | "send_email" | "observability";

export interface SubProcessor {
	/** The anchor of its row on /security. */
	id: string;
	/** The company, as the privacy notice names it. */
	name: string;
	/** Where the company is. */
	based: string;
	/** What it receives, each a phrase that completes "It receives". */
	receives: readonly string[];
	/** The parts of wrangler.jsonc whose data it handles. */
	bindings: readonly Binding[];
	/** Its data processing agreement. */
	dpa: OutsideLink;
	/** Its own list of sub-processors, where it publishes one. */
	list?: OutsideLink;
}

/**
 * Everyone who processes personal data for Timesifier, from the code and the
 * configuration. Not here: an organisation's webhook receivers and its clients'
 * billing contacts, whom the organisation itself sends data to.
 */
export const SUB_PROCESSORS: readonly SubProcessor[] = [
	{
		id: "cloudflare",
		name: "Cloudflare",
		based: "Cloudflare, Inc., in the United States",
		receives: [
			"every request, through Cloudflare Workers, which runs the application",
			"the database, in Cloudflare D1, restricted to the EU",
			"receipts and organisations' logos, in Cloudflare R2, restricted to the EU",
			"every email Timesifier sends, with its recipient, through Cloudflare's Email Service",
			"the check that a person is not a robot before a sign-in code is sent, through Cloudflare Turnstile",
			"what Cloudflare Web Analytics measures of each page",
			`a log line of every request, and a trace of one in ten, kept ${WORKERS_LOGS_DAYS} days`,
		],
		bindings: ["d1_databases", "r2_buckets", "send_email", "observability"],
		dpa: OUTSIDE_LINKS.cloudflareDpa,
		list: OUTSIDE_LINKS.cloudflareSubprocessors,
	},
	{
		id: "microsoft",
		name: "Microsoft",
		based: "Microsoft, which hosts the company's mailbox",
		receives: [`mail sent to ${PRIVACY_EMAIL} or ${SECURITY_EMAIL}`],
		bindings: [],
		dpa: OUTSIDE_LINKS.microsoftDpa,
	},
];

/**
 * The sub-processors, each with where it is, what it receives, and its own
 * agreement and list: the same rows on /security and /dpa. The anchor of each
 * row is its `id`.
 */
export function SubProcessorRows() {
	return (
		<Rows>
			{SUB_PROCESSORS.map((each) => (
				<Row key={each.id} term={each.name}>
					<p id={each.id}>{each.based}. It receives:</p>
					<ul className="mt-2 list-disc ps-6">
						{each.receives.map((what, at) => (
							<li key={what}>
								{what}
								{at === each.receives.length - 1 ? "." : ";"}
							</li>
						))}
					</ul>
					<p className="mt-2">
						<a href={each.dpa.href} className={LINK}>
							{each.name}'s data processing agreement
						</a>
						{each.list && (
							<>
								{" "}
								and{" "}
								<a href={each.list.href} className={LINK}>
									its own sub-processors
								</a>
							</>
						)}
						.
					</p>
				</Row>
			))}
		</Rows>
	);
}

/** Where the database and the files are, and what is not restricted to the EU: the same words on /security and /dpa. */
export function WhereItIsKept() {
	return (
		<>
			<p>
				In one database, Cloudflare D1, restricted to the European Union: it runs and stores its
				data only inside the EU. Receipts and organisations' logos are kept in Cloudflare R2, in
				buckets restricted to the EU, whose files are stored only inside the EU.
			</p>
			<p>
				The application runs on Cloudflare Workers in Frankfurt, near the database. Your request
				reaches Cloudflare at the data centre nearest to you, which may be outside the EU, and is
				passed to Frankfurt, where it is handled and the database is read.
			</p>
			<p>
				Cloudflare's log of requests, its record of each email sent, and what Turnstile and Web
				Analytics collect are not restricted to the EU.
			</p>
		</>
	);
}

/**
 * The company's registration with the ICO, when the deployment names it
 * (`icoReference` in ./operator). Without it, nothing is said of the ICO.
 */
export function IcoRegistration({ reference }: { reference: string }) {
	return (
		<>
			The company is registered with the Information Commissioner's Office, the UK's data protection
			authority, under the reference {reference}, which anyone can check on{" "}
			<a href={OUTSIDE_LINKS.icoRegister.href} className={LINK}>
				the ICO's register
			</a>
			.
		</>
	);
}
