import { Link } from "react-router";

import { cx } from "~/components/cx";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";

import type { Aim } from "./aim";
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
export function HistoryView({
	data,
	slug,
	aim,
}: {
	data: HistoryData;
	slug: string;
	/** Another view on its way, pressed before the server answers it: History dims until it comes (TS-114). */
	aim: Aim | null;
}) {
	const formatPeriod = usePeriodFormat();
	return (
		<div className={cx("mt-8 max-w-200", aim !== null && aim.view !== "history" && "awaiting")}>
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
										aria-current={isCurrent ? "date" : undefined}
										className="rounded-extra-small underline-offset-4 outline-none hover:underline focus-visible:focus-indicator"
									>
										{label}
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
