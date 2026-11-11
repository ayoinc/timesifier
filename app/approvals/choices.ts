import type { ProjectTime } from "~/teams/week.server";

/**
 * What Approvals shows of a period (TS-058): the timesheets in one status, in
 * `?status=`, grouped by person or by project, in `?group=`. Both travel in
 * the address, so a view of Approvals is a link. The page's own code reads
 * this module, so it holds no Zod: Zod tries `new Function` when it loads,
 * which the Content Security Policy refuses.
 */

export const STATUSES = ["pending", "approved", "returned", "not-submitted"] as const;
export type ApprovalStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<ApprovalStatus, string> = {
	pending: "Pending",
	approved: "Approved",
	returned: "Returned",
	"not-submitted": "Not submitted",
};

export const APPROVAL_GROUPS = ["person", "project"] as const;
export type ApprovalGrouping = (typeof APPROVAL_GROUPS)[number];

export const APPROVAL_GROUP_LABELS: Record<ApprovalGrouping, string> = {
	person: "Person",
	project: "Project",
};

export interface ApprovalsQuery {
	status: ApprovalStatus;
	group: ApprovalGrouping;
}

/**
 * The view an address asks for, or null when it names a status or a grouping
 * that is not one. Left out, they are Pending and by person.
 */
export function parseApprovalsQuery(params: URLSearchParams): ApprovalsQuery | null {
	const status = STATUSES.find((each) => each === (params.get("status") || "pending"));
	const group = APPROVAL_GROUPS.find((each) => each === (params.get("group") || "person"));
	return status && group ? { status, group } : null;
}

/**
 * The status an address of the tabs Approvals had before (`?tab=`) opens on:
 * Decided held approved and returned periods alike, and opens on Approved.
 */
const TAB_STATUS: Record<string, ApprovalStatus> = {
	pending: "pending",
	"not-submitted": "not-submitted",
	decided: "approved",
};

/**
 * The address an old `?tab=` address now has, its other values kept, or null
 * when `params` has no tab. A tab that never was is dropped.
 */
export function withoutTab(params: URLSearchParams): URLSearchParams | null {
	const tab = params.get("tab");
	if (tab === null) return null;
	const next = new URLSearchParams(params);
	next.delete("tab");
	const status = TAB_STATUS[tab];
	if (status !== undefined && !next.has("status")) next.set("status", status);
	return next;
}

export interface ProjectGroup {
	id: string;
	name: string;
	seconds: number;
	/** The names of the people who logged time on it, in the order given. */
	people: string[];
}

/**
 * The time of `people` by project, projects in name order, each with the names
 * of the people who logged time on it. Time of anybody else is left out.
 */
export function byProject(
	people: readonly { id: string; name: string }[],
	time: readonly ProjectTime[],
): ProjectGroup[] {
	const groups = new Map<string, ProjectGroup>();
	for (const person of people) {
		for (const each of time) {
			if (each.userId !== person.id) continue;
			const group = groups.get(each.projectId) ?? {
				id: each.projectId,
				name: each.project,
				seconds: 0,
				people: [],
			};
			group.seconds += each.seconds;
			if (!group.people.includes(person.name)) group.people.push(person.name);
			groups.set(each.projectId, group);
		}
	}
	return [...groups.values()].sort(
		(a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id),
	);
}
