import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { recordStatement } from "~/activity/activity.server";
import { billableMinuteMinor } from "~/billing/billable";
import { type BudgetStatus, budgetStatus, countsTowardHours } from "~/budgets/budget";
import { mayCreateProject } from "~/clients/managers.server";
import {
	among,
	latestAmong,
	type OrganisationScope,
	type ScopedStatement,
	type TenantRow,
} from "~/db";
import { codeKey } from "~/lib/codes";
import type { Role } from "~/organisations/roles";
import { priceTime } from "~/rates/price";
import { notInvoiced } from "~/tasks/tasks.server";
import type { Day } from "~/time/calendar";

import type { OrganisationMoney, Pricing } from "./money.server";
import type {
	WorkPackageBudgetKind,
	WorkPackageChoice,
	WorkPackageRefusal,
	WorkPackageState,
} from "./work-packages";

/**
 * Work packages (TS-115b, docs/decisions.md entry 73): a project's parts, each
 * with a code unique in the project, a name, days, a budget and an open or
 * closed state. Time goes to a project and one of its work packages:
 *
 * - while a project has an open work package, a new or changed entry names
 *   one, open and of that project (`entryPackageOf`, asked by every writer of
 *   entries: track, the timer, a cell, a calendar slot, edit, copy, undo, the
 *   API and the CSV import);
 * - a closed work package takes no new time, and time already on it stays:
 *   an entry on it may be changed so long as it adds no time to it;
 * - existing entries are left as they are.
 *
 * Migration 0038's triggers refuse a work package of another project or
 * organisation even if a writer forgot to ask.
 */

/** A work package as stored. */
export type WorkPackageRow = TenantRow<"workPackages">;

/** Whether `wp` takes new time: open and not archived. */
export function takesTime(wp: Pick<WorkPackageRow, "state" | "archivedAt">): boolean {
	return wp.state === "open" && wp.archivedAt === null;
}

/**
 * Who manages a project's work packages: creates, edits, closes, reopens,
 * archives and restores them. Decision 42's rule for the project's client:
 * owners and admins for any project, an account manager for their own
 * clients' projects, nobody else. TS-115c adds the project's delivery
 * managers: `deliveryManager` is that seam, false until it is built.
 */
export function mayManageWorkPackages(
	role: Role,
	managed: readonly string[],
	clientId: string | null,
	deliveryManager = false,
): boolean {
	return deliveryManager || mayCreateProject(role, managed, clientId);
}

/** The work packages of `projectIds`, archived ones too, by project id, each list by code. */
export async function workPackagesOf(
	scope: OrganisationScope,
	projectIds: readonly string[],
): Promise<Map<string, WorkPackageRow[]>> {
	const byProject = new Map<string, WorkPackageRow[]>();
	if (projectIds.length === 0) return byProject;
	const rows = await scope.workPackages.select((w) => among(w.projectId, projectIds), {
		orderBy: (w) => [asc(w.codeKey)],
	});
	for (const row of rows)
		byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row]);
	return byProject;
}

/** Every work package of the organisation as the views name and offer them, by project id. */
export async function workPackageChoices(
	scope: OrganisationScope,
): Promise<Record<string, WorkPackageChoice[]>> {
	const rows = await scope.workPackages.select(undefined, { orderBy: (w) => [asc(w.codeKey)] });
	const byProject: Record<string, WorkPackageChoice[]> = {};
	for (const row of rows) {
		(byProject[row.projectId] ??= []).push({
			id: row.id,
			code: row.code,
			name: row.name,
			open: takesTime(row),
		});
	}
	return byProject;
}

/** The entry's work package and whether it lets the entry be billable, or why it cannot be written. */
export type EntryPackage =
	| { ok: true; workPackageId: string | null; billable: boolean }
	| { ok: false; reason: WorkPackageRefusal };

/**
 * The work package an entry of `projectId` goes to, by the rules above.
 *
 * `chosen` is what was asked for: an id, `null` or `""` for none, `undefined`
 * when nothing was said, in which case an entry being changed keeps its own.
 * `kept` is the entry as it was, for a change: its work package (if its
 * project is the same) and whether the change adds time to it. A new entry
 * passes null.
 *
 * `billable` is false when the work package is not billable; an entry is
 * billable only when its task and its work package both are.
 */
