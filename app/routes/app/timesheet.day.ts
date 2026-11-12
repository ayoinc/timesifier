import { env } from "cloudflare:workers";

import { organisationScope } from "~/db";
import { membershipContext } from "~/organisations/membership.server";
import { trackChoices } from "~/tasks/track.server";
import { Day } from "~/time/calendar";
import { trackDayData } from "~/timesheet/timesheet.server";

import type { Route } from "./+types/timesheet.day";

// What the Track time sheet reads for the date chosen in it (taste HT-C): the
// sheet opens over any page of the organisation, so it asks here. The caller's
// own day alone, whatever their role, with the tasks, tags, budget warnings,
// clients and recent projects its fields offer; a date that is not one is today.

export async function loader({ url, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const day = Day.safeParse(url.searchParams.get("day"));
	const now = Date.now();
	const scope = organisationScope(env.DB, membership.organisation.id);
	const [shown, track] = await Promise.all([
		trackDayData(membership, day.success ? day.data : null, now),
		trackChoices(scope, membership, [], now),
	]);
	return { ...shown, track };
}
