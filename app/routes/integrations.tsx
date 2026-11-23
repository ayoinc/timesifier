import { env } from "cloudflare:workers";
import type { ReactNode } from "react";
import { IMPORT_MAX_ROWS } from "~/import/import.server";
import { FIELD_LABELS, TIME_FIELDS } from "~/import/mapping";
import { API_RATE_LIMIT } from "~/integrations/api-tokens.server";
import { ENTRY_DAYS_BACK } from "~/integrations/feeds.server";
import { OPENAPI_PATH } from "~/integrations/paths";
import { EVENT_LABELS, SCOPE_LABELS } from "~/integrations/scopes";
import { BACKOFF_MINUTES, SWITCH_OFF_AFTER } from "~/integrations/webhooks.server";
import { XERO_COLUMNS } from "~/invoices/xero";
import { BuyerPage } from "~/landing/BuyerPage";
import { inWords } from "~/landing/capabilities";
import { deploymentOperator } from "~/landing/operator";
import { SECTION, SectionHead } from "~/landing/Section";
import { API_DOCS_PATH, INTEGRATIONS_PATH, LINK, pageMeta, rootOrigin } from "~/landing/Site";

import type { Route } from "./+types/integrations";

// What Timesifier connects to, as it is built (TS-106): the API, webhooks,
// calendar feeds, the CSV import and export, and the CSV for Xero. The numbers
// are the code's own, read by the loader; test/claims.test.ts holds the words.

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: INTEGRATIONS_PATH,
		title: "Integrations · Timesifier",
		description:
			"Timesifier's API with scoped tokens, signed webhooks, calendar feeds of time off, Harvest-format CSV import and export, and invoices as a CSV for Xero.",
	});
}

/** The company that runs this deployment, and the limits the page states, from the code that enforces them. */
export function loader() {
	return {
		operator: deploymentOperator(env),
		rateLimit: API_RATE_LIMIT,
		attempts: BACKOFF_MINUTES.length + 1,
		switchOffAfter: SWITCH_OFF_AFTER,
		retryHours: Math.round(BACKOFF_MINUTES.reduce((sum, minutes) => sum + minutes, 0) / 60),
		entryDaysBack: ENTRY_DAYS_BACK,
		importMaxRows: IMPORT_MAX_ROWS,
	};
}

const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function Integration({
	id,
	title,
	lead,
	children,
}: {
	id: string;
	title: string;
	lead: ReactNode;
	children: ReactNode;
}) {
	return (
		<section id={id} aria-labelledby={`${id}-heading`} className="border-t border-outline-variant">
			<div className={SECTION}>
				<SectionHead id={`${id}-heading`} title={title}>
					{lead}
				</SectionHead>
				<div className="mt-10 grid gap-6 text-body-large expanded:grid-cols-12">
					<div className="flex flex-col gap-4 expanded:col-span-7 expanded:col-start-6">
						{children}
					</div>
				</div>
			</div>
		</section>
	);
}

export default function Integrations({
	loaderData: {
		operator,
		rateLimit,
		attempts,
		retryHours,
		switchOffAfter,
		entryDaysBack,
		importMaxRows,
	},
}: Route.ComponentProps) {
	return (
		<BuyerPage
			path={INTEGRATIONS_PATH}
			title="What it connects to."
			lead={
				<p>
					Five ways in and out, each in the application now and on every plan. An owner or admin
					sets up the API and webhooks on Integrations; each person makes their own calendar feed.
				</p>
			}
			operator={operator}
		>
			<Integration
				id="api"
				title="The API"
				lead="Read time, people, projects, leave, expenses and invoices, and write time entries, with a token."
			>
				<p>
					A token acts as the person who made it, with their role, and no further than the scopes
					chosen when it was made:
				</p>
				<ul className="flex flex-col">
					{Object.values(SCOPE_LABELS).map((label) => (
						<li key={label} className="border-t border-outline-variant py-3">
							{label}
						</li>
					))}
				</ul>
				<p>
					A token may make {rateLimit.max} requests in any {rateLimit.seconds} seconds. Every change
					it makes is in the activity log, marked as made through the API.
				</p>
				<p className="flex flex-wrap gap-x-6 gap-y-2">
					<a href={API_DOCS_PATH} className={LINK}>
						The API reference
					</a>
					<a href={OPENAPI_PATH} className={LINK}>
						The OpenAPI description (YAML)
					</a>
				</p>
			</Integration>

			<Integration
				id="webhooks"
				title="Webhooks"
				lead="An address of yours is told of each change within a minute, signed so you know it came from Timesifier."
			>
				<p>
					A webhook hears about{" "}
					{inWords(Object.values(EVENT_LABELS).map((label) => label.toLowerCase()))}. Each delivery
					is signed with HMAC-SHA-256 and the webhook's own secret.
				</p>
				<p>
					A delivery that is not answered is tried {COUNT[attempts]} times in all, over {retryHours}{" "}
					hours. After {COUNT[switchOffAfter]} failed deliveries in a row the webhook is switched
					off, and its maker is told by email.
				</p>
			</Integration>

			<Integration
				id="calendar"
				title="Calendar feeds"
				lead="Time off, in the calendar a person already reads."
			>
				<p>
					A person's feed holds their approved time off and, if they choose, their entries of the
					last {entryDaysBack} days. A manager can make one of a team they manage: its members'
					approved time off. Any calendar that subscribes to an address reads it.
				</p>
			</Integration>

			<Integration
				id="csv"
				title="CSV import and export"
				lead="Bring the hours from Harvest, or from a spreadsheet, and take them away again."
			>
				<p>
					Import time from a CSV in Harvest's columns, or Harvest's own export of all time, up to{" "}
					{importMaxRows.toLocaleString("en-GB")} rows at a time. The columns read are{" "}
					{inWords(TIME_FIELDS.map((field) => FIELD_LABELS[field] ?? field))}. Nothing is written
					until the preview is confirmed, and an import of time can be reverted.
				</p>
				<p>
					Export all time in the same columns, so it imports again, and every invoice as a PDF in
					one ZIP.
				</p>
			</Integration>

			<Integration
				id="xero"
				title="Xero"
				lead="Issued invoices, as the CSV Xero's sales-invoice import reads."
			>
				<p>
					Export for Xero, on Invoices, downloads the issued invoices of a range as a CSV in Xero's{" "}
					{XERO_COLUMNS.length} columns, one row a line, ready for Xero's import of sales invoices.
					There is no live connection to Xero.
				</p>
			</Integration>
		</BuyerPage>
	);
}