export async function entryPackageOf(
	scope: OrganisationScope,
	projectId: string,
	chosen: string | null | undefined,
	kept: { workPackageId: string | null; addsTime: boolean } | null = null,
): Promise<EntryPackage> {
	const asked = chosen === undefined ? (kept?.workPackageId ?? null) : chosen || null;
	const packages = (await workPackagesOf(scope, [projectId])).get(projectId) ?? [];
	if (asked === null) {
		return packages.some(takesTime)
			? { ok: false, reason: "no-work-package" }
			: { ok: true, workPackageId: null, billable: true };
	}
	const wp = packages.find((each) => each.id === asked);
	if (!wp) return { ok: false, reason: "no-work-package" };
	const keeps = kept !== null && kept.workPackageId === wp.id && !kept.addsTime;
	if (!takesTime(wp) && !keeps) {
		return { ok: false, reason: wp.state === "closed" ? "work-package-closed" : "no-work-package" };
	}
	return { ok: true, workPackageId: wp.id, billable: wp.billable };
}

/** The work package rules of many projects at once, as copy and the import ask them. */
export interface PackageRules {
	/** Whether `projectId` has an open work package, so an entry of it must name one. */
	required(projectId: string): boolean;
	/** The work package of `projectId` with `id` that takes time, or null. */
	open(projectId: string, id: string | null): WorkPackageRow | null;
	/** The work package of `projectId` whose code is `code`, ignoring case, or null. */
	byCode(projectId: string, code: string): WorkPackageRow | null;
}

/** The rules of `projectIds`' work packages, read in one statement. */
export async function packageRules(
	scope: OrganisationScope,
	projectIds: readonly string[],
): Promise<PackageRules> {
	const byProject = await workPackagesOf(scope, [...new Set(projectIds)]);
	return {
		required: (projectId) => (byProject.get(projectId) ?? []).some(takesTime),
		open: (projectId, id) =>
			id === null
				? null
				: ((byProject.get(projectId) ?? []).find((wp) => wp.id === id && takesTime(wp)) ?? null),
		byCode: (projectId, code) =>
			(byProject.get(projectId) ?? []).find((wp) => wp.codeKey === codeKey(code)) ?? null,
	};
}

/** What a work package is created or changed with. */
export interface WorkPackageInput {
	code: string;
	name: string;
	startsOn: Day | null;
	endsOn: Day | null;
	budgetKind: WorkPackageBudgetKind;
	/** Minutes for hours, minor units for fees; null for no budget. */
	budgetAmount: number | null;
	billable: boolean;
}

/** Why a work package was not written. */
export type WorkPackageProblem = "code-taken" | "ends-before-start";

export const WORK_PACKAGE_PROBLEMS: Record<WorkPackageProblem, string> = {
	"code-taken": "Another work package of this project has that code.",
	"ends-before-start": "Its last day is before its first.",
};

/** Whether a write failed on the unique index of `(project_id, code_key)`. */
function isPackageCodeClash(error: unknown): boolean {
	for (let at: unknown = error; at instanceof Error; at = at.cause) {
		if (
			/UNIQUE constraint failed: work_packages\.project_id, work_packages\.code_key/.test(
				at.message,
			)
		)
			return true;
	}
	return false;
}

async function codeTaken(
	scope: OrganisationScope,
	projectId: string,
	code: string,
	except: string | null,
): Promise<boolean> {
	const [found] = await scope.workPackages.select(
		(w) => and(eq(w.projectId, projectId), eq(w.codeKey, codeKey(code))),
		{ limit: 1 },
	);
	return found !== undefined && found.id !== except;
}

function fieldsOf(input: WorkPackageInput) {
	return {
		code: input.code,
		codeKey: codeKey(input.code),
		name: input.name,
		startsOn: input.startsOn,
		endsOn: input.endsOn,
		budgetKind: input.budgetKind,
		budgetAmount: input.budgetKind === "none" ? null : input.budgetAmount,
		billable: input.billable,
	};
}

const subjectOf = (id: string) => ({ type: "work_package", id }) as const;

/** Creates a work package of `projectId`, open. */
export async function createWorkPackage(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	input: WorkPackageInput,
): Promise<{ ok: true; id: string } | { ok: false; problem: WorkPackageProblem }> {
	if (input.startsOn && input.endsOn && input.endsOn < input.startsOn)
		return { ok: false, problem: "ends-before-start" };
	if (await codeTaken(scope, projectId, input.code, null))
		return { ok: false, problem: "code-taken" };
	const fields = fieldsOf(input);
	try {
		const [[row]] = await scope.batch([
			scope.workPackages.statements.insert({ projectId, ...fields }),
		]);
		if (!row) throw new Error("the work package was not written");
		await scope.batch([
			recordStatement(scope, actor, "work_package.created", subjectOf(row.id), {
				after: { projectId, code: input.code, name: input.name },
			}),
		]);
		return { ok: true, id: row.id };
	} catch (error) {
		if (isPackageCodeClash(error)) return { ok: false, problem: "code-taken" };
		throw error;
	}
}

