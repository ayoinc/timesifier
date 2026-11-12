import { Link } from "react-router";

import { LinkTabs } from "~/components/LinkTabs";
import { ACTION_LINK } from "~/shell/links";

import { REPORT_VIEWS, type ReportView, reportViewPath } from "./views";

// The views of Reports as a row of link tabs (TS-091's LinkTabs): each is an
// address of its own, and the one on screen is marked by `aria-current`. A
// tab keeps the range and the person of the view it is on, so moving between
// views keeps the question being asked. Saved reports are a list, not a view
// of time, so they are a link under the row, which keeps four tabs inside a
// 390px window (Profitability is "Profit" there).

export function ReportTabs({
	slug,
	current,
	views,
	search,
}: {
	slug: string;
	current: ReportView;
	/** The views this person is shown, in their order. */
	views: readonly ReportView[];
	/** The range and person the tabs carry, from "?", or empty. */
	search: string;
}) {
	return (
		<div className="mt-8">
			<LinkTabs
				label="Report views"
				current={current}
				tabs={REPORT_VIEWS.filter(({ id }) => id !== "saved" && views.includes(id)).map(
					({ id, label }) => ({
						id,
						label:
							id === "profitability" ? (
								<>
									<span className="medium:hidden">Profit</span>
									<span className="max-medium:hidden">{label}</span>
								</>
							) : (
								label
							),
						to: reportViewPath(slug, id, search),
					}),
				)}
			/>
			{current !== "saved" && (
				<p className="mt-3 flex justify-end">
					<Link to={reportViewPath(slug, "saved", "")} className={ACTION_LINK}>
						Saved reports
					</Link>
				</p>
			)}
		</div>
	);
}
