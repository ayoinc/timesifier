import type { Row } from "./report";

/**
 * Utilisation (TS-068, B8): the time a person tracked against their capacity
 * over a range. Capacity is the time expected of them: their working week,
 * less public holidays and approved leave (TS-084), so a person on leave all
 * week has none, and their utilisation is "—", never a division by zero.
 * Utilisation counts all tracked time; billable utilisation counts only
 * billable time. Nothing here stops anyone tracking beyond capacity.
 */

/** What utilisation is worked out from, for a person, a team or everyone shown. */
export interface UtilisationFigures {
	/** Minutes expected over the range. */
	capacityMinutes: number;
	/** Seconds tracked, billable or not. */
	loggedSeconds: number;
	/** Seconds tracked that bill: the entry is billable and its project is not non-billable. */
	billableSeconds: number;
}

/** `seconds` as a share of `capacityMinutes`, or null when there is no capacity. */
export function shareOfCapacity(seconds: number, capacityMinutes: number): number | null {
	return capacityMinutes > 0 ? seconds / (capacityMinutes * 60) : null;
}

/** A share as a whole percentage, or "—" for none. 1.234 is "123%". */
export function percentLabel(share: number | null): string {
	return share === null ? "—" : `${Math.round(share * 100)}%`;
}

/** The figures of several people or teams added together. */
export function sumFigures(all: Iterable<UtilisationFigures>): UtilisationFigures {
	const sum = { capacityMinutes: 0, loggedSeconds: 0, billableSeconds: 0 };
	for (const each of all) {
		sum.capacityMinutes += each.capacityMinutes;
		sum.loggedSeconds += each.loggedSeconds;
		sum.billableSeconds += each.billableSeconds;
	}
	return sum;
}

/** Whether a row bills: its entry is marked billable and its project bills at all. */
export function bills(row: Row, nonBillableProjects: ReadonlySet<string>): boolean {
	return row.entry.billable && !nonBillableProjects.has(row.entry.projectId);
}

/** Each person's tracked and billable seconds in `rows`. */
export function trackedByPerson(
	rows: readonly Row[],
	nonBillableProjects: ReadonlySet<string>,
): Map<string, { loggedSeconds: number; billableSeconds: number }> {
	const tracked = new Map<string, { loggedSeconds: number; billableSeconds: number }>();
	for (const row of rows) {
		const line = tracked.get(row.entry.userId) ?? { loggedSeconds: 0, billableSeconds: 0 };
		line.loggedSeconds += row.minutes * 60;
		if (bills(row, nonBillableProjects)) line.billableSeconds += row.minutes * 60;
		tracked.set(row.entry.userId, line);
	}
	return tracked;
}

/** A team's line: the figures of the members shown, added together. */
export interface TeamUtilisation extends UtilisationFigures {
	id: string;
	name: string;
	/** How many of its members are counted: those the viewer may see. */
	people: number;
}

/**
 * Each team's figures over its members among `byPerson`, the people the viewer
 * may see. A team none of whose members are shown is left out.
 */
export function teamUtilisation(
	teams: readonly { id: string; name: string; members: readonly string[] }[],
	byPerson: ReadonlyMap<string, UtilisationFigures>,
): TeamUtilisation[] {
	return teams.flatMap((team) => {
		const shown = [...new Set(team.members)].flatMap((id) => {
			const figures = byPerson.get(id);
			return figures ? [figures] : [];
		});
		if (shown.length === 0) return [];
		return [{ id: team.id, name: team.name, people: shown.length, ...sumFigures(shown) }];
	});
}
