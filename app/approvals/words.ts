import type { Day } from "~/time/calendar";
import { formatDay, formatDuration } from "~/time/format";

/**
 * What Approvals and Time off say about a decision that waits on someone in
 * particular (TS-111d). The page's own code reads this module, so it holds
 * no Zod and nothing of the server.
 */

/** Why a manager may not approve a request someone else refused (D5, decision 47), where who refused it is not named. */
export const REFUSED_BEFORE =
	"These days were refused before, so only whoever refused them, an owner or an admin can approve this.";

/** Why a manager may not approve a request that `names` refused before (D5, decision 47). */
export function refusedBeforeSentence(names: readonly string[]): string {
	const who = new Intl.ListFormat("en-GB", { type: "conjunction" }).format(names);
	return `${who} refused these days before, so only they, an owner or an admin can approve this.`;
}

/** Why something waits for an owner or admin: every manager who would decide it is on leave today (D6, decision 48). */
export function managersAwaySentence(names: readonly string[]): string {
	const who = new Intl.ListFormat("en-GB", { type: "conjunction" }).format(names);
	return `${who} ${names.length === 1 ? "is" : "are"} on leave, so this waits for an owner or admin.`;
}

/**
 * The days of a week over their limit, as Submit would have refused it (TR-01),
 * in the Timesheet's words (`overLabel`): "Over by 7:30 on Tue 10", or "Over 24
 * hours by 62:00 on Fri 13" for a day holding more than a day (decision 52).
 */
export function overLimitLabel(
	days: readonly { day: Day; overMinutes: number; moreThanADay: boolean }[],
): string {
	return days
		.map(
			(d, at) =>
				`${at === 0 ? "Over" : "over"}${d.moreThanADay ? " 24 hours" : ""} by ${formatDuration(d.overMinutes * 60)} on ${formatDay(d.day, "short")}`,
		)
		.join(" and ");
}
