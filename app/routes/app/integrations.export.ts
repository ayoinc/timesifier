import { env } from "cloudflare:workers";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { type OrganisationScope, organisationScope, users } from "~/db";
import { exportFilename } from "~/organisations/export-filename";
import { membershipContext } from "~/organisations/membership.server";
import { BYTE_ORDER_MARK, csvLine } from "~/reports/csv";
import { dayOf } from "~/time/calendar";

import type { Route } from "./+types/integrations.export";

// Every entry of the organisation as a CSV (TS-014b amended by TS-076), below
// Integrations, so only its owners and admins reach it. The columns are
// Harvest's import columns and an email, so the file can be imported again,
// here or in Harvest. It is streamed a page at a time and nothing is stored.
// Overtime (TS-095) is a last column of its own, Yes or No; an import here
// reads each row's kind from the day's limits again, and Harvest ignores it.

/** The columns, in their order: Harvest's eight, the person's email, then whether it is overtime. */
export const EXPORT_COLUMNS = [
	"Date",
	"Client",
	"Project",
	"Task",
	"Notes",
	"Hours",
	"First name",
	"Last name",
	"Email",
	"Overtime",
] as const;

const PAGE = 500;

/** What the rows name, by id. */
interface Names {
	project: Map<string, { name: string; clientId: string | null }>;
	client: Map<string, string>;
	task: Map<string, string>;
	person: Map<string, { name: string; email: string; zone: string | null }>;
}

/** Names by id, read before the file starts, so a file that is never read reads nothing more. */
async function namesOf(scope: OrganisationScope): Promise<Names> {
	const [projects, clients, tasks, memberships] = await Promise.all([
		scope.projects.select(),
		scope.clients.select(),
		scope.tasks.select(),
		scope.memberships.select(),
	]);
	const people = memberships.length
		? await drizzle(env.DB)
				.select({ id: users.id, name: users.name, email: users.email, zone: users.timeZone })
				.from(users)
				.where(
					inArray(
						users.id,
						memberships.map((m) => m.userId),
					),
				)
		: [];
	return {
		project: new Map(projects.map((p) => [p.id, p])),
		client: new Map(clients.map((c) => [c.id, c.name])),
		task: new Map(tasks.map((t) => [t.id, t.name])),
		person: new Map(people.map((p) => [p.id, p])),
	};
}

async function* chunks(
	scope: OrganisationScope,
	{ project, client, task, person }: Names,
	organisationZone: string,
	now: number,
) {
	yield BYTE_ORDER_MARK + csvLine(EXPORT_COLUMNS);
	// Oldest first, a page at a time: each page starts after the last row of the one before.
	let after: { at: Date; id: string } | null = null;
	for (;;) {
		const last = after;
		const entries = await scope.timeEntries.select(
			(e) =>
				last
					? or(gt(e.startedAt, last.at), and(eq(e.startedAt, last.at), gt(e.id, last.id)))
					: undefined,
			{ orderBy: (e) => [asc(e.startedAt), asc(e.id)], limit: PAGE },
		);
		if (entries.length === 0) return;
		let chunk = "";
		for (const entry of entries) {
			const who = person.get(entry.userId);
			const [first = "", ...rest] = (who?.name ?? "").split(" ");
			const of = project.get(entry.projectId);
			const minutes = ((entry.endedAt?.getTime() ?? now) - entry.startedAt.getTime()) / 60_000;
			chunk += csvLine([
				dayOf(entry.startedAt, who?.zone ?? organisationZone),
				of?.clientId ? (client.get(of.clientId) ?? "") : "",
				of?.name ?? "",
				entry.taskId ? (task.get(entry.taskId) ?? "") : "",
				entry.description ?? "",
				(Math.round((minutes / 60) * 100) / 100).toFixed(2),
				first,
				rest.join(" "),
				who?.email ?? "",
				entry.overtime ? "Yes" : "No",
			]);
		}
		yield chunk;
		const end = entries.at(-1);
		if (end) after = { at: end.startedAt, id: end.id };
		if (entries.length < PAGE) return;
	}
}

export async function loader({ context }: Route.LoaderArgs) {
	const { organisation } = context.get(membershipContext);
	const scope = organisationScope(env.DB, organisation.id);
	const source = chunks(scope, await namesOf(scope), organisation.timeZone, Date.now());
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await source.next();
			if (next.done) controller.close();
			else controller.enqueue(encoder.encode(next.value));
		},
		async cancel() {
			await source.return(undefined);
		},
	});
	return new Response(body, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8; header=present",
			"Content-Disposition": `attachment; filename="${exportFilename(organisation.name, "all-time", dayOf(Date.now(), organisation.timeZone), "csv")}"`,
			"Cache-Control": "no-store",
		},
	});
}
