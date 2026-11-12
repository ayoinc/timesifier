import { env } from "cloudflare:workers";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { type OrganisationScope, users, uuidv7 } from "~/db";
import { addressLine, shownName } from "~/organisations/people";

import { readSavedQuery, type SavedView } from "./saved";

/**
 * Saved and shared reports (TS-080, B18) as the database holds them. A saved
 * report is its owner's; they share it with named members of the
 * organisation, to view or to edit. Anyone who opens one runs it as
 * themselves: the view reads the report with their own access, so a member
 * opening an admin's report sees their own hours and nobody else's. Every
 * read and write goes through the organisation's scope, and a report the
 * person may not open is no report to them.
 */

export interface SavedShare {
	userId: string;
	name: string;
	address: string | null;
	canEdit: boolean;
}

export interface SavedReport {
	id: string;
	name: string;
	view: SavedView;
	/** The report's address after its view's, without "?". */
	search: string;
	ownerId: string;
	ownerName: string;
	/** Whether the person asking owns it. */
	isOwner: boolean;
	/** Whether the person asking may rename it or change what it asks. */
	canEdit: boolean;
	/** Whom it is shared with: listed to its owner alone. */
	shares: SavedShare[];
}

/** The names of these people, as lists show them. */
async function peopleNamed(ids: readonly string[]) {
	const wanted = [...new Set(ids)];
	if (wanted.length === 0) return new Map<string, { name: string; address: string | null }>();
	const rows = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(inArray(users.id, wanted));
	return new Map(rows.map((u) => [u.id, { name: shownName(u), address: addressLine(u) }]));
}

/** The saved reports `viewerId` may open: their own, then those shared with them, each by name. */
export async function savedReportsFor(
	scope: OrganisationScope,
	viewerId: string,
): Promise<SavedReport[]> {
	const sharedWithMe = await scope.savedReportShares.select((s) => eq(s.userId, viewerId));
	const sharedIds = sharedWithMe.map((s) => s.reportId);
	const unique = await scope.savedReports.select((r) =>
		sharedIds.length === 0
			? eq(r.ownerId, viewerId)
			: or(eq(r.ownerId, viewerId), inArray(r.id, sharedIds)),
	);
	const ownIds = unique.filter((r) => r.ownerId === viewerId).map((r) => r.id);
	const shares =
		ownIds.length === 0
			? []
			: await scope.savedReportShares.select((s) => inArray(s.reportId, ownIds));
	const names = await peopleNamed([
		...unique.map((r) => r.ownerId),
		...shares.map((s) => s.userId),
	]);
	const canEditShared = new Map(sharedWithMe.map((s) => [s.reportId, s.canEdit]));
	return unique
		.flatMap((r) => {
			const read = readSavedQuery(r.query);
			if (!read) return [];
			const isOwner = r.ownerId === viewerId;
			return [
				{
					id: r.id,
					name: r.name,
					view: read.view,
					search: read.search.toString(),
					ownerId: r.ownerId,
					ownerName: names.get(r.ownerId)?.name ?? "",
					isOwner,
					canEdit: isOwner || canEditShared.get(r.id) === true,
					shares: isOwner
						? shares
								.filter((s) => s.reportId === r.id)
								.map((s) => ({
									userId: s.userId,
									name: names.get(s.userId)?.name ?? "",
									address: names.get(s.userId)?.address ?? null,
									canEdit: s.canEdit,
								}))
								.sort((a, b) => a.name.localeCompare(b.name, "en"))
						: [],
				},
			];
		})
		.sort(
			(a, b) =>
				Number(b.isOwner) - Number(a.isOwner) ||
				a.name.localeCompare(b.name, "en") ||
				(a.id < b.id ? -1 : 1),
		);
}

/** The saved report `id` as `viewerId` may open it, or null when they may not. */
export async function savedReportFor(
	scope: OrganisationScope,
	viewerId: string,
	id: string,
): Promise<SavedReport | null> {
	return (await savedReportsFor(scope, viewerId)).find((r) => r.id === id) ?? null;
}

/** Saves a report of `ownerId` under `name`, and returns its id. */
export async function saveReport(
	scope: OrganisationScope,
	ownerId: string,
	name: string,
	query: string,
): Promise<string> {
	const id = uuidv7();
	await scope.savedReports.insert({ id, ownerId, name, query });
	return id;
}

/** Changes the name or the question of a report `viewerId` may edit; false when they may not. */
export async function changeSavedReport(
	scope: OrganisationScope,
	viewerId: string,
	id: string,
	change: { name?: string; query?: string },
): Promise<boolean> {
	const report = await savedReportFor(scope, viewerId, id);
	if (!report?.canEdit) return false;
	const changed = await scope.savedReports.update({ ...change, updatedAt: new Date() }, (r) =>
		eq(r.id, id),
	);
	return changed.length === 1;
}

/** Deletes a report of `ownerId`, and its shares with it; false when it is not theirs. */
export async function deleteSavedReport(
	scope: OrganisationScope,
	ownerId: string,
	id: string,
): Promise<boolean> {
	const gone = await scope.savedReports.delete((r) => and(eq(r.id, id), eq(r.ownerId, ownerId)));
	return gone.length === 1;
}

/**
 * Shares a report of `ownerId` with the member `userId`, to view or to edit,
 * or changes how it is shared. "missing" when the report is not theirs,
 * "not-member" when the person is not a member, "self" for its owner.
 */
export async function shareSavedReport(
	scope: OrganisationScope,
	ownerId: string,
	id: string,
	userId: string,
	canEdit: boolean,
): Promise<"done" | "missing" | "not-member" | "self"> {
	const [report] = await scope.savedReports.select(
		(r) => and(eq(r.id, id), eq(r.ownerId, ownerId)),
		{ limit: 1 },
	);
	if (!report) return "missing";
	if (userId === ownerId) return "self";
	const [member] = await scope.memberships.select((m) => eq(m.userId, userId), { limit: 1 });
	if (!member) return "not-member";
	const changed = await scope.savedReportShares.update({ canEdit }, (s) =>
		and(eq(s.reportId, id), eq(s.userId, userId)),
	);
	if (changed.length === 0) await scope.savedReportShares.insert({ reportId: id, userId, canEdit });
	return "done";
}

/** Stops sharing a report of `ownerId` with `userId`; false when there was no such share. */
export async function unshareSavedReport(
	scope: OrganisationScope,
	ownerId: string,
	id: string,
	userId: string,
): Promise<boolean> {
	const [report] = await scope.savedReports.select(
		(r) => and(eq(r.id, id), eq(r.ownerId, ownerId)),
		{ limit: 1 },
	);
	if (!report) return false;
	const gone = await scope.savedReportShares.delete((s) =>
		and(eq(s.reportId, id), eq(s.userId, userId)),
	);
	return gone.length === 1;
}
