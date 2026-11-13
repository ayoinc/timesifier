import { env } from "cloudflare:workers";

import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { platformData } from "~/db";
import { consoleDay } from "~/platform/console-words";
import { DAILY_MAIL_CAP } from "~/platform/limits";
import { capLeft } from "~/platform/mail.server";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import type { Route } from "./+types/health";

// The console's first page (TS-099): how the platform is doing, in counts
// alone. Accounts and new accounts, people active lately, how many of a
// month's new accounts came back, organisations, and the day's mail against its cap.

const HEADING = "Health";

export function meta() {
	return [{ title: `${HEADING} · Timesifier` }];
}

export async function loader() {
	const now = new Date();
	const [health, left] = await Promise.all([
		platformData.platformHealth(env.DB, now),
		capLeft(now),
	]);
	return {
		...health,
		weekly: health.weekly.map(({ from, count }) => ({ from: consoleDay(from), count })),
		mailSentToday: DAILY_MAIL_CAP - left,
		mailCap: DAILY_MAIL_CAP,
	};
}

const NUMBER = new Intl.NumberFormat("en-GB");

/** "1 account", "12 accounts". */
function counted(n: number, one: string, many: string): string {
	return `${NUMBER.format(n)} ${n === 1 ? one : many}`;
}

export default function Health({ loaderData }: Route.ComponentProps) {
	const health = loaderData;
	const busiest = Math.max(1, ...health.weekly.map(({ count }) => count));
	const { cohort, retained } = health.retention;

	return (
		<>
			<PageHeading>{HEADING}</PageHeading>
			<PageLead>
				How many people use Timesifier and how lately, in counts. Nothing here is any organisation's
				own data.
			</PageLead>

			<Section id="accounts" heading="Accounts" lead="Open accounts; closed ones are not counted.">
				<Ledger heading="People">
					<LedgerRows>
						<LedgerRow title="Accounts" value={NUMBER.format(health.accounts)} />
						<LedgerRow title="New in the last 7 days" value={NUMBER.format(health.newAccounts7)} />
						<LedgerRow
							title="New in the last 30 days"
							value={NUMBER.format(health.newAccounts30)}
						/>
						<LedgerRow
							title="Active in the last 7 days"
							detail="People who used a session."
							value={NUMBER.format(health.active7)}
						/>
						<LedgerRow title="Active in the last 30 days" value={NUMBER.format(health.active30)} />
						<LedgerRow title="Organisations" value={NUMBER.format(health.organisations)} />
					</LedgerRows>
				</Ledger>
			</Section>

			<Section
				id="new-accounts"
				heading="New accounts by week"
				lead="New accounts in each of the last eight weeks, oldest first."
			>
				<Ledger heading="Weeks">
					<LedgerRows>
						{health.weekly.map(({ from, count }) => (
							<LedgerRow
								key={from}
								title={`Week from ${from}`}
								detail={
									// The bar repeats the figure at the row's end, so it is hidden from
									// assistive technology. Its colour is the theme's, light or dark.
									<span
										aria-hidden="true"
										className="mt-2 block h-2 rounded-full bg-surface-variant"
									>
										<span
											className="block h-2 rounded-full bg-primary"
											style={{ width: `${(count / busiest) * 100}%` }}
										/>
									</span>
								}
								value={NUMBER.format(count)}
							/>
						))}
					</LedgerRows>
				</Ledger>
			</Section>

			<Section id="retention" heading="Coming back">
				<p className="max-w-160 text-body-large">
					{cohort === 0
						? "Nobody signed up between four and eight weeks ago, so there is nobody yet to count coming back."
						: `Of the ${counted(cohort, "person", "people")} who signed up between four and eight weeks ago, ${NUMBER.format(retained)} used Timesifier in the last 7 days (${Math.round((retained / cohort) * 100)}%).`}
				</p>
			</Section>

			<Section id="mail" heading="Mail today">
				<p className="max-w-160 text-body-large">
					{counted(health.mailSentToday, "message", "messages")} of mailings sent today, of the{" "}
					{NUMBER.format(health.mailCap)} a day may take. What is left waits for tomorrow.
				</p>
			</Section>
		</>
	);
}
