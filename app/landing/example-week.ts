// The example the home page shows: one person's week, Monday 9 to Friday 13
// November 2026. Only entries and minutes are written down. Every total on the
// page is added up from them here, so a total can never disagree with what is
// shown above it (docs/design-direction.md, "Round the number").

export const WEEK_LABEL = "Week 46, 9 to 13 November 2026";

export const DAYS = [
	{ name: "Monday", short: "Mon", date: 9 },
	{ name: "Tuesday", short: "Tue", date: 10 },
	{ name: "Wednesday", short: "Wed", date: 11 },
	{ name: "Thursday", short: "Thu", date: 12 },
	{ name: "Friday", short: "Fri", date: 13 },
] as const;

/** The day the page treats as today. */
export const TODAY = 2;

export const PROJECTS = ["Website rebuild", "Harbour survey", "Annual accounts", "Admin"] as const;
export type Project = (typeof PROJECTS)[number];

/** Minutes worked on each project on each day of the week, Monday first. */
const MINUTES: Record<Project, readonly [number, number, number, number, number]> = {
	"Website rebuild": [195, 240, 150, 210, 120],
	"Harbour survey": [120, 90, 165, 0, 180],
	"Annual accounts": [60, 0, 45, 150, 0],
	Admin: [45, 30, 30, 45, 60],
};

export interface Entry {
	/** Minutes after midnight. */
	start: number;
	end: number;
	note: string;
	project: Project;
}

const at = (hours: number, minutes: number) => hours * 60 + minutes;

/** Wednesday's entries in the order they were worked. The last is the one the timer made. */
export const TODAY_ENTRIES: readonly Entry[] = [
	{ start: at(8, 45), end: at(9, 15), note: "Inbox and invoices", project: "Admin" },
	{
		start: at(9, 15),
		end: at(11, 45),
		note: "Navigation and page templates",
		project: "Website rebuild",
	},
	{
		start: at(12, 30),
		end: at(13, 15),
		note: "Receipts for October",
		project: "Annual accounts",
	},
	{ start: at(13, 15), end: at(16, 0), note: "Tide tables, section 3", project: "Harbour survey" },
];

/** The entry that is still running in the picture of the day, and how long it has run. */
export const RUNNING = {
	entry: TODAY_ENTRIES[3] as Entry,
	elapsed: "1:47:32",
};

/** The entries finished before the running one started. */
export const LOGGED_ENTRIES = TODAY_ENTRIES.slice(0, 3);

const sum = (minutes: readonly number[]) => minutes.reduce((total, each) => total + each, 0);

export const length = (entry: Entry) => entry.end - entry.start;

export const loggedToday = sum(LOGGED_ENTRIES.map(length));

export const week = PROJECTS.map((project) => ({
	project,
	days: MINUTES[project],
	total: sum(MINUTES[project]),
}));

export const dayTotals = DAYS.map((_, day) => sum(week.map((row) => row.days[day] ?? 0)));

export const weekTotal = sum(dayTotals);

/** The most minutes any project has: the width the bars are drawn against. */
export const longestProject = Math.max(...week.map((row) => row.total));

/** A length of time as hours and minutes: 150 is "2:30". */
export function duration(minutes: number): string {
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A time of day on the 24-hour clock: 555 is "09:15". */
export function clock(minutes: number): string {
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
