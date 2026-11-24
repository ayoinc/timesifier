import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { organisationScope } from "~/db";
import { parseRequest } from "~/lib/validate";
import {
	discardPeopleImport,
	findPeopleImport,
	peopleImports,
	previewPeopleImport,
	revertPeopleImport,
	runPeopleImport,
	standingOf,
	startPeopleImport,
} from "~/onboarding/onboarding.server";
import {
	PEOPLE_FIELD_LABELS,
	PEOPLE_FIELDS,
	PEOPLE_MAX_BYTES,
	PEOPLE_MAX_ROWS,
	type PersonPlan,
} from "~/onboarding/people";
import { isAdministrator } from "~/organisations/access";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { ROLE_LABELS } from "~/organisations/people";
import { mailOrigin } from "~/platform/mail.server";
import { invitationsPath, peopleImportPath } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { useSubmitting } from "~/shell/submitting";
import { formatDayAndTime, formatDayWithYear } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";

import type { Route } from "./+types/invitations.import";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Importing people from a CSV (TS-108, docs/decisions.md entry 72), a page
// below Invitations for owners and admins alone: anyone else gets the 404 of
// a page that is not there. A file is uploaded and kept while its dry run
// shows what each row would do; "Invite" sends every row that can be sent and
// records what applies when each person joins; "Revert" withdraws what is
// still waiting. Nothing is sent before "Invite".

const TITLE = "Import people";

/** The most rows of each list the dry run shows; the counts say how many there are. */
const SHOWN_ROWS = 100;

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** What a row will do, in a line: the role, then the team, its manager, the schedule and its start. */
function planInWords(plan: PersonPlan): string {
	return [
		`${ROLE_LABELS[plan.role]}`,
		plan.team && `joins ${plan.team.name}`,
		plan.manager &&
			`${plan.manager} manages ${plan.team?.name ?? "the team"}${plan.managerInFile ? " (from this file)" : ""}`,
		plan.schedule &&
			`${plan.schedule.name}${plan.startsOn ? ` from ${formatDayWithYear(plan.startsOn)}, or the day they join if later` : " from the day they join"}`,
	]
		.filter(Boolean)
		.join(" · ");
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	if (!isAdministrator(membership.role)) throw notFound();
	const scope = organisationScope(env.DB, membership.organisation.id);
	const id = new URL(request.url).searchParams.get("import");
	const job = id ? await findPeopleImport(scope, id) : null;
	if (id && !job) throw notFound();
	const [zone, preview, standing, imports] = await Promise.all([
		zoneOfMember(membership),
		job?.status === "previewed" && job.source !== null
			? previewPeopleImport(scope, membership.user.id, job.source)
			: null,
		job && job.status !== "previewed" ? standingOf(scope, job.id) : null,
		peopleImports(scope),
	]);
	const toSend =
		preview && "outcomes" in preview ? preview.outcomes.flatMap((o) => (o.ok ? [o] : [])) : [];
	const notSent =
		preview && "outcomes" in preview ? preview.outcomes.flatMap((o) => (o.ok ? [] : [o])) : [];
	return {
		job: job
			? {
					id: job.id,
					fileName: job.fileName,
					status: job.status,
					importedCount: job.importedCount,
					skippedCount: job.skippedCount,
					skipped: (job.skipped ?? []).slice(0, SHOWN_ROWS),
				}
			: null,
		preview:
			preview === null
				? null
				: "problem" in preview
					? { problem: preview.problem }
					: {
							read: preview.read.map(
								(field) => PEOPLE_FIELD_LABELS[field as keyof typeof PEOPLE_FIELD_LABELS],
							),
							unknown: preview.unknown,
							refusal: preview.refusal,
							room: preview.room,
							toSendCount: toSend.length,
							notSentCount: notSent.length,
							toSend: toSend.slice(0, SHOWN_ROWS).map((o) => ({
								line: o.line,
								email: o.email,
								name: o.plan.name,
								does: planInWords(o.plan),
							})),
							notSent: notSent.slice(0, SHOWN_ROWS).map((o) => ({
								line: o.line,
								email: o.email,
								problems: o.problems.join(" "),
							})),
						},
		standing,
		imports: imports.map((each) => ({
			id: each.id,
			fileName: each.fileName,
			status: each.status,
			importedCount: each.importedCount,
			skippedCount: each.skippedCount,
			created: formatDayAndTime(each.createdAt.getTime(), zone),
		})),
	};
}

const Id = z.string().min(1).max(64);

const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("upload"), file: z.instanceof(File) }),
	z.object({ intent: z.literal("import"), importId: Id }),
	z.object({ intent: z.literal("discard"), importId: Id }),
	z.object({ intent: z.literal("revert"), importId: Id }),
]);