/** The work package `id` of `projectId`, or null. */
export async function workPackageOf(scope: OrganisationScope, projectId: string, id: string) {
	const [row] = await scope.workPackages.select(
		(w) => and(eq(w.id, id), eq(w.projectId, projectId)),
		{ limit: 1 },
	);
	return row ?? null;
}

/**
 * Changes a work package: its code, name, days, budget and whether it is
 * billable. Making it not billable, or billable again, does the same to its
 * entries not yet invoiced whose task is billable, as a task's change does
 * (`setProjectTaskBillable`). Null when it is not of the project.
 */
export async function updateWorkPackage(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	id: string,
	input: WorkPackageInput,
): Promise<{ ok: true } | { ok: false; problem: WorkPackageProblem } | null> {
	const existing = await workPackageOf(scope, projectId, id);
	if (!existing) return null;
	if (input.startsOn && input.endsOn && input.endsOn < input.startsOn)
		return { ok: false, problem: "ends-before-start" };
	if (await codeTaken(scope, projectId, input.code, id))
		return { ok: false, problem: "code-taken" };
	const fields = fieldsOf(input);
	const statements: ScopedStatement<unknown>[] = [
		scope.workPackages.statements.update(fields, (w) => eq(w.id, id)),
		...(fields.billable === existing.billable
			? []
			: await billableStatements(scope, projectId, id, fields.billable)),
		recordStatement(scope, actor, "work_package.updated", subjectOf(id), {
			before: { code: existing.code, name: existing.name, billable: existing.billable },
			after: { code: fields.code, name: fields.name, billable: fields.billable },
		}),
	];
	try {
		await scope.batch(statements as [ScopedStatement<unknown>, ...ScopedStatement<unknown>[]]);
	} catch (error) {
		if (isPackageCodeClash(error)) return { ok: false, problem: "code-taken" };
		throw error;
	}
	return { ok: true };
}

/**
 * The statements that make the entries of work package `id` billable or not:
 * not billable, every one not invoiced; billable, those not invoiced whose
 * task is billable on the project, on a project that bills.
 */
async function billableStatements(
	scope: OrganisationScope,
	projectId: string,
	id: string,
	billable: boolean,
): Promise<ScopedStatement<unknown>[]> {
	if (!billable) {
		return [
			scope.timeEntries.statements.update({ billable: false }, (e) =>
				and(eq(e.workPackageId, id), notInvoiced(scope, e.id)),
			),
		];
	}
	const [project] = await scope.projects.select((p) => eq(p.id, projectId), { limit: 1 });
	if (!project || project.billingType === "non_billable") return [];
	const links = await scope.projectTasks.select((pt) =>
		and(eq(pt.projectId, projectId), eq(pt.billable, true)),
	);
	const billableTasks = links.map((link) => link.taskId);
	if (billableTasks.length === 0) return [];
	return [
		scope.timeEntries.statements.update({ billable: true }, (e) =>
			and(eq(e.workPackageId, id), among(e.taskId, billableTasks), notInvoiced(scope, e.id)),
		),
	];
}

/** Closes a work package, or opens it again. Null when it is not of the project. */
export async function setWorkPackageState(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	id: string,
	state: WorkPackageState,
): Promise<boolean | null> {
	const existing = await workPackageOf(scope, projectId, id);
	if (!existing) return null;
	if (existing.state === state) return true;
	await scope.batch([
		scope.workPackages.statements.update({ state }, (w) => eq(w.id, id)),
		recordStatement(
			scope,
			actor,
			state === "closed" ? "work_package.closed" : "work_package.reopened",
			subjectOf(id),
		),
	]);
	return true;
}

/** Archives a work package, or restores it. An archived one takes no time and is listed apart. */
export async function setWorkPackageArchived(
	scope: OrganisationScope,
	actor: string,
	projectId: string,
	id: string,
	archived: boolean,
	now: number,
): Promise<boolean | null> {
	const existing = await workPackageOf(scope, projectId, id);
	if (!existing) return null;
	if ((existing.archivedAt !== null) === archived) return true;
	await scope.batch([
		scope.workPackages.statements.update({ archivedAt: archived ? new Date(now) : null }, (w) =>
			eq(w.id, id),
		),
		recordStatement(
			scope,
			actor,
			archived ? "work_package.archived" : "work_package.restored",
			subjectOf(id),
		),
	]);
	return true;
}

