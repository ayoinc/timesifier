import { env } from "cloudflare:workers";
import { and, eq, gte, lte, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { among, type OrganisationScope, users } from "~/db";
import { nameOrEmail } from "~/organisations/people";
import type { Day } from "~/time/calendar";

/**
 * Requests asked again after a refusal (D5, decision 47). Once a manager has
 * refused a request for leave, or for overtime or weekend work, a request of
 * the same person for any of the same days, of the same kind for work, can
 * be approved only by whoever refused it, or by an owner or admin
 * (`mayApproveAfterRefusals` in `app/organisations/access.ts`), so a person
 * cannot ask each of their managers in turn.
 */

/** A pending request as these rules read it. */
export interface AskedAgain {
	id: string;
	userId: string;
	startsOn: Day;
	endsOn: Day;
}

/** Who refused the earlier requests for leave of `request`'s person that share a day with it. */
export async function leaveRefusersOf(
	scope: OrganisationScope,
	request: AskedAgain,
): Promise<string[]> {
	const rows = await scope.leaveRequests.select((r) =>
		and(
			eq(r.userId, request.userId),
			eq(r.status, "refused"),
			ne(r.id, request.id),
			lte(r.startsOn, request.endsOn),
			gte(r.endsOn, request.startsOn),
		),
	);
	return [...new Set(rows.flatMap((r) => (r.decidedBy ? [r.decidedBy] : [])))];
}

/** Who refused the earlier requests for work of `request`'s kind and person that share a day with it. */
export async function workRefusersOf(
	scope: OrganisationScope,
	request: AskedAgain & { kind: string },
): Promise<string[]> {
	const rows = await scope.workRequests.select((w) =>
		and(
			eq(w.userId, request.userId),
			eq(w.kind, request.kind),
			eq(w.status, "refused"),
			ne(w.id, request.id),
			lte(w.startsOn, request.endsOn),
			gte(w.endsOn, request.startsOn),
		),
	);
	return [...new Set(rows.flatMap((w) => (w.decidedBy ? [w.decidedBy] : [])))];
}

/**
 * For each of `pending`, who refused an earlier request of its person that
 * shares a day with it (of the same kind, for work), read in one query for
 * the list Approvals shows. Requests no refusal touches are left out.
 */
export async function refusersOfAll<Request extends AskedAgain & { kind?: string }>(
	scope: OrganisationScope,
	table: "leave" | "work",
	pending: readonly Request[],
): Promise<Map<string, string[]>> {
	const found = new Map<string, string[]>();
	const people = [...new Set(pending.map((r) => r.userId))];
	if (people.length === 0) return found;
	const refused =
		table === "leave"
			? await scope.leaveRequests.select((r) =>
					and(among(r.userId, people), eq(r.status, "refused")),
				)
			: await scope.workRequests.select((w) =>
					and(among(w.userId, people), eq(w.status, "refused")),
				);
	for (const request of pending) {
		const by = new Set<string>();
		for (const r of refused) {
			if (r.userId !== request.userId || r.id === request.id || !r.decidedBy) continue;
			if ("kind" in r && request.kind !== undefined && r.kind !== request.kind) continue;
			if (r.startsOn <= request.endsOn && request.startsOn <= r.endsOn) by.add(r.decidedBy);
		}
		if (by.size > 0) found.set(request.id, [...by]);
	}
	return found;
}

/** The names of `ids`, as the pages show people, by id. */
export async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
	const wanted = [...new Set(ids)];
	if (wanted.length === 0) return new Map();
	const rows = await drizzle(env.DB)
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(among(users.id, wanted));
	return new Map(rows.map((user) => [user.id, nameOrEmail(user)]));
}

/** The names of whoever refused earlier requests for the days of the request `requestId`, for the sentence that says why it cannot be approved. */
export async function refusersNamed(
	scope: OrganisationScope,
	table: "leave" | "work",
	requestId: string,
): Promise<string[]> {
	const [row] =
		table === "leave"
			? await scope.leaveRequests.select((r) => eq(r.id, requestId), { limit: 1 })
			: await scope.workRequests.select((w) => eq(w.id, requestId), { limit: 1 });
	if (!row) return [];
	const ids = "kind" in row ? await workRefusersOf(scope, row) : await leaveRefusersOf(scope, row);
	const names = await namesOf(ids);
	return ids.map((id) => names.get(id) ?? "");
}
