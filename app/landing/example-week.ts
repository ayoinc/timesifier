// The example the home page shows: one person's week, Monday 9 to Friday 13
// November. Only entries and minutes are written down. Every total on the
// page is added up from them here, so a total can never disagree with what is
// shown above it (docs/design-direction.md, "Round the number").

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
	"Harbour survey": [120, 90, 175, 0, 180],
	"Annual accounts": [60, 0, 50, 150, 0],
	Admin: [45, 30, 25, 45, 60],
};

export interface Entry {
	/** Minutes after midnight. */
	start: number;
	end: number;
	note: string;
	project: Project;
}

/**
 * Wednesday is worked in the rhythm of the Pomodoro Technique, Francesco
 * Cirillo's method: a stretch of 25 minutes of work, a short break, and a longer
 * break after every fourth stretch. Timesifier does not run that rhythm; the
 * person does, and each stretch is an entry because they started and stopped the
 * timer. The breaks are the times no entry covers.
 */
export const RHYTHM = { stretch: 25, shortBreak: 5, longBreak: 20, stretchesToLongBreak: 4 };

const at = (hours: number, minutes: number) => hours * 60 + minutes;

/** What each stretch of Wednesday was spent on, in order. Lunch follows the eighth. */
const STRETCHES: readonly (readonly [note: string, project: Project])[] = [
	["Inbox and invoices", "Admin"],
	["Navigation, desktop", "Website rebuild"],
	["Navigation, phone", "Website rebuild"],
	["Page templates", "Website rebuild"],
	["Tide tables, section 3", "Harbour survey"],
	["Tide tables, section 4", "Harbour survey"],
	["Chart corrections", "Harbour survey"],
	["Survey log", "Harbour survey"],
	["Receipts for October", "Annual accounts"],
	["Bank reconciliation", "Annual accounts"],
	["Article template", "Website rebuild"],
	["Forms and errors", "Website rebuild"],
	["Review with the client", "Website rebuild"],
	["Soundings, north quay", "Harbour survey"],
	["Soundings, south quay", "Harbour survey"],
	["Report draft", "Harbour survey"],
];

const LUNCH = { after: 8, minutes: 45 };

/** Wednesday's entries in the order they were worked: one for each stretch. */
export const TODAY_ENTRIES: readonly Entry[] = (() => {
	const entries: Entry[] = [];
	let start = at(8, 30);
	for (const [index, [note, project]] of STRETCHES.entries()) {
		const end = start + RHYTHM.stretch;
		entries.push({ start, end, note, project });
		const done = index + 1;
		if (done === LUNCH.after) start = end + LUNCH.minutes;
		else if (done % RHYTHM.stretchesToLongBreak === 0) start = end + RHYTHM.longBreak;
		else start = end + RHYTHM.shortBreak;
	}
	return entries;
})();

/** How many of the day's stretches are finished in the picture of the day: the first four, then a longer break. */
const FINISHED = RHYTHM.stretchesToLongBreak;

/**
 * The entry that is still running in the picture of the day, and for how many
 * seconds it has run in the still example: 0:14:32.
 */
export const RUNNING = {
	entry: TODAY_ENTRIES[FINISHED] as Entry,
	elapsedSeconds: (14 * 60 + 32) as number,
};

/** The entries finished before the running one started. */
export const LOGGED_ENTRIES = TODAY_ENTRIES.slice(0, FINISHED);

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

/** A running length of time to the second: 872 is "0:14:32". */
export function stopwatch(seconds: number): string {
	return `${duration(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A time of day on the 24-hour clock: 555 is "09:15". Past midnight it starts again. */
export function clock(minutes: number): string {
	const ofDay = ((minutes % 1440) + 1440) % 1440;
	return `${String(Math.floor(ofDay / 60)).padStart(2, "0")}:${String(ofDay % 60).padStart(2, "0")}`;
}
