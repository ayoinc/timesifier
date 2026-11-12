import { env } from "cloudflare:workers";
import * as z from "zod";

import { organisationScope } from "~/db";
import { RECORD_NAME_PROBLEM, recordName } from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import { maySeeRates } from "~/organisations/access";
import type { Membership } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import type { Role } from "~/organisations/roles";

import { ANY_TAG, EVERYONE, RANGE_LABELS } from "./choices";
import { rangeLabel, stepUnit } from "./format";
import { type RangeProblem, rangeDays, reportSearch, type Step, steppedRange } from "./query";
import type { RangeStepLinks } from "./RangeSteps";
import type { ChosenReport, TagChoice } from "./ReportChoice";
import type { RefusedReport, ReportRequest } from "./reports.server";
import { type SavedView, savedQueryOf } from "./saved";
import { changeSavedReport, type SavedReport, savedReportFor, saveReport } from "./saved.server";
import { MONEY_VIEWS, REPORT_VIEWS, type ReportView } from "./views";

/**
 * What every view of Reports shows around its own figures (TS-068, TS-071,
 * TS-080, TS-084): the views this person is shown, the fields that choose the
 * report, the range with Previous and Next, and the saved report it was
 * opened from; and the action that saves it.
 */

/** The views of Reports `role` is shown: the money views only to those who see rates. */
export function viewsFor(role: Role): ReportView[] {
	return REPORT_VIEWS.map(({ id }) => id).filter(
		(id) => maySeeRates(role) || !MONEY_VIEWS.includes(id),
	);
}

/** What a view draws around its figures. */
export interface ViewFrame {
	query: ChosenReport;
	choices: { id: string; name: string }[];
	everyone: string;
	range: string;
	/** The tags the report may be filtered by; none for a view without the filter (TS-085). */
	tags: TagChoice[];
	/** Why the custom range typed makes no report; null when it makes one. */
	problem: RangeProblem | null;
	/** The steps beside the range; null when there is no report to step from. */
	steps: RangeStepLinks | null;
	/** The range and person the tabs carry to the other views, from "?". */
	tabSearch: string;
}

/**
 * The frame of `report`, for a view grouped as it asks when `grouped`, and
 * filtered by tag when given `tags` (TS-085). A refused custom range keeps
 * what was typed, with its problem, and no steps.
 */
export function viewFrame(
	report: ReportRequest | RefusedReport,
	{ grouped, tags = [] }: { grouped: boolean; tags?: TagChoice[] },
): ViewFrame {
	const { query, grouping, choices, seesEveryone } = report;
	const people = {
		choices: choices.length > 1 ? choices.map(({ id, name }) => ({ id, name })) : [],
		tags,
		everyone: seesEveryone ? "Everyone" : "You and your teams",
	};
	if ("problem" in report) {
		return {
			...people,
			query: {
				range: query.range,
				from: query.from ?? "",
				to: query.to ?? "",
				group: grouping,
				person: query.person ?? EVERYONE,
				tag: query.tag ?? ANY_TAG,
			},
			range: "",
			problem: report.problem,
			steps: null,
			tabSearch: "",
		};
	}

	const { days } = report;
	const kept = { group: grouping, person: query.person, tag: grouped ? query.tag : undefined };
	const without = (search: URLSearchParams) => {
		if (!grouped) search.delete("group");
		return search;
	};
	const step = (by: Step) =>
		`?${without(reportSearch({ ...kept, ...steppedRange(query.range, days, by) }))}`;
	const unit = stepUnit(query.range, days);
	// The way back to the week or month holding today, while the range is another.
	const kind = steppedRange(query.range, days, 1).range;
	const back = kind === "custom" ? null : kind === "week" ? "this-week" : "this-month";
	const holdingToday =
		back && rangeDays({ range: back, group: grouping }, report.today, report.weekStartsOn);
	const current =
		back && holdingToday && holdingToday.first !== days.first
			? {
					to: `?${without(reportSearch({ ...kept, range: back, days: holdingToday }))}`,
					label: RANGE_LABELS[back],
				}
			: undefined;
	const tabs = reportSearch({ ...kept, range: query.range, days });
	tabs.delete("group");
	tabs.delete("tag");
	return {
		...people,
		query: {
			range: query.range,
			from: days.first,
			to: days.last,
			group: grouping,
			person: query.person ?? EVERYONE,
			tag: query.tag ?? ANY_TAG,
		},
		range: rangeLabel(days.first, days.last),
		problem: null,
		steps: {
			previous: { to: step(-1), label: `Previous ${unit}` },
			next: { to: step(1), label: `Next ${unit}` },
			current,
		},
		tabSearch: `?${tabs}`,
	};
}

/** The parameter of a view's address that names the saved report it was opened from. */
export const SAVED_PARAM = "saved";

/** The saved report a view was opened from, as the viewer may open it; null for none. */
export async function openedFrom(
	membership: Membership,
	url: URL,
): Promise<Pick<SavedReport, "id" | "name" | "canEdit"> | null> {
	const id = url.searchParams.get(SAVED_PARAM);
	if (!id || id.length > 64) return null;
	const scope = organisationScope(env.DB, membership.organisation.id);
	const report = await savedReportFor(scope, membership.user.id, id);
	return report && { id: report.id, name: report.name, canEdit: report.canEdit };
}

const ViewForm = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("save-report"), name: z.string() }),
	z.object({ intent: z.literal("update-saved"), savedId: z.string().min(1).max(64) }),
]);

/**
 * The action of every view that can be saved: "save-report" saves the report
 * on show under a name, as the viewer's; "update-saved" makes the saved
 * report it was opened from ask what is on show now, for its owner or a
 * person it is shared with to edit. The report is read from the address the
 * form was posted to, which is the view's own.
 */
export async function viewAction(request: Request, membership: Membership, view: SavedView) {
	const input = await parseRequest(request, ViewForm);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const query = savedQueryOf(view, new URL(request.url).searchParams);
	if (query === null) return declined("This report can't be saved: choose a range first.");
	if (input.intent === "save-report") {
		const name = recordName(input.name);
		if (name === null) return declined(RECORD_NAME_PROBLEM);
		await saveReport(scope, membership.user.id, name, query);
		return done(`Saved as “${name}”. Find it under Saved.`);
	}
	const changed = await changeSavedReport(scope, membership.user.id, input.savedId, { query });
	if (!changed) return declined("You can't change that saved report.", 404);
	return done("Saved report updated: it now asks what is on show.");
}
