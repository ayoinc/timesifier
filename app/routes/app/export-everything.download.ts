import { env } from "cloudflare:workers";

import { organisationScope } from "~/db";
import { downloadExport } from "~/exports/job.server";
import { membershipContext, notFound } from "~/organisations/membership.server";

import type { Route } from "./+types/export-everything.download";

// The ZIP of the export of everything (TS-126), streamed from R2 to an owner
// and the download recorded in the activity log. Anybody else, and an owner
// once its 7 days have ended or before it is made, gets the same 404.

export async function loader({ context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	if (membership.role !== "owner") throw notFound();
	const scope = organisationScope(env.DB, membership.organisation.id);
	const download = await downloadExport(scope, membership.user.id, new Date());
	if (!download) throw notFound();
	return download;
}
