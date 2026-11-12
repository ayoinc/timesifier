/**
 * The choices a report offers (TS-014a): its ranges and its groupings, with
 * the words the page shows for them. The page's own bundle takes these, and
 * nothing that builds a schema: an object schema tests on creation whether it
 * may compile code, which the Content Security Policy refuses and reports.
 */

/**
 * `week` and `month` are the week or the calendar month holding the day in
 * `from`: where Previous and Next take a report (TS-059). The others are
 * relative to today, so a saved report that names one moves with the date
 * (TS-080).
 */
export const RANGES = [
	"this-week",
	"last-week",
	"this-month",
	"last-month",
	"week",
	"month",
	"custom",
] as const;
export type Range = (typeof RANGES)[number];

export const RANGE_LABELS: Record<Range, string> = {
	"this-week": "This week",
	"last-week": "Last week",
	"this-month": "This month",
	"last-month": "Last month",
	week: "Week",
	month: "Month",
	custom: "Custom range",
};

export const GROUPS = ["project", "client", "day"] as const;
export type Grouping = (typeof GROUPS)[number];

export const GROUP_LABELS: Record<Grouping, string> = {
	project: "Project",
	client: "Client",
	day: "Day",
};

/** The value of the person field that chooses nobody in particular: every person the viewer may see. */
export const EVERYONE = "everyone";

/** The tag filter's value that filters nothing: every tag and none (TS-085). No tag's id is this word. */
export const ANY_TAG = "any";
