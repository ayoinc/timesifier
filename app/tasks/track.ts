import { createContext } from "react";

import type { TeamChoices } from "~/projects/teams";
import type { WorkPackageChoice } from "~/projects/work-packages";
import type { TagChoice } from "~/tags/tags";
import type { Day } from "~/time/calendar";

/**
 * What the Timesheet gives Track time and an entry's sheet beside the
 * projects (TS-066, TS-085, TS-069), read by `trackChoices` and handed down
 * through `TrackChoicesContext`, so the views pass nothing new along.
 */

/** A task on one project's list. */
export interface TaskChoice {
	id: string;
	name: string;
	billable: boolean;
	archived: boolean;
}

export interface TrackChoices {
	/** Each project's tasks, by project id, by name. */
	tasks: Record<string, TaskChoice[]>;
	/** Every tag of the organisation; the archived ones are offered only where already on the entry. */
	tags: TagChoice[];
	/** The projects whose people are warned that they are over budget. */
	overBudget: string[];
	/** The task, work package and tags of each entry the view shows, by entry id. */
	entries: Record<
		string,
		{ taskId: string | null; workPackageId: string | null; tagIds: string[] }
	>;
	/** The person's recent projects, most recent first, archived ones left out: the head of the project picker. */
	recent: string[];
	/** The projects the person pinned, in the order they pinned them: first in the project picker (TS-122, S2-09). */
	pinned: string[];
	/** What the picker shows and groups by beside each active project's name, by project id (TS-115a). */
	projects: Record<string, ProjectChoice>;
	/**
	 * Every project's work packages by project id, by code (TS-115b): the open
	 * ones are offered, and every one is named, so an entry on a closed or
	 * archived one still says which.
	 */
	workPackages: Record<string, WorkPackageChoice[]>;
	/**
	 * The person's place on each project's team, and whether the organisation
	 * tracks by assignment (TS-115c): their projects head the picker, and under
	 * assignment it offers only the projects they are on the team of on the
	 * entry's day, and those they may add themselves to. `today` is the day an
	 * entry with no day of its own is on.
	 */
	team: TeamChoices & { today: Day };
}

/**
 * An active project as the picker offers it: its code, its client with the
 * client's code (null where it has none, or where the organisation shows no
 * clients), and whether it is a work code, a project with no client that is
 * not billable, grouped apart where the organisation works by both (TS-115a).
 */
export interface ProjectChoice {
	code: string | null;
	client: { name: string; code: string | null } | null;
	workCode: boolean;
}

/** The form field that sends an entry's task. */
export const TASK_FIELD = "taskId";

/** The warning a person tracking to an over-budget project is shown (TS-069). */
export const OVER_BUDGET = "This project is over budget.";

/** Null outside the Timesheet, where Track time offers the project alone. */
export const TrackChoicesContext = createContext<TrackChoices | null>(null);
