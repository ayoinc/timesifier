import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { organisationScope } from "~/db";
import type { Membership } from "~/organisations/membership.server";
import { runningEntry } from "~/time/entries.server";
import { ownZoneOf } from "~/time/zones.server";

/** What the timer's control in the navigation shows (TS-051). */
export interface NavigationTimerData {
	/** The person's running entry: its project's name and when it started. Null when nothing runs. */
	running: { projectName: string; startedAt: number } | null;
	/** Whether the person has chosen a zone, or had one set from their browser (TS-012a). */
	hasTimeZone: boolean;
	/** The time of the request: what the server draws the elapsed time at. */
	now: number;
}

/**
 * What the timer's control shows on every page of an organisation, read by
 * the organisation layout's loader: the person's running entry, or null, and
 * whether they have a zone of their own yet. Until they do, the control sets
 * it from the browser's.
 */
export async function navigationTimer(membership: Membership): Promise<NavigationTimerData> {
	const scope = organisationScope(env.DB, membership.organisation.id);
	const [entry, ownZone] = await Promise.all([
		runningEntry(scope, membership.user.id),
		ownZoneOf(membership),
	]);
	let running: NavigationTimerData["running"] = null;
	if (entry) {
		const [project] = await scope.projects.select((p) => eq(p.id, entry.projectId), { limit: 1 });
		running = { projectName: project?.name ?? "", startedAt: entry.startedAt.getTime() };
	}
	return { running, hasTimeZone: ownZone !== null, now: Date.now() };
}
