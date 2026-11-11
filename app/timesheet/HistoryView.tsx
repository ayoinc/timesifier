import { Link } from "react-router";

import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";

import { formatDuration } from "./durations";
import { usePeriodFormat } from "./format";
import { PERIOD_STATE_LABELS } from "./sheets";
import type { HistoryData } from "./timesheet.server";
import { weekPath } from "./views";

/**
 * History (TS-046): the person's periods, newest first, from this one back to
 * the first with an entry or a submission, each with its status and total. A
 * returned one says why. Each opens its Week view.
 */
export function HistoryView({ data, slug }: { data: HistoryData; slug: string }) {
	const formatPeriod = usePeriodFormat();
	return (
		<div className="mt-8 max-w-200">
			<Ledger heading="Your periods" note={data.rows.length}>
				<LedgerRows label="Periods">
					{data.rows.map((row) => {
						const label = formatPeriod(row.startsOn, row.endsOn);
						return (
							<LedgerRow
								key={row.startsOn}
								title={
									<Link
										to={weekPath(slug, row.startsOn)}
										className="rounded-extra-small underline-offset-4 outline-none hover:underline focus-visible:focus-indicator"
									>
										{label}
									</Link>
								}
								detail={
									<>
										{PERIOD_STATE_LABELS[row.state]}
										{row.comment && (
											<span className="block wrap-anywhere">Reason: {row.comment}</span>
										)}
									</>
								}
								value={formatDuration(row.total)}
							/>
						);
					})}
				</LedgerRows>
			</Ledger>
		</div>
	);
}
