import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { organisationScope } from "~/db";
import { codedName } from "~/lib/codes";
import { parseRequest } from "~/lib/validate";
import { moneyText } from "~/money/typed";
import { isAdministrator } from "~/organisations/access";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { BILLING_TYPE_LABELS } from "~/projects/billing";
import { TEAM_ROLE_LABELS } from "~/projects/teams";
import { setupImportPath } from "~/setup-import/paths";
import {
	type AssignmentPlan,
	counted,
	type PackagePlan,
	type ProjectPlan,
	SETUP_FIELD_LABELS,
	SETUP_FIELDS,
	SETUP_KIND_LABELS,
	SETUP_MAX_BYTES,
	SETUP_MAX_ROWS,
	type SetupOutcome,
} from "~/setup-import/setup";
import {
	discardSetupImport,
	findSetupImport,
	previewSetupImport,
	revertSetupImport,
	runSetupImport,
	setupImports,
	setupStandingOf,
	startSetupImport,
} from "~/setup-import/setup-import.server";
import { destinationPath } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { useSubmitting } from "~/shell/submitting";
import { formatDayAndTime, formatDayWithYear } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";
import { inTerms, termsOf } from "~/workspace/work-model";

import type { Route } from "./+types/projects.import";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// The set-up import (TS-115d, docs/decisions.md entry 77): projects, their
// work packages and the people on their teams from one CSV, a page below
// Projects for owners and admins alone; anyone else gets the 404 of a page
// that is not there. A file is uploaded and kept while its dry run shows what
// each row would add; "Import" adds every row that can be added, in one batch;
// "Revert" takes it all away again while nothing has been tracked to it.

const TITLE = "Set up from a CSV";

/** The most rows of each list the dry run shows; the counts say how many there are. */
const SHOWN_ROWS = 100;

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

/** "from Tuesday 1 December 2026 to …", "from …", "until …", or nothing. */
function daysInWords(startsOn: string | null, endsOn: string | null): string | null {
	if (startsOn && endsOn) return `${formatDayWithYear(startsOn)} to ${formatDayWithYear(endsOn)}`;
	if (startsOn) return `from ${formatDayWithYear(startsOn)}`;
	if (endsOn) return `until ${formatDayWithYear(endsOn)}`;
	return null;
}

function projectInWords(plan: ProjectPlan, workCode: string): string {
	return [
		plan.client ? `for ${plan.client.code}` : plan.workCode ? `a ${workCode}` : "no client",
		BILLING_TYPE_LABELS[plan.billing],
		daysInWords(plan.startsOn, plan.endsOn),
	]
		.filter(Boolean)
		.join(" · ");
}

function packageInWords(plan: PackagePlan): string {
	const { kind, amount } = plan.budget;
	return [
		`in ${plan.project.code}${plan.project.existing ? "" : ` (line ${plan.project.line})`}`,
		kind === "hours" && amount !== null
			? `${counted(amount / 60, "hour", "hours")} budget`
			: kind === "fees" && amount !== null
				? `${moneyText(amount, plan.currency)} ${plan.currency} budget`
				: "no budget",
		daysInWords(plan.startsOn, plan.endsOn),
	]
		.filter(Boolean)
		.join(" · ");
}

function assignmentInWords(plan: AssignmentPlan): string {
	return [
		`${TEAM_ROLE_LABELS[plan.role]} on ${plan.project.code}${plan.project.existing ? "" : ` (line ${plan.project.line})`}`,
		`${daysInWords(plan.startsOn, plan.endsOn)}${plan.startsToday ? " (no start given: today)" : ""}`,
		"invitationId" in plan.who ? "invited, not joined: put on the team when they join" : null,
	]
		.filter(Boolean)
		.join(" · ");
}

