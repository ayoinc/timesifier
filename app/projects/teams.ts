import * as z from "zod";

import type { Day } from "../time/calendar";

/**
 * Project teams (TS-115c, docs/decisions.md entry 75): what the browser and
 * the server share. The rules that read the database are in `teams.server.ts`.
 */

/**
 * Who may track time to a project, the organisation's `project_tracking`:
 * anyone in it, or only the people on the project's team on the entry's day.
 */
export const PROJECT_TRACKINGS = ["anyone", "assigned"] as const;
export const ProjectTracking = z.enum(PROJECT_TRACKINGS);
export type ProjectTracking = z.infer<typeof ProjectTracking>;

/** Each answer as Workspace settings offers it, and as the activity log names it. */
export const PROJECT_TRACKING_LABELS: Record<ProjectTracking, string> = {
	anyone: "Anyone",
	assigned: "Assigned people only",
};

/** What each answer means, under its label. */
export const PROJECT_TRACKING_HINTS: Record<ProjectTracking, string> = {
	anyone: "Everyone in the organisation can track time to any active project.",
	assigned:
		"People track time to a project only on the days they are on its team. Owners, admins and its delivery managers can add themselves.",
};

/** A person's place on a project's team. */
export const TEAM_ROLES = ["member", "delivery_manager"] as const;
export const TeamRole = z.enum(TEAM_ROLES);
export type TeamRole = z.infer<typeof TeamRole>;

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
	member: "Member",
	delivery_manager: "Delivery manager",
};

/** What made an assignment. */
export type AssignmentSource = "manual" | "import" | "contract";

/** One stretch of a person on a project's team: from `startsOn` to `endsOn`, null while open. */
export interface Stretch {
	startsOn: Day;
	endsOn: Day | null;
}

/** Whether `stretch` covers `day`. */
export function covers(stretch: Stretch, day: Day): boolean {
	return stretch.startsOn <= day && (stretch.endsOn === null || day <= stretch.endsOn);
}

/** Whether two stretches share a day. An open one runs to the end of time. */
export function overlaps(a: Stretch, b: Stretch): boolean {
	return a.startsOn <= (b.endsOn ?? "9999-12-31") && b.startsOn <= (a.endsOn ?? "9999-12-31");
}

/**
 * What the Timesheet's picker knows of the person's teams (TS-115c): whether
 * the organisation tracks by assignment, the person's own stretches on each
 * project's team, and the projects they may add themselves to, so it offers
 * their projects first and, where tracking is by assignment, only the
 * projects they may track to on the day, or join.
 */
export interface TeamChoices {
	tracking: ProjectTracking;
	/** The person's stretches on each project's team, by project id. */
	mine: Record<string, (Stretch & { role: TeamRole })[]>;
	/** Whether they may add themselves to any project's team: an owner or an admin. */
	joinsAny: boolean;
}

/** Whether the person behind `team` is on `projectId`'s team on `day`. */
export function onTeam(team: TeamChoices, projectId: string, day: Day): boolean {
	return (team.mine[projectId] ?? []).some((stretch) => covers(stretch, day));
}

/** Whether the person behind `team` may track to `projectId` on `day`. */
export function mayTrackTo(team: TeamChoices, projectId: string, day: Day): boolean {
	return team.tracking === "anyone" || onTeam(team, projectId, day);
}

/**
 * Whether a stretch makes its person one of the project's delivery managers
 * on `today`: a delivery manager's stretch not ended before it. One whose
 * stretch as delivery manager has ended leads the project no longer.
 */
export function leadsFrom(stretch: Stretch & { role: string }, today: Day): boolean {
	return (
		stretch.role === "delivery_manager" && (stretch.endsOn === null || stretch.endsOn >= today)
	);
}

/**
 * Whether the person behind `team` may add themselves to `projectId`'s team
 * in one step from the picker: an owner or an admin, or one of its delivery
 * managers, on another day.
 */
export function mayJoin(team: TeamChoices, projectId: string, today: Day): boolean {
	return team.joinsAny || (team.mine[projectId] ?? []).some((stretch) => leadsFrom(stretch, today));
}

/** What a refused entry says of the project's team, wherever it came from. */
export const TEAM_REFUSAL =
	"You are not on this project's team on that day, so it takes no time from you. Ask its delivery manager to add you.";

/** What the picker says of a project the person is not on the team of, but may join. */
export function joinNote(projectName: string): string {
	return `You are not on ${projectName}'s team on this day.`;
}

/** Why a change to a team was not made. */
export type TeamProblem = "not-member" | "overlaps" | "ends-before-start" | "has-time";

export const TEAM_PROBLEMS: Record<TeamProblem, string> = {
	"not-member": "Choose a member of this organisation.",
	overlaps:
		"They are already on this project's team on some of those days. End that stretch first, or start this one after it.",
	"ends-before-start": "The last day is on or after the first.",
	"has-time":
		"They have tracked time to this project in that stretch, so it cannot be removed. End it instead.",
};

/** What a person who may not add themselves to a project's team is told. */
export const NOT_JOINABLE =
	"Owners, admins and a project's delivery managers add themselves to its team. Ask its delivery manager to add you.";

/** What a delivery manager is told who tries to name, or change, a delivery manager. */
export const NAMES_LEADS_ONLY =
	"Owners, admins and the client's account managers name a project's delivery managers.";

/** The button that adds the person to the project's team. */
export const JOIN_LABEL = "Add me to the team";

/** The form's intent that adds the person to a project's team from the picker. */
export const JOIN_INTENT = "join-team";

/** The tab of a project's page that lists its team. */
export const TEAM_TAB = "team";