export async function action({ request, context }: Route.ActionArgs) {
	const { organisation, user, role } = context.get(membershipContext);
	if (!isAdministrator(role)) throw notFound();
	const input = await parseRequest(request, form, { maxBytes: PEOPLE_MAX_BYTES + 16 * 1024 });
	const scope = organisationScope(env.DB, organisation.id);
	switch (input.intent) {
		case "upload": {
			if (input.file.size === 0) return declined("Choose a CSV file.");
			if (input.file.size > PEOPLE_MAX_BYTES) {
				return declined(`A file is at most ${PEOPLE_MAX_BYTES / 1024} KB. Split it.`);
			}
			const started = await startPeopleImport(
				scope,
				user.id,
				input.file.name || "people.csv",
				await input.file.text(),
			);
			if (!started.ok) return declined(started.problem);
			return redirect(peopleImportPath(organisation.slug, started.id));
		}
		case "import": {
			const sent = await runPeopleImport(scope, user.id, input.importId, mailOrigin(request));
			if (!sent.ok) return declined(sent.problem, 409);
			return redirect(peopleImportPath(organisation.slug, input.importId));
		}
		case "discard": {
			if (!(await findPeopleImport(scope, input.importId))) throw notFound();
			await discardPeopleImport(scope, input.importId);
			return redirect(peopleImportPath(organisation.slug));
		}
		case "revert": {
			const reverted = await revertPeopleImport(scope, user.id, input.importId, new Date());
			if (!reverted.ok) return declined(reverted.problem, 409);
			return done(
				`Import reverted: ${reverted.withdrawn} ${reverted.withdrawn === 1 ? "invitation" : "invitations"} withdrawn.${reverted.joined > 0 ? ` ${reverted.joined} ${reverted.joined === 1 ? "person who joined stays" : "people who joined stay"}.` : ""}`,
			);
		}
	}
}

/** A form posted with the page's own navigation, whose refusal is shown beside it. */
function Problem({ said }: { said: string | undefined }) {
	return (
		<p role="alert" className="mt-2 text-body-medium text-error empty:hidden">
			{said}
		</p>
	);
}

/** "3 people", "1 person". */
function people(count: number): string {
	return `${count} ${count === 1 ? "person" : "people"}`;
}

