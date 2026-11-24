import * as z from "zod";

import { codedName } from "../lib/codes";

/**
 * Work packages (TS-115b, docs/decisions.md entry 73): what the browser and the
 * server share. The rules that read the database are in `work-packages.server.ts`.
 */

/** A work package as the picker, the Timesheet and an entry's sheet name it. */
export interface WorkPackageChoice {
	id: string;
	code: string;
	name: string;
	/** Whether it takes time: open and not archived. One that does not is named, never offered. */
	open: boolean;
}

/** A work package named as everywhere: its code, then its name, `WP2 Build`. */
export function workPackageLabel(wp: { code: string; name: string }): string {
	return `${wp.code} ${wp.name}`;
}

/** A project and its work package as the picker names them: `ACME-001 · Website rebuild › WP2 Build`. */
export function projectAndPackage(
	project: { code?: string | null; name: string },
	wp: { code: string; name: string } | null,
): string {
	const named = codedName(project.code, project.name);
	return wp === null ? named : `${named} › ${workPackageLabel(wp)}`;
}

/**
 * A line: a project and its work package, or the project alone, as one key
 * (TS-115b). The Week grid's rows and the picker's options are lines.
 */
export function lineKey(projectId: string, workPackageId: string | null): string {
	return workPackageId === null ? projectId : `${projectId}/${workPackageId}`;
}

/** The project and work package of a line. */
export function lineOf(line: string): { projectId: string; workPackageId: string | null } {
	const at = line.indexOf("/");
	return at === -1
		? { projectId: line, workPackageId: null }
		: { projectId: line.slice(0, at), workPackageId: line.slice(at + 1) };
}

/** The form field that sends an entry's work package. */
export const WORK_PACKAGE_FIELD = "workPackageId";

export const WORK_PACKAGE_STATES = ["open", "closed"] as const;
export const WorkPackageState = z.enum(WORK_PACKAGE_STATES);
export type WorkPackageState = z.infer<typeof WorkPackageState>;

/** A work package's budget: none, in hours (stored in minutes), or in fees (minor units of the project's currency). */
export const WORK_PACKAGE_BUDGET_KINDS = ["none", "hours", "fees"] as const;
export const WorkPackageBudgetKind = z.enum(WORK_PACKAGE_BUDGET_KINDS);
export type WorkPackageBudgetKind = z.infer<typeof WorkPackageBudgetKind>;

export const WORK_PACKAGE_BUDGET_LABELS: Record<WorkPackageBudgetKind, string> = {
	none: "No budget",
	hours: "Hours",
	fees: "Fees",
};

/** What a refused entry says of its work package, wherever it came from. */
export const WORK_PACKAGE_REFUSALS = {
	"no-work-package": "Choose an open work package of this project: its time goes to one.",
	"work-package-closed": "That work package is closed, so it takes no new time.",
} as const;

export type WorkPackageRefusal = keyof typeof WORK_PACKAGE_REFUSALS;

export const WORK_PACKAGE_NAME_MAX_LENGTH = 120;

/** The tab of a project's page that lists its work packages. */
export const WORK_PACKAGES_TAB = "work-packages";
