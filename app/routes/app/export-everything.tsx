import { env, waitUntil } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { Link, useRevalidator } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { organisationScope } from "~/db";
import { advanceExport, exportStateOf, requestExport } from "~/exports/job.server";
import { EXPORT_KEEP_DAYS, everythingDownloadPath } from "~/exports/paths";
import { parseRequest } from "~/lib/validate";
import { type Membership, membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { destinationPath } from "~/shell/destinations";
import { ACTION_LINK, TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { formatDayAndTime } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";
import type { Route } from "./+types/export-everything";
import { FormSheet } from "./FormSheet";

// Export everything (TS-126, docs/decisions.md entry 71): one ZIP of
// everything the organisation holds, which an owner asks for here, is emailed
// about when it is made, and downloads here for 7 days. Only owners open the
// page: it sits below Workspace settings, which admins are shown too, so the
// loader and the action answer anybody else with the 404 a page they may not
// open answers.

const TITLE = "Export everything";

/** How often the page reads the export again while it is being made. */
const WHILE_MADE_EVERY_MS = 5_000;

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** The membership, when it is an owner's; a 404 for anybody else. */
function ownerOnly(membership: Membership): Membership {
	if (membership.role !== "owner") throw notFound();
	return membership;
}

/** A size in bytes, as a person reads it: "820 KB", "4.2 MB", "1.3 GB". */
function sizeText(bytes: number): string {
	if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
	if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export async function loader({ context }: Route.LoaderArgs) {
	const membership = ownerOnly(context.get(membershipContext));
	const scope = organisationScope(env.DB, membership.organisation.id);
	const now = new Date();
	const [state, zone] = await Promise.all([exportStateOf(scope, now), zoneOfMember(membership)]);
	// Times are written out here, in the person's own zone, so the page reads
	// the same on the server and in the browser.
	const when = (at: Date) => formatDayAndTime(at.getTime(), zone);
	switch (state.status) {
		case "none":
			return { status: state.status };
		case "running":
		case "failed":
			return { status: state.status, requestedAt: when(state.requestedAt) };
		case "ready":
			return {
				status: state.status,
				madeAt: when(state.finishedAt),
				keptUntil: when(state.expiresAt),
				size: sizeText(state.size),
			};
	}
}

const form = z.object({ intent: z.literal("export") });

export async function action({ request, context }: Route.ActionArgs) {
	// The role is checked before the form is read, so nobody else learns even what it would accept.
	const membership = ownerOnly(context.get(membershipContext));
	await parseRequest(request, form);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const now = new Date();
	const requested = await requestExport(scope, membership.user.id, now);
	if (!requested.ok) return declined(requested.problem, 409);
	// The first step runs once the answer is sent; a small organisation's
	// export is made by it, a large one's by the every-minute trigger after.
	waitUntil(advanceExport(membership.organisation.id, requested.id, now));
	return done("Your export is being made. You'll get an email when it's ready.");
}

export default function ExportEverything({ loaderData, params }: Route.ComponentProps) {
	const [asking, setAsking] = useState(false);
	const [said, setSaid] = useState<string | null>(null);
	const { revalidate, state } = useRevalidator();
	const running = loaderData.status === "running";

	// While it is being made the page asks again every few seconds, so it shows
	// the download as soon as there is one; the email says so too.
	useEffect(() => {
		if (!running) return;
		const every = window.setInterval(() => {
			if (state === "idle" && document.visibilityState === "visible") void revalidate();
		}, WHILE_MADE_EVERY_MS);
		return () => window.clearInterval(every);
	}, [running, revalidate, state]);

	const heading = {
		none: "No export yet",
		running: "Being made",
		ready: "Ready to download",
		failed: "It could not be made",
	}[loaderData.status];

	return (
		<>
			<PageHeading>{TITLE}</PageHeading>
			<PageLead>
				One ZIP of everything your organisation holds in Timesifier, to keep or to take elsewhere.
				Only owners can make it, and it is kept for {EXPORT_KEEP_DAYS} days.
			</PageLead>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<Section id="state" heading={heading} className="max-w-200">
				<div className="flex flex-col items-start gap-4 text-body-large">
					{loaderData.status === "none" && (
						<p>Make an export, and we'll email you when it's ready to download.</p>
					)}
					{loaderData.status === "running" && (
						<p>
							Asked for on {loaderData.requestedAt}. We'll email you when it's ready: in a minute or
							two for most organisations, within the hour for a large one.
						</p>
					)}
					{loaderData.status === "failed" && (
						<p>
							Asked for on {loaderData.requestedAt}, and it could not be made. Make it again; if it
							fails again, write to us.
						</p>
					)}
					{loaderData.status === "ready" && (
						<>
							<p>
								Made on {loaderData.madeAt}, {loaderData.size}. It is kept until{" "}
								{loaderData.keptUntil}, then deleted.
							</p>
							{/* A plain link: the browser saves the file as it comes, however large. */}
							<a
								href={everythingDownloadPath(params.organisation)}
								className={ACTION_LINK}
								download
							>
								Download the ZIP
							</a>
						</>
					)}
					{!running && (
						<Button
							variant={loaderData.status === "ready" ? "outlined" : "filled"}
							onPress={() => setAsking(true)}
						>
							{loaderData.status === "none" ? "Export everything" : "Export again"}
						</Button>
					)}
				</div>
			</Section>

			<Section id="holds" heading="What it holds" className="max-w-200">
				<ul className="flex list-disc flex-col gap-2 ps-6 text-body-large">
					<li>
						Every table of your organisation as a CSV file with a header row, under{" "}
						<code>tables/</code>: time, expenses, leave, projects, clients, invoices, estimates,
						rates, the activity log and the rest. A large table is split into several files.
					</li>
					<li>Your members' names, email addresses and time zones.</li>
					<li>
						Every receipt, under <code>receipts/</code>, named by its expense, and your logo.
					</li>
					<li>
						<code>manifest.json</code>, which lists each file with its rows, and the export's time
						and version.
					</li>
				</ul>
				<p className="mt-4 text-body-large">
					It leaves out the secrets that sign in or prove a link: API tokens, webhook secrets,
					calendar feed addresses and invitation links. People who have left keep their entries, by
					their id, without their name or address. Each export and each download is written in your{" "}
					<Link to={destinationPath(params.organisation, "activity")} className={TEXT_LINK}>
						activity log
					</Link>
					.
				</p>
			</Section>

			<FormSheet
				title={loaderData.status === "ready" ? "Export again?" : "Export everything?"}
				intent="export"
				submitLabel="Make the export"
				isOpen={asking}
				onClose={() => setAsking(false)}
				onDone={setSaid}
			>
				<p>
					Timesifier makes one ZIP of everything your organisation holds and emails you when it's
					ready. {loaderData.status === "ready" && "The export you have now is deleted."}
				</p>
			</FormSheet>
		</>
	);
}