/** A work package's budget progress: hours in minutes, fees in minor units of the project's currency. */
export interface WorkPackageProgress {
	/** Minutes tracked to it, all of them, billable or not. */
	minutes: number;
	/** Its budget and where it stands, or null when it has none. */
	budget: {
		kind: Exclude<WorkPackageBudgetKind, "none">;
		amount: number;
		status: BudgetStatus;
	} | null;
}

/**
 * The progress of each work package of `projectId` against its budget, by id,
 * over its whole life: one statement adds the project's entries up by work
 * package, task, person, billable, overtime and span of rates (TS-113's sums,
 * decision 57), so a figure is the sum of its entries one by one. An hours
 * budget counts what the project's hours budget counts: billable time, and
 * non-billable time where the organisation says so; a fees budget counts the
 * billable amount (`priceTime`).
 */
export async function workPackageProgress(
	scope: OrganisationScope,
	projectId: string,
	packages: readonly WorkPackageRow[],
	{ now, money, pricing }: { now: number; money: OrganisationMoney; pricing: Pricing },
): Promise<Map<string, WorkPackageProgress>> {
	const progress = new Map<string, WorkPackageProgress>();
	if (packages.length === 0) return progress;
	const priced = pricing.projects.get(projectId);
	const rateStarts = pricing.rates
		.filter((rate) => rate.projectId === null || rate.projectId === projectId)
		.map((rate) => rate.effectiveFrom);
	const groups = await scope.timeEntries.sums(
		(e) => ({
			wp: e.workPackageId,
			person: e.userId,
			task: e.taskId,
			billable: e.billable,
			overtime: e.overtime,
			from: latestAmong(e.spentOn, rateStarts),
		}),
		(e) => {
			const elapsed = sql`(coalesce(${e.endedAt}, cast(${now} as integer)) - ${e.startedAt})`;
			return {
				seconds: sql<number>`max(0, ${elapsed} / 1000)`,
				minutes: sql<number>`max(0, ${elapsed} / 60000)`,
			};
		},
		[["wp", "person", "task", "billable", "overtime", "from"]],
		(e) =>
			and(
				eq(e.projectId, projectId),
				among(
					e.workPackageId,
					packages.map((wp) => wp.id),
				),
			),
	);
	const totals = new Map<string, { seconds: number; counted: number; fees: number }>();
	for (const group of groups) {
		if (group.wp === null) continue;
		const id = String(group.wp);
		const billable = Number(group.billable) === 1;
		const held = totals.get(id) ?? { seconds: 0, counted: 0, fees: 0 };
		held.seconds += group.seconds;
		const bills = priced !== undefined && priced.billingType !== "non_billable" && billable;
		if (countsTowardHours(bills, money.budgetCountsNonBillable)) held.counted += group.seconds;
		if (priced && group.from !== null) {
			held.fees += billableMinuteMinor([
				priceTime(priced, pricing.rates, {
					userId: String(group.person),
					taskId: group.task === null ? null : String(group.task),
					billable,
					overtime: Number(group.overtime) === 1,
					day: String(group.from),
					minutes: group.minutes,
				}),
			]);
		}
		totals.set(id, held);
	}
	for (const wp of packages) {
		const held = totals.get(wp.id) ?? { seconds: 0, counted: 0, fees: 0 };
		const kind = wp.budgetKind === "hours" || wp.budgetKind === "fees" ? wp.budgetKind : null;
		const amount = wp.budgetAmount ?? 0;
		const spent = kind === "hours" ? Math.floor(held.counted / 60) : Math.round(held.fees / 60);
		progress.set(wp.id, {
			minutes: Math.floor(held.seconds / 60),
			budget: kind === null ? null : { kind, amount, status: budgetStatus({ amount, spent }) },
		});
	}
	return progress;
}

/** The active work packages of `projectId` that take time, by code, for the entries' forms. */
export async function openPackagesOf(scope: OrganisationScope, projectId: string) {
	return scope.workPackages.select(
		(w) => and(eq(w.projectId, projectId), eq(w.state, "open"), isNull(w.archivedAt)),
		{ orderBy: (w) => [asc(w.codeKey)] },
	);
}
