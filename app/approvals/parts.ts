import { destinationPath } from "~/shell/destinations";
import type { Day } from "~/time/calendar";

/**
 * Approval by project (TS-117, docs/decisions.md entry 79). A submitted week
 * with time on a client project that has a delivery manager is held in parts,
 * each decided apart:
 *
 * - a project part for each such project: the person's time on it in the
 *   week, decided by the project's delivery managers;
 * - the line part: the rest of the week (internal time, work codes, leave,
 *   projects without a delivery manager, expenses, and the week's hours as a
 *   whole), decided by the person's line (team) manager, as a whole week was
 *   before.
 *
 * A week with no project part has no parts and is decided whole, exactly as
 * before: so is every week of an organisation with no delivery managers. The
 * period's own status follows its parts (`weekStatusOf`). This module reads
 * nothing; `parts.server.ts` reads and writes the parts.
 */

/** Where a part stands. A part is never withdrawn: the week is, before any part is decided. */
export type PartStatus = "submitted" | "approved" | "returned";

/** What a week or a part approved as it is submitted says, because nobody else may approve it (D5, decision 47). */
export const APPROVED_ALONE = "Approved automatically: nobody else can approve it";

/** How a part's status is shown, to its person and to its approvers. */
export const PART_STATUS_LABELS: Record<PartStatus, string> = {
	submitted: "Waiting for approval",
	approved: "Approved",
	returned: "Returned",
};

/** What a part's status, its period's, and an entry's part are read from. */
export interface PartState {
	/** The project of a project part; null for the line part. */
	projectId: string | null;
	status: PartStatus;
}

/**
 * The status of a week held in `parts`: returned while any part is, since
 * the week is back with its person; approved once every part is; submitted
 * otherwise, while some part waits.
 */
export function weekStatusOf(parts: readonly Pick<PartState, "status">[]): PartStatus {
	if (parts.some((p) => p.status === "returned")) return "returned";
	if (parts.every((p) => p.status === "approved")) return "approved";
	return "submitted";
}

/**
 * The part an entry on `projectId` belongs to in a week whose project parts
 * are `projectParts`: that project's part, or the line part (null).
 */
export function partOfProject(
	projectId: string,
	projectParts: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): string | null {
	return projectParts.has(projectId) ? projectId : null;
}

/**
 * Whether entries of a part in `status` may change while its week is
 * returned: only a returned part is back with its person. An approved part
 * is locked, and one still waiting is in front of its approver.
 */
export function partIsOpen(status: PartStatus | undefined): boolean {
	return status === undefined || status === "returned";
}

/** How a part is named to people: "your time on Acme Website", or "the rest of your week". */
export function partWords(project: string | null): {
	yours: string;
	theirs: (name: string) => string;
} {
	return project === null
		? { yours: "the rest of your timesheet", theirs: (name) => `the rest of ${name}'s timesheet` }
		: { yours: `your time on ${project}`, theirs: (name) => `${name}'s time on ${project}` };
}

/** The address parameter of Approvals' tabs (TS-117): `?view=projects`; People when left out. */
export const VIEW_PARAM = "view";

/** Approvals' tabs: People, for line managers; Projects, for delivery managers. */
export const APPROVAL_VIEWS = ["people", "projects"] as const;
export type ApprovalView = (typeof APPROVAL_VIEWS)[number];

/** The address of Approvals' Projects tab on the week that starts on `startsOn`. */
export function projectsApprovalsPath(slug: string, startsOn: Day): string {
	return `${destinationPath(slug, "approvals")}?${VIEW_PARAM}=projects&week=${startsOn}`;
}
