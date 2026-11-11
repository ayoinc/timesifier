import { eq } from "drizzle-orm";

import type { OrganisationScope } from "~/db";

import type { GettingStarted } from "./GettingStarted";

/**
 * Getting started on Timesheet (TS-056): add a project, track an entry, open
 * the week. The first two are read from the database each time. That the
 * person has opened the Week view, and that they put the list away, is kept in
 * a cookie of their browser, with the person's id beside each mark: another
 * person signed in on the same browser has marks of their own. Nothing in it
 * is a secret or grants anything; the server writes it only from its own
 * loader and action, and reads only marks of the person signed in.
 */

/** `__Host-`: the browser takes it only over HTTPS, with `Path=/` and no `Domain`. */
export const GETTING_STARTED_COOKIE = "__Host-timesifier.getting_started";

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";
const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;
/** The most marks kept: those of the last people on this browser. */
const MOST_MARKS = 10;

/** `week`: the person has opened the Week view. `away`: they put the list away. */
export type Mark = "week" | "away";

const CODES: Record<Mark, string> = { week: "w", away: "a" };
const MARK = /^([wa]):([0-9A-Za-z-]{1,64})$/;

/** The marks in the `Cookie` header, newest first. Anything that is not a mark is dropped. */
function marksIn(cookieHeader: string | null): string[] {
	for (const pair of cookieHeader?.split(";") ?? []) {
		const separator = pair.indexOf("=");
		if (separator === -1 || pair.slice(0, separator).trim() !== GETTING_STARTED_COOKIE) continue;
		return pair
			.slice(separator + 1)
			.trim()
			.split(".")
			.filter((mark) => MARK.test(mark));
	}
	return [];
}

/** Which marks the person has in their browser. */
export type Marks = Record<Mark, boolean>;

/** Which marks the person `userId` has in the `Cookie` header. */
export function readMarks(cookieHeader: string | null, userId: string): Marks {
	const marks = marksIn(cookieHeader);
	return {
		week: marks.includes(`${CODES.week}:${userId}`),
		away: marks.includes(`${CODES.away}:${userId}`),
	};
}

/** The `Set-Cookie` value that adds `mark` for `userId` to the marks already in the header. */
export function markCookie(cookieHeader: string | null, userId: string, mark: Mark): string {
	const added = `${CODES[mark]}:${userId}`;
	const marks = [added, ...marksIn(cookieHeader).filter((each) => each !== added)];
	const value = marks.slice(0, MOST_MARKS).join(".");
	return `${GETTING_STARTED_COOKIE}=${value}; Max-Age=${ONE_YEAR_IN_SECONDS}; ${ATTRIBUTES}`;
}

/**
 * The steps and whether each is done, or null when the list is not shown: the
 * person put it away, or all three are done. A project is done while the
 * organisation has an active one, an entry once the person has any.
 */
export async function gettingStarted(
	scope: OrganisationScope,
	userId: string,
	{
		hasActiveProject,
		weekOpened,
		putAway,
	}: { hasActiveProject: boolean; weekOpened: boolean; putAway: boolean },
): Promise<GettingStarted | null> {
	if (putAway) return null;
	const [entry] = await scope.timeEntries.select((e) => eq(e.userId, userId), { limit: 1 });
	const steps: GettingStarted = {
		project: hasActiveProject,
		entry: entry !== undefined,
		week: weekOpened,
	};
	return steps.project && steps.entry && steps.week ? null : steps;
}
