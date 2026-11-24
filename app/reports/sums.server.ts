import { sql } from "drizzle-orm";

import { among, latestAmong } from "~/db";
import type { Pricing } from "~/projects/money.server";
import type { RateRow } from "~/rates/rates";

import type { Sum } from "./report";
import { entriesIn, type ReportRequest } from "./reports.server";

/**
 * A report's time added up in SQL (TS-113, D4, docs/decisions.md entry 57),
 * in one statement, instead of reading its entries 200 at a time.
 *
 * Each entry counts its whole minutes on its stored day, a running one up to
 * the time of the request, as `rowOf` counts it, so every sum is the sum of
 * what the entries were one by one. The lines are the entries grouped by
 * person, project, whether billable and whether overtime: what the Time view,
 * Utilisation and Dashboards add up. When money is priced, the lines are also
 * apart by task on a project billed by task, and by span of days in which no
 * rate of the organisation starts: every entry of a line is then priced at
 * the same rate, so pricing a line once (`priceTime`, by its minutes) is
 * pricing each of its entries and adding them up. How many lines there are is
 * bounded by people × projects × (tasks) × (rate changes in the range + 1),
 * whatever the number of entries. `byDay` adds the time of each day, alone,
 * by project for a week's timetable, or by person for a day's people.
 */

export interface ReportSums {
	/** By person, project, billable and overtime, and when money is priced by task and span of rates. */
	sums: Sum[];
	/** By day, and by project too for a timetable; none unless asked for. */
	days: Sum[];
	/** The report's entries, in all. */
	entries: number;
}

export interface SumsOptions {
	/**
	 * The rates money is priced by. Given, each line is the time of a span of
	 * days in which none of them starts, counted on that span's first day; the
	 * time of a project billed by task is kept apart by task.
	 */
	money?: { rates: readonly Pick<RateRow, "effectiveFrom">[]; byTask: readonly string[] };
	byDay?: "day" | "day-and-project" | "day-and-person";
}

/**
 * The `money` option for pricing by `pricing`'s billable rates, and by
 * `costRates` too for a report that counts cost: every rate's first day, and
 * the projects billed by task.
 */
export function pricedBy(
	pricing: Pricing,
	costRates: readonly RateRow[] = [],
): NonNullable<SumsOptions["money"]> {
	return {
		rates: [...pricing.rates, ...costRates],
		byTask: [...pricing.projects.values()]
			.filter((project) => project.rateMode === "task")
			.map((project) => project.id),
	};
}

export async function sumsOf(
	request: Pick<ReportRequest, "scope" | "days" | "people" | "tag" | "now">,
	options: SumsOptions = {},
): Promise<ReportSums> {
	const { scope, days, now, people } = request;
	if (!people.everyone && people.people.length === 0) return { sums: [], days: [], entries: 0 };
	const { money, byDay } = options;
	// The first day of each span of rates: the range's, and each day a rate starts within it.
	const starts = [
		...new Set(
			(money?.rates ?? [])
				.map((rate) => rate.effectiveFrom)
				.filter((day) => day > days.first && day <= days.last),
		),
	].sort();

	const groupings: (readonly Key[])[] = [
		money
			? ["user", "project", "workPackage", "billable", "overtime", "task", "span"]
			: ["user", "project", "workPackage", "billable", "overtime"],
	];
	if (byDay === "day") groupings.push(["day", "overtime"]);
	if (byDay === "day-and-project") groupings.push(["day", "project", "overtime"]);
	if (byDay === "day-and-person") groupings.push(["day", "user", "overtime"]);

	const [lines, projects, clients, packages] = await Promise.all([
		scope.timeEntries.sums(
			(e) => ({
				user: e.userId,
				project: e.projectId,
				workPackage: e.workPackageId,
				billable: e.billable,
				overtime: e.overtime,
				task:
					money && money.byTask.length > 0
						? sql`case when ${among(e.projectId, money.byTask)} then ${e.taskId} end`
						: sql`null`,
				span:
					starts.length > 0
						? sql`coalesce(${latestAmong(e.spentOn, starts)}, ${days.first})`
						: sql`${days.first}`,
				day: e.spentOn,
			}),
			(e) => ({
				// D1 binds a number as a real: cast, so the division drops the seconds as `rowOf` does.
				minutes: sql<number>`max(0, (coalesce(${e.endedAt}, max(cast(${now} as integer), ${e.startedAt})) - ${e.startedAt}) / 60000)`,
				entries: sql<number>`1`,
			}),
			groupings,
			entriesIn(request),
		),
		scope.projects.select(),
		scope.clients.select(),
		scope.workPackages.select(),
	]);
	const projectsById = new Map(projects.map((p) => [p.id, p]));
	const clientsById = new Map(clients.map((c) => [c.id, c]));
	const packagesById = new Map(packages.map((wp) => [wp.id, wp]));

	const sums: Sum[] = [];
	const byDays: Sum[] = [];
	let entries = 0;
	for (const line of lines) {
		const projectId = text(line.project);
		const project = projectsById.get(projectId);
		const clientId = project?.clientId ?? null;
		const client = clientId === null ? undefined : clientsById.get(clientId);
		const workPackageId = line.workPackage === null ? null : text(line.workPackage);
		const wp = workPackageId === null ? undefined : packagesById.get(workPackageId);
		const sum: Sum = {
			entry: {
				userId: text(line.user),
				projectId,
				project: project?.name ?? "",
				projectCode: project?.code ?? null,
				clientId,
				client: client?.name ?? null,
				clientCode: client?.code ?? null,
				workPackageId,
				workPackageCode: wp?.code ?? null,
				workPackage: wp?.name ?? null,
				taskId: line.task === null ? null : text(line.task),
				billable: line.billable === 1,
				overtime: line.overtime === 1,
			},
			day: text(line.grouping === 0 ? line.span : line.day) || days.first,
			minutes: line.minutes,
			entries: line.entries,
		};
		if (line.grouping === 0) {
			sums.push(sum);
			entries += line.entries;
		} else byDays.push(sum);
	}
	return { sums, days: byDays, entries };
}

type Key = "user" | "project" | "workPackage" | "billable" | "overtime" | "task" | "span" | "day";

function text(value: string | number | null): string {
	return value === null ? "" : String(value);
}
