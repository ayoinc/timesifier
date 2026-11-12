import { Link } from "react-router";

import { LinkTabs } from "~/components/LinkTabs";
import { ACTION_LINK } from "~/shell/links";

import { REPORT_VIEWS, type ReportView, reportViewPath } from "./views";

// The views of Reports as a row of link tabs (TS-091's LinkTabs): each is an
// address of its own, and the one on screen is marked by `aria-current`. A
// tab keeps the range and the person of the view it is on, so moving between
// views keeps the question being asked. The tabs are the one way in to each
// view, Expenses and Contractors included (TS-092). Saved reports are a list,
// not a view of time, so they are a link under the row. Six tabs do not fit a
// 390px window, so there each keeps its own width and the row scrolls
// sideways (Profitability is "Profit" there); from medium up they share it.

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
			<div className="overflow-x-auto">
				<div className="min-w-max medium:min-w-0">
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
				</div>
			</div>
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
