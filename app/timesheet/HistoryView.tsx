import { Link } from "react-router";

import { cx } from "~/components/cx";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";

import { formatDuration } from "./durations";
import { usePeriodFormat } from "./format";
import { PERIOD_STATE_LABELS } from "./sheets";
import type { HistoryData } from "./timesheet.server";
import { weekPath } from "./views";

/**
 * History (TS-046): the person's periods, newest first, from this one back to
 * the first with an entry or a submission, each with its status and total. A
 * returned one says why. Each opens its Week view. The period that holds
 * today is amber (taste HT-B).
 */
export function HistoryView({ data, slug }: { data: HistoryData; slug: string }) {
	const formatPeriod = usePeriodFormat();
	return (
		<div className="mt-8 max-w-200">
			<Ledger heading="Your periods" note={data.rows.length}>
				<LedgerRows label="Periods">
					{data.rows.map((row) => {
						const label = formatPeriod(row.startsOn, row.endsOn);
						const isCurrent = row.startsOn <= data.today && data.today <= row.endsOn;
						return (
							<LedgerRow
								key={row.startsOn}
								className={cx(
									isCurrent &&
										"-mx-4 bg-primary-container px-4 text-on-primary-fixed @sm:-mx-5 @sm:px-5",
								)}
								title={
									<Link
										to={weekPath(slug, row.startsOn)}
										className="rounded-extra-small underline-offset-4 outline-none hover:underline focus-visible:focus-indicator"
									>
										{label}
										{isCurrent && <span className="sr-only"> (this week)</span>}
									</Link>
								}
								detail={
									<span className={isCurrent ? "text-on-primary-fixed" : undefined}>
										{PERIOD_STATE_LABELS[row.state]}
										{row.comment && (
											<span className="block wrap-anywhere">Reason: {row.comment}</span>
										)}
									</span>
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
