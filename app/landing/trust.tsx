import { LINK, OUTSIDE_LINKS, type OutsideLink, PRIVACY_EMAIL, SECURITY_EMAIL } from "./Site";

// What the privacy notice and the security page both state about Timesifier's
// hosting, each fact once (TS-105). Every number here is a provider's, quoted
// beside it; test/claims.test.ts ties each page to these constants.

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
