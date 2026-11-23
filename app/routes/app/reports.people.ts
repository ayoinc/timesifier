import { data } from "react-router";

import { membershipContext } from "~/organisations/membership.server";
import {
	type GroupPerson,
	groupPeopleOf,
	type PersonView,
	personView,
} from "~/reports/people.server";
import { peopleOfReport, reportRequest } from "~/reports/reports.server";
import { sumsOf } from "~/reports/sums.server";

import type { Route } from "./+types/reports.people";

// The people of a Time report, read when the page opens a group or its People
// section (TS-113, D8), at the address of the report with `/people` after it
// and the same query, so they are the report's own. With `in`, who tracked
// time in that group (a project's id, a client's id, "" for no client, or a
// day); without, each person's worked, expected and leave. It sits below
// Reports, so the organisation layout's checks cover it.

export type ReportPeople = { group: GroupPerson[] } | { people: PersonView[] };

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const url = new URL(request.url);
	const report = await reportRequest(membership, url, Date.now());
	if ("problem" in report) throw data("Bad Request", { status: 400 });
	const group = url.searchParams.get("in");
	const people: ReportPeople =
		group === null
			? { people: (await peopleOfReport(report, (await sumsOf(report)).sums)).map(personView) }
			: { group: await groupPeopleOf(report, report.grouping, group) };
	return data(people, { headers: { "Cache-Control": "no-store" } });
}
