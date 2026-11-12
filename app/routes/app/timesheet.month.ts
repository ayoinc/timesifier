import { membershipContext } from "~/organisations/membership.server";
import { Day } from "~/time/calendar";
import { pickerMonthData } from "~/timesheet/timesheet.server";

import type { Route } from "./+types/timesheet.month";

// The month the Day view's date picker shows (taste HT-D): each day of it with
// the caller's own time on it. A date that is not one is today.

export async function loader({ url, context }: Route.LoaderArgs) {
	const date = Day.safeParse(url.searchParams.get("date"));
	return pickerMonthData(
		context.get(membershipContext),
		date.success ? date.data : null,
		Date.now(),
	);
}
