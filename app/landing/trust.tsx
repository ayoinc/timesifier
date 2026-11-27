import { EXPORT_KEEP_DAYS } from "~/exports/paths";

import { Row, Rows } from "./Document";
import {
	HELLO_EMAIL,
	LINK,
	MAIL_DOMAIN,
	OUTSIDE_LINKS,
	type OutsideLink,
	PRIVACY_EMAIL,
	SECURITY_EMAIL,
} from "./Site";

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
export const DPA_VERSION = { date: "2026-11-27", inWords: "27 November 2026" } as const;

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

/**
 * What Cloudflare R2 holds, in the buckets `RECEIPTS` and `BRAND`: receipts
 * (TS-070), logos (TS-100) and the exports of everything (TS-126), each of
 * which the hourly trigger deletes `EXPORT_KEEP_DAYS` after it is made. The
 * same words on /privacy, /security and /dpa.
 */
export const R2_HOLDS = `receipts, organisations' logos and the exports of everything owners ask for, each export for ${EXPORT_KEEP_DAYS} days`;

/** The parts of wrangler.jsonc that send data to a provider. Each is one sub-processor's. */
export type Binding = "d1_databases" | "r2_buckets" | "send_email" | "observability" | "ratelimits";

/**
 * The terms a sub-processor handles the data on. `processing`: its data
 * processing agreement binds it. `none`: there is no processing agreement; it
 * runs `service` under the terms it offers everyone, and the page says so
 * beside them and its privacy policy.
 */
export type Agreement =
	| { kind: "processing"; dpa: OutsideLink }
	| { kind: "none"; service: string; terms: OutsideLink; privacy: OutsideLink };

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
	/** What binds it, if anything does. */
	agreement: Agreement;
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
			`${R2_HOLDS}, in Cloudflare R2, restricted to the EU`,
			"every email Timesifier sends, with its recipient, through Cloudflare's Email Service",
			`mail sent to ${PRIVACY_EMAIL}, ${SECURITY_EMAIL}, ${HELLO_EMAIL} or any other address at ${MAIL_DOMAIN}, through Cloudflare Email Routing, which forwards it to the company's mailbox`,
			"the check that a person is not a robot before a sign-in code is sent, through Cloudflare Turnstile",
			"what Cloudflare Web Analytics measures of each page",
			`a log line of every request, and a trace of one in ten, kept ${WORKERS_LOGS_DAYS} days`,
		],
		// ratelimits: Cloudflare counts browser error reports by client address (TS-107d).
		// Email Routing is set on the zone, not in wrangler.jsonc: it is no binding.
		bindings: ["d1_databases", "r2_buckets", "send_email", "observability", "ratelimits"],
		agreement: { kind: "processing", dpa: OUTSIDE_LINKS.cloudflareDpa },
		list: OUTSIDE_LINKS.cloudflareSubprocessors,
	},
	{
		// The owner's choice of 27 November 2026: a personal Gmail account, not a paid
		// Google Workspace or Microsoft 365 one, so no processing agreement (decision 79).
		id: "google",
		name: "Google",
		based: "Google LLC, in the United States, which hosts the company's mailbox in Gmail",
		receives: ["the mail that Cloudflare forwards to it"],
		bindings: [],
		agreement: {
			kind: "none",
			service: "Gmail",
			terms: OUTSIDE_LINKS.googleTerms,
			privacy: OUTSIDE_LINKS.googlePrivacy,
		},
	},
];

/**
 * The sub-processors, each with where it is, what it receives, and what binds
 * it, with its own list where it has one: the same rows on /security and /dpa.
 * The anchor of each row is its `id`.
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
					<Bound name={each.name} agreement={each.agreement} list={each.list} />
				</Row>
			))}
		</Rows>
	);
}

/** The line under a sub-processor's row: its agreement and list, or that it has no agreement. */
function Bound({
	name,
	agreement,
	list,
}: {
	name: string;
	agreement: Agreement;
	list: OutsideLink | undefined;
}) {
	switch (agreement.kind) {
		case "processing":
			return (
				<p className="mt-2">
					<a href={agreement.dpa.href} className={LINK}>
						{name}'s data processing agreement
					</a>
					{list && (
						<>
							{" "}
							and{" "}
							<a href={list.href} className={LINK}>
								its own sub-processors
							</a>
						</>
					)}
					.
				</p>
			);
		case "none":
			return (
				<p className="mt-2">
					There is no processing agreement with {name}: {name} runs {agreement.service} under its
					consumer terms.{" "}
					<a href={agreement.terms.href} className={LINK}>
						{name}'s terms of service
					</a>{" "}
					and{" "}
					<a href={agreement.privacy.href} className={LINK}>
						its privacy policy
					</a>
					.
				</p>
			);
	}
}

/** Where the database and the files are, and what is not restricted to the EU: the same words on /security and /dpa. */
export function WhereItIsKept() {
	return (
		<>
			<p>
				In one database, Cloudflare D1, restricted to the European Union: it runs and stores its
				data only inside the EU. Cloudflare R2 holds the {R2_HOLDS}, in buckets restricted to the
				EU, whose files are stored only inside the EU.
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
