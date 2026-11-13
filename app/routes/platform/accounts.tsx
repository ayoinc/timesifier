import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { TextField } from "~/components/TextField";
import { platformData } from "~/db";
import { consoleDay } from "~/platform/console-words";
import { accountConsolePath } from "~/platform/paths";
import { TEXT_LINK } from "~/shell/links";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/accounts";

// Accounts in the platform console (TS-099): every person with a Timesifier
// account, newest first, or those whose name or address holds what was
// searched for. Here the address is shown under each name, because it is what
// a platform owner is asked about and searches by; an account with no name yet
// is listed by its address.

const HEADING = "Accounts";

/** The most rows the page lists; a search narrows them. */
const SHOWN = 50;
/** The longest search kept: the longest address there is. */
const QUERY_MAX_LENGTH = 254;

export function meta() {
	return [{ title: `${HEADING} · Timesifier` }];
}

export async function loader({ request }: Route.LoaderArgs) {
	const query = (new URL(request.url).searchParams.get("q") ?? "")
		.trim()
		.slice(0, QUERY_MAX_LENGTH);
	const rows = await platformData.platformAccounts(env.DB, query, SHOWN);
	return {
		query,
		accounts: rows.map((row) => ({
			id: row.id,
			name: row.name.trim(),
			email: row.email,
			joined: consoleDay(row.createdAt),
			closed: row.closedAt !== null,
		})),
	};
}

export default function Accounts({ loaderData }: Route.ComponentProps) {
	const { query, accounts } = loaderData;
	const heading = query ? `Accounts matching “${query}”` : "Newest accounts";

	return (
		<>
			<PageHeading>{HEADING}</PageHeading>
			<PageLead>
				Everyone with a Timesifier account. Open one to see its organisations, sign-ins and
				invitations, and to help its owner with it.
			</PageLead>

			<Form method="get" role="search" className="mt-6 flex max-w-200 flex-wrap items-end gap-4">
				<div className="min-w-64 flex-1">
					<TextField
						label="Name or address"
						name="q"
						type="search"
						defaultValue={query}
						autoComplete="off"
						maxLength={QUERY_MAX_LENGTH}
					/>
				</div>
				<Button type="submit" variant="outlined">
					Search
				</Button>
			</Form>

			{accounts.length === 0 ? (
				<EmptySheet heading={heading}>
					{query ? "No account has that in its name or address." : "Nobody has an account yet."}
				</EmptySheet>
			) : (
				<div className="mt-10 max-w-200">
					<Ledger
						heading={heading}
						note={accounts.length === SHOWN ? `The first ${SHOWN}` : `${accounts.length} shown`}
					>
						<LedgerRows>
							{accounts.map((account) => (
								<LedgerRow
									key={account.id}
									title={
										<Link
											to={accountConsolePath(account.id)}
											className={`${TEXT_LINK} wrap-anywhere`}
										>
											{account.name || account.email}
										</Link>
									}
									detail={
										<>
											{account.name ? (
												<span className="wrap-anywhere">{account.email}</span>
											) : (
												"No name yet"
											)}
											. Joined {account.joined}.
											{account.closed && <strong className="ms-1 text-error">Closed</strong>}
										</>
									}
								/>
							))}
						</LedgerRows>
					</Ledger>
				</div>
			)}
		</>
	);
}