export default function ImportPeople({ loaderData, actionData }: Route.ComponentProps) {
	const { job, preview, standing, imports } = loaderData;
	const organisation = useOrganisation();
	const submitting = useSubmitting();
	const [said, setSaid] = useState<string | null>(null);
	const [reverting, setReverting] = useState<(typeof imports)[number] | null>(null);
	const refusal =
		actionData && "ok" in actionData && !actionData.ok ? actionData.problem : undefined;

	return (
		<>
			<p className="text-body-medium">
				<Link className={ACTION_LINK} to={invitationsPath(organisation.slug)}>
					Invitations
				</Link>
			</p>
			<PageHeading>{TITLE}</PageHeading>
			<PageLead>
				{`A CSV with a column for each of ${PEOPLE_FIELDS.map((field) => PEOPLE_FIELD_LABELS[field]).join(", ")}, in any order; only Email is needed. Teams and schedules must already exist. Each person gets an invitation, and their team, manager and schedule when they join.`}
			</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			{preview && job ? (
				<Section
					id="dry-run"
					heading={`Dry run of ${job.fileName}`}
					lead="Nothing has been sent yet. Check each row, then send the invitations, or discard the file and upload it again."
				>
					{"problem" in preview ? (
						<p role="alert" className="max-w-160 text-body-large text-error">
							{preview.problem}
						</p>
					) : (
						<>
							<p className="max-w-160 text-body-large">
								Columns read: {preview.read.join(", ")}.
								{preview.unknown.length > 0 && ` Not read: ${preview.unknown.join(", ")}.`}
							</p>
							<p className="mt-4 text-title-medium">
								{people(preview.toSendCount)} to invite, {preview.notSentCount} not sent.
							</p>
							{preview.refusal && (
								<p role="alert" className="mt-2 max-w-160 text-body-large text-error">
									{preview.refusal}
								</p>
							)}
							<Form method="post" className="mt-6 flex flex-wrap gap-2">
								<input type="hidden" name="importId" value={job.id} />
								<Button
									type="submit"
									name="intent"
									value="import"
									isPending={submitting("intent", "import").isPending}
									isDisabled={
										submitting("intent", "import").isDisabled ||
										preview.toSendCount === 0 ||
										preview.refusal !== null
									}
								>
									{`Invite ${people(preview.toSendCount)}`}
								</Button>
								<Button
									type="submit"
									name="intent"
									value="discard"
									variant="text"
									{...submitting("intent", "discard")}
								>
									Discard
								</Button>
							</Form>
							<Problem said={refusal} />

							{preview.notSentCount > 0 && (
								<div className="mt-6 max-w-200">
									<Ledger heading="Not sent" note={preview.notSentCount}>
										<LedgerRows label="Rows not sent">
											{preview.notSent.map((row) => (
												<LedgerRow
													key={row.line}
													aside={`Line ${row.line}`}
													title={<span className="wrap-anywhere">{row.email || "No address"}</span>}
													detail={row.problems}
												/>
											))}
										</LedgerRows>
									</Ledger>
								</div>
							)}
							{preview.toSendCount > 0 && (
								<div className="mt-6 max-w-200">
									<Ledger heading="To invite" note={preview.toSendCount}>
										<LedgerRows label="Rows to invite">
											{preview.toSend.map((row) => (
												<LedgerRow
													key={row.line}
													aside={`Line ${row.line}`}
													title={
														<span className="wrap-anywhere">
															{row.name ? `${row.name} · ${row.email}` : row.email}
														</span>
													}
													detail={row.does}
												/>
											))}
										</LedgerRows>
									</Ledger>
								</div>
							)}
						</>
					)}
				</Section>
			) : (
				<Section
					id="upload"
					heading={job ? `${job.fileName}: ${job.status}` : "Choose a file"}
					lead={
						job && standing
							? `${people(job.importedCount)} invited, ${job.skippedCount} not sent. ${standing.joined} joined, ${standing.waiting} still invited, ${standing.withdrawn} withdrawn or expired.`
							: `It is read, not sent: you see what each row would do first. At most ${PEOPLE_MAX_ROWS} people.`
					}
				>
					{job && job.skipped.length > 0 && (
						<div className="mb-6 max-w-200">
							<Ledger heading="Not sent" note={job.skippedCount}>
								<LedgerRows label="Rows not sent">
									{job.skipped.map((row) => (
										<LedgerRow key={row.line} aside={`Line ${row.line}`} title={row.reason} />
									))}
								</LedgerRows>
							</Ledger>
						</div>
					)}
					<Form
						method="post"
						encType="multipart/form-data"
						className="flex max-w-160 flex-col gap-4"
					>
						<label className="flex flex-col gap-1 text-body-large">
							<span className="text-label-large">CSV file</span>
							<input
								type="file"
								name="file"
								accept=".csv,text/csv"
								required
								className="min-h-11 rounded-small border border-outline-variant p-3 text-body-medium file:mr-4 file:rounded-large file:border-0 file:bg-secondary-container file:px-4 file:py-2 file:text-on-secondary-container"
							/>
						</label>
						<div>
							<Button
								type="submit"
								name="intent"
								value="upload"
								{...submitting("intent", "upload")}
							>
								Upload for a dry run
							</Button>
						</div>
					</Form>
					<Problem said={refusal} />
				</Section>
			)}

			<Section id="imports" heading="Earlier imports">
				<div className="max-w-200">
					<Ledger heading={TITLE} note={imports.length}>
						{imports.length === 0 ? (
							<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
								No people imported yet.
							</p>
						) : (
							<LedgerRows label="Earlier imports">
								{imports.map((each) => (
									<LedgerRow
										key={each.id}
										title={
											<Link
												className={ACTION_LINK}
												to={peopleImportPath(organisation.slug, each.id)}
											>
												{each.fileName}
											</Link>
										}
										detail={`${each.status === "imported" ? `${people(each.importedCount)} invited, ${each.skippedCount} not sent` : each.status === "reverted" ? "Reverted" : "Dry run, not sent"}. ${each.created}.`}
										action={
											each.status === "imported" ? (
												<Button
													variant="text"
													aria-label={`Revert ${each.fileName}`}
													onPress={() => setReverting(each)}
												>
													Revert
												</Button>
											) : undefined
										}
									/>
								))}
							</LedgerRows>
						)}
					</Ledger>
				</div>
			</Section>

			<FormSheet
				title={`Revert ${reverting?.fileName ?? "this import"}?`}
				intent="revert"
				submitLabel="Revert import"
				isOpen={reverting !== null}
				onClose={() => setReverting(null)}
				onDone={setSaid}
			>
				<input type="hidden" name="importId" value={reverting?.id ?? ""} />
				<p>
					Its invitations still waiting are cancelled, and their links stop working. The teams,
					managers and schedules they were to bring are dropped. People who have joined stay as they
					are.
				</p>
			</FormSheet>
		</>
	);
}
