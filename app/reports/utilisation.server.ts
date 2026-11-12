import { eq } from "drizzle-orm";

import { managedTeams, teamsWithMembers } from "~/teams/teams.server";

import type { Row } from "./report";
import { type PersonLine, peopleOfReport, type ReportRequest } from "./reports.server";
import {
	sumFigures,
	type TeamUtilisation,
	teamUtilisation,
	trackedByPerson,
	type UtilisationFigures,
} from "./utilisation";

/**
 * The utilisation report (TS-068) read from the database: each person the
 * viewer may see, with their capacity over the range (`peopleOfReport`: the
 * working week less public holidays and approved leave), what they tracked
 * and what of it bills; each team the viewer sees, over its members shown;
 * and everyone shown together. Dashboards (TS-086) reads the same function,
 * so its figure is this report's.
 */

export interface PersonUtilisation extends UtilisationFigures {
	id: string;
	name: string;
	address: string | null;
	leaveMinutes: number;
}

export interface UtilisationReport {
	people: PersonUtilisation[];
	teams: TeamUtilisation[];
	total: UtilisationFigures;
}

/** The ids of the organisation's projects that never bill, whatever their entries say. */
export async function nonBillableProjects(
	scope: ReportRequest["scope"],
): Promise<ReadonlySet<string>> {
	const rows = await scope.projects.select((p) => eq(p.billingType, "non_billable"));
	return new Set(rows.map((p) => p.id));
}

export async function utilisationReport(
	request: ReportRequest,
	pieces: readonly Row[],
	lines?: readonly PersonLine[],
): Promise<UtilisationReport> {
	const { scope, access, seesEveryone } = request;
	const [people, nonBillable, teams] = await Promise.all([
		lines ?? peopleOfReport(request, pieces),
		nonBillableProjects(scope),
		seesEveryone
			? teamsWithMembers(scope)
			: managedTeams(scope, access.userId).then((ids) => teamsWithMembers(scope, ids)),
	]);
	const tracked = trackedByPerson(pieces, nonBillable);
	const byPerson = new Map<string, PersonUtilisation>(
		people.map((line) => {
			const theirs = tracked.get(line.id) ?? {
				loggedSeconds: 0,
				billableSeconds: 0,
				overtimeSeconds: 0,
			};
			return [
				line.id,
				{
					id: line.id,
					name: line.name,
					address: line.address,
					leaveMinutes: line.leaveMinutes,
					capacityMinutes: line.expectedMinutes,
					...theirs,
				},
			];
		}),
	);
	return {
		people: [...byPerson.values()],
		teams: teamUtilisation(
			teams.map((team) => ({
				id: team.id,
				name: team.name,
				members: team.members.map((m) => m.userId),
			})),
			byPerson,
		),
		total: sumFigures(byPerson.values()),
	};
}