/** One row of the dry run, as the page lists it. */
function rowOf(outcome: Extract<SetupOutcome, { ok: true }>, workCode: string) {
	switch (outcome.kind) {
		case "project":
			return {
				line: outcome.line,
				title: codedName(outcome.plan.code, outcome.plan.name),
				does: projectInWords(outcome.plan, workCode),
			};
		case "work_package":
			return {
				line: outcome.line,
				title: `${outcome.plan.code} ${outcome.plan.name}`,
				does: packageInWords(outcome.plan),
			};
		case "assignment":
			return {
				line: outcome.line,
				title: outcome.plan.email,
				does: assignmentInWords(outcome.plan),
			};
	}
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	if (!isAdministrator(membership.role)) throw notFound();
	const { organisation } = membership;
	const scope = organisationScope(env.DB, organisation.id);
	const id = new URL(request.url).searchParams.get("import");
	const job = id ? await findSetupImport(scope, id) : null;
	if (id && !job) throw notFound();
	const now = new Date();
	const [zone, preview, standing, imports] = await Promise.all([
		zoneOfMember(membership),
		job?.status === "previewed" && job.source !== null
			? previewSetupImport(scope, job.source, now)
			: null,
		job?.status === "imported" ? setupStandingOf(scope, job.id, now) : null,
		setupImports(scope),
	]);
	const terms = termsOf(organisation.workModel, organisation.internalTerm);
	const workCode = terms.WorkCode.toLowerCase();
	const outcomes = preview && "outcomes" in preview ? preview.outcomes : [];
	const ofKind = (kind: SetupOutcome["kind"]) =>
		outcomes
			.flatMap((o) => (o.ok && o.kind === kind ? [rowOf(o, workCode)] : []))
			.slice(0, SHOWN_ROWS);
	const notAdded = outcomes.flatMap((o) => (o.ok ? [] : [o]));
	return {
		terms,
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
							read: preview.read.map((field) => SETUP_FIELD_LABELS[field]),
							unknown: preview.unknown,
							counts: preview.counts,
							projects: ofKind("project"),
							workPackages: ofKind("work_package"),
							assignments: ofKind("assignment"),
							notAdded: notAdded.slice(0, SHOWN_ROWS).map((o) => ({
								line: o.line,
								kind: o.kind ? SETUP_KIND_LABELS[o.kind] : "Unknown kind",
								label: o.label,
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
	const input = await parseRequest(request, form, { maxBytes: SETUP_MAX_BYTES + 16 * 1024 });
	const scope = organisationScope(env.DB, organisation.id);
	switch (input.intent) {
		case "upload": {
			if (input.file.size === 0) return declined("Choose a CSV file.");
			if (input.file.size > SETUP_MAX_BYTES) {
				return declined(`A file is at most ${SETUP_MAX_BYTES / 1024} KB. Split it.`);
			}
			const started = await startSetupImport(
				scope,
				user.id,
				input.file.name || "setup.csv",
				await input.file.text(),
			);
			if (!started.ok) return declined(started.problem);
			return redirect(setupImportPath(organisation.slug, started.id));
		}
		case "import": {
			const imported = await runSetupImport(scope, user.id, input.importId, new Date());
			if (!imported.ok) return declined(imported.problem, 409);
			return redirect(setupImportPath(organisation.slug, input.importId));
		}
		case "discard": {
			if (!(await findSetupImport(scope, input.importId))) throw notFound();
			await discardSetupImport(scope, input.importId);
			return redirect(setupImportPath(organisation.slug));
		}
		case "revert": {
			const reverted = await revertSetupImport(scope, user.id, input.importId, new Date());
			if (!reverted.ok) return declined(reverted.problem, 409);
			const terms = termsOf(organisation.workModel, organisation.internalTerm);
			return done(
				inTerms(
					`Import reverted: ${counted(reverted.projects, "project", "projects")}, ${counted(reverted.workPackages, "work package", "work packages")} and ${counted(reverted.assignments + reverted.waiting, "assignment", "assignments")} taken away.`,
					terms,
				),
			);
		}
	}
}

/** A form posted with the page's own navigation, whose refusal is shown beside it. */
function Problem({ said }: { said: string | undefined }) {
	return (
		<p role="alert" className="mt-2 max-w-160 text-body-medium text-error empty:hidden">
			{said}
		</p>
	);
}

/** One list of the dry run: the rows of one kind it will add. */
function Adding({
	heading,
	count,
	rows,
}: {
	heading: string;
	count: number;
	rows: { line: number; title: string; does: string }[];
}) {
	if (count === 0) return null;
	return (
		<div className="mt-6 max-w-200">
			<Ledger heading={heading} note={count}>
				<LedgerRows label={heading}>
					{rows.map((row) => (
						<LedgerRow
							key={row.line}
							aside={`Line ${row.line}`}
							title={<span className="wrap-anywhere">{row.title}</span>}
							detail={row.does}
						/>
					))}
				</LedgerRows>
			</Ledger>
		</div>
	);
}

export default function SetUpFromCsv({ loaderData, actionData }: Route.ComponentProps) {
	const { job, preview, standing, imports, terms } = loaderData;
	const organisation = useOrganisation();
	const submitting = useSubmitting();
	const [said, setSaid] = useState<string | null>(null);
	const [reverting, setReverting] = useState<(typeof imports)[number] | null>(null);
	const refusal =
		actionData && "ok" in actionData && !actionData.ok ? actionData.problem : undefined;
	const t = (text: string) => inTerms(text, terms);

	return (
		<>
			<p className="text-body-medium">
				<Link className={ACTION_LINK} to={destinationPath(organisation.slug, "projects")}>
					{terms.Projects}
				</Link>
			</p>
			<PageHeading>{TITLE}</PageHeading>
			<PageLead>
				{t(
					`One CSV adds projects, their work packages and the people on each project's team. Its Kind column says what each row is: Project, Work package or Assignment. The columns are ${SETUP_FIELDS.map((field) => SETUP_FIELD_LABELS[field]).join(", ")}, in any order; rows find their project by its code, in this file or already here. An assignment's person must be a member or have an invitation waiting.`,
				)}
			</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			{preview && job ? (
				<Section
					id="dry-run"
					heading={`Dry run of ${job.fileName}`}
					lead="Nothing has been added yet. Check each row, then import, or discard the file and upload it again."
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
								{t(
									`${counted(preview.counts.projects, "project", "projects")}, ${counted(preview.counts.workPackages, "work package", "work packages")} and ${counted(preview.counts.assignments, "assignment", "assignments")} to add; ${preview.counts.skipped} ${preview.counts.skipped === 1 ? "row" : "rows"} not added.`,
								)}
							</p>
							{preview.counts.waiting > 0 && (
								<p className="mt-2 max-w-160 text-body-large">
									{`${counted(preview.counts.waiting, "assignment is", "assignments are")} for invited people, and ${preview.counts.waiting === 1 ? "waits" : "wait"} until each joins.`}
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
										preview.counts.projects +
											preview.counts.workPackages +
											preview.counts.assignments ===
											0
									}
								>
									Import
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

							{preview.counts.skipped > 0 && (
								<div className="mt-6 max-w-200">
									<Ledger heading="Not added" note={preview.counts.skipped}>
										<LedgerRows label="Rows not added">
											{preview.notAdded.map((row) => (
												<LedgerRow
													key={row.line}
													aside={`Line ${row.line}`}
													title={
														<span className="wrap-anywhere">
															{row.label ? `${t(row.kind)} · ${row.label}` : t(row.kind)}
														</span>
													}
													detail={t(row.problems)}
												/>
											))}
										</LedgerRows>
									</Ledger>
								</div>
							)}
							<Adding
								heading={t("Projects to add")}
								count={preview.counts.projects}
								rows={preview.projects}
							/>
							<Adding
								heading="Work packages to add"
								count={preview.counts.workPackages}
								rows={preview.workPackages}
							/>
							<Adding
								heading="Assignments to add"
								count={preview.counts.assignments}
								rows={preview.assignments}
							/>
						</>
					)}
				</Section>
			) : (
				<Section
					id="upload"
					heading={job ? `${job.fileName}: ${job.status}` : "Choose a file"}
					lead={
						job
							? `${counted(job.importedCount, "row", "rows")} added, ${job.skippedCount} not added.${
									job.status === "reverted"
										? " Reverted: everything it added has been taken away."
										: standing
											? ` ${counted(standing.onTeams, "assignment is", "assignments are")} on teams now; ${standing.waiting - standing.lapsed} still ${standing.waiting - standing.lapsed === 1 ? "waits" : "wait"} for invited people to join${standing.lapsed > 0 ? `, and ${standing.lapsed} never will: the invitation was cancelled or ran out` : ""}.`
											: ""
								}`
							: `It is read, not added: you see what each row would do first. At most ${SETUP_MAX_ROWS} rows.`
					}
				>
					{job && job.skipped.length > 0 && (
						<div className="mb-6 max-w-200">
							<Ledger heading="Not added" note={job.skippedCount}>
								<LedgerRows label="Rows not added">
									{job.skipped.map((row) => (
										<LedgerRow key={row.line} aside={`Line ${row.line}`} title={t(row.reason)} />
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
								Nothing set up from a file yet.
							</p>
						) : (
							<LedgerRows label="Earlier imports">
								{imports.map((each) => (
									<LedgerRow
										key={each.id}
										title={
											<Link
												className={ACTION_LINK}
												to={setupImportPath(organisation.slug, each.id)}
											>
												{each.fileName}
											</Link>
										}
										detail={`${each.status === "imported" ? `${counted(each.importedCount, "row", "rows")} added, ${each.skippedCount} not added` : each.status === "reverted" ? "Reverted" : "Dry run, nothing added"}. ${each.created}.`}
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
					{t(
						"The projects and work packages it added are deleted, with everything added to those projects since: their tasks, rates and team. Every assignment it made is taken off its team, and those still waiting for invited people are dropped. Invitations stay.",
					)}
				</p>
				<p className="mt-2">
					{t(
						"It cannot be reverted once time has been tracked to anything it added, or by a person in the stretch it put them on a team for, or once one of its projects has an expense, an invoice or a retainer: those records keep what they name. Nothing is reverted then, and the page says what is in the way.",
					)}
				</p>
			</FormSheet>
		</>
	);
}
