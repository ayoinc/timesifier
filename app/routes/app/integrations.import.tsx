import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { organisationScope } from "~/db";
import {
	discardImport,
	findImport,
	IMPORT_MAX_BYTES,
	listImports,
	previewImport,
	revertImport,
	runImport,
	setMapping,
	startImport,
} from "~/import/import.server";
import { FIELD_LABELS, FIELDS, type ImportKind } from "~/import/mapping";
import { importPath } from "~/integrations/paths";
import { codedName } from "~/lib/codes";
import { parseRequest } from "~/lib/validate";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { destinationPath } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { useSubmitting } from "~/shell/submitting";
import { formatDayAndTime, formatDayWithYear, formatDuration } from "~/time/format";
import { zoneOfMember } from "~/time/zones.server";
import { hasClients, inTerms, termsOf } from "~/workspace/work-model";

import type { Route } from "./+types/integrations.import";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Importing from a CSV (TS-076): time, clients or projects, below Integrations,
// so only owners and admins reach it, and so only they add projects through it
// (decision 42). A file is uploaded and previewed with the columns the Harvest
// preset chose; the columns can be chosen again; then it is imported, and a
// time import can be reverted. Nothing is written before "Import". Rows find
// their projects by code first (TS-115a); under Internal work the page says the
// organisation's term, and has no clients.

const KINDS = ["time", "clients", "projects"] as const;
const Kind = z.enum(KINDS);

const TITLES: Record<ImportKind, string> = {
	time: "Import time",
	clients: "Import clients",
	projects: "Import projects",
};

const LEADS: Record<ImportKind, string> = {
	time: "A CSV with Harvest's columns: Date, Client, Project, Task, Notes, Hours, First name and Last name, or an Email. Harvest's own export of all time is read as it is. Each row is matched to a member, and to a project by its code, in a Project code column or the Project column, else by name; missing clients, projects and tasks are added; nobody is.",
	clients:
		"A CSV with a Client column, and a Client code and a Currency if you like. Clients already here are skipped.",
	projects:
		"A CSV with Harvest's Client and Project columns, and a Project code if you like. Projects already here, by code or name, are skipped; missing clients are added.",
};

/** Under Internal work, the lead with no clients in it, in the organisation's term. */
const INTERNAL_LEADS: Record<ImportKind, string> = {
	time: "A CSV with Harvest's columns: Date, Project, Task, Notes, Hours, First name and Last name, or an Email. Harvest's own export of all time is read as it is. Each row is matched to a member, and to a project by its code, in a Project code column or the Project column, else by name; missing projects and tasks are added; nobody is.",
	clients: LEADS.clients,
	projects:
		"A CSV with a Project column, and a Project code if you like. Projects already here, by code or name, are skipped.",
};

/** The most rows of each list the preview shows; the counts say how many there are. */
const SHOWN_ROWS = 100;

export function meta({ loaderData }: Route.MetaArgs) {
	return [{ title: `${loaderData?.title ?? TITLES.time} · Timesifier` }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const search = new URL(request.url).searchParams;
	const kind = Kind.safeParse(search.get("kind") ?? "time");
	if (!kind.success) throw notFound();
	// Under Internal work there are no clients to import (TS-115a).
	const { workModel, internalTerm } = membership.organisation;
	if (kind.data === "clients" && !hasClients(workModel)) throw notFound();
	const terms = termsOf(workModel, internalTerm);
	const zone = await zoneOfMember(membership);
	const id = search.get("import");
	const job = id ? await findImport(scope, id) : null;
	if (id && (!job || job.kind !== kind.data)) throw notFound();
	const preview = job?.status === "previewed" ? await previewImport(scope, job) : null;
	const imports = await listImports(scope, kind.data);
	return {
		kind: kind.data,
		title: inTerms(TITLES[kind.data], terms),
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
		preview: preview
			? {
					...preview,
					toImport:
						preview.kind === "time"
							? // A row cut at its day's limit is two entries of one line (decision 54).
								new Set(preview.rows.map((row) => row.line)).size
							: preview.records.length,
					rows: preview.rows.slice(0, SHOWN_ROWS),
					records: preview.records.slice(0, SHOWN_ROWS),
					skippedCount: preview.skipped.length,
					skipped: preview.skipped.slice(0, SHOWN_ROWS),
				}
			: null,
		imports: imports.map((each) => ({ ...each, created: formatDayAndTime(each.createdAt, zone) })),
	};
}

const Id = z.string().min(1).max(64);

const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("upload"), kind: Kind, file: z.instanceof(File) }),
	z.object({ intent: z.literal("map"), importId: Id }).catchall(z.string().max(4)),
	z.object({ intent: z.literal("import"), importId: Id }),
	z.object({ intent: z.literal("discard"), importId: Id }),
	z.object({ intent: z.literal("revert"), importId: Id }),
]);

export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form, { maxBytes: IMPORT_MAX_BYTES + 16 * 1024 });
	const { organisation, user } = context.get(membershipContext);
	const scope = organisationScope(env.DB, organisation.id);
	switch (input.intent) {
		case "upload": {
			if (input.file.size === 0) return declined("Choose a CSV file.");
			if (input.file.size > IMPORT_MAX_BYTES) return declined("A file is at most 1 MB. Split it.");
			if (input.kind === "clients" && !hasClients(organisation.workModel)) throw notFound();
			const started = await startImport(
				scope,
				user.id,
				input.kind,
				input.file.name || "import.csv",
				await input.file.text(),
			);
			if (!started.ok) return declined(started.problem);
			return redirect(importPath(organisation.slug, input.kind, started.id));
		}
		case "map": {
			const job = await findImport(scope, input.importId);
			if (!job) throw notFound();
			const fields = FIELDS[job.kind as ImportKind] ?? [];
			const mapping: Record<string, number> = {};
			for (const field of fields) {
				const column = (input as Record<string, string>)[`column-${field}`];
				if (column !== undefined && /^\d{1,3}$/.test(column)) mapping[field] = Number(column);
			}
			if (!(await setMapping(scope, job.id, mapping))) {
				return declined("This import is no longer waiting to be imported.", 409);
			}
			return done("Columns chosen. The preview below reads them.");
		}
		case "import": {
			const job = await findImport(scope, input.importId);
			if (!job) throw notFound();
			const imported = await runImport(scope, user.id, job.id, Date.now());
			if (!imported.ok) return declined(imported.problem, 409);
			return redirect(importPath(organisation.slug, job.kind as ImportKind, job.id));
		}
		case "discard": {
			const job = await findImport(scope, input.importId);
			if (!job) throw notFound();
			await discardImport(scope, job.id);
			return redirect(importPath(organisation.slug, job.kind as ImportKind));
		}
		case "revert": {
			const reverted = await revertImport(scope, user.id, input.importId, Date.now());
			if (!reverted.ok) {
				return declined(
					reverted.locked.length > 0
						? `${reverted.problem} ${reverted.locked.join("; ")}.`
						: reverted.problem,
					409,
				);
			}
			return done(
				`Import reverted: ${reverted.deleted} ${reverted.deleted === 1 ? "entry" : "entries"} deleted.`,
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

export default function Import({ loaderData, actionData }: Route.ComponentProps) {
	const { kind, title, job, preview, imports } = loaderData;
	const organisation = useOrganisation();
	const { terms } = organisation;
	const clients = hasClients(terms.model);
	/** A sentence in the organisation's terms (TS-115a). */
	const say = (text: string) => inTerms(text, terms);
	const submitting = useSubmitting();
	const [said, setSaid] = useState<string | null>(null);
	const [reverting, setReverting] = useState<(typeof imports)[number] | null>(null);
	const refusal =
		actionData && "ok" in actionData && !actionData.ok ? actionData.problem : undefined;
	const told = actionData && "ok" in actionData && actionData.ok ? actionData.said : null;

	return (
		<>
			<p className="text-body-medium">
				<Link className={ACTION_LINK} to={destinationPath(organisation.slug, "integrations")}>
					Integrations
				</Link>
			</p>
			<PageHeading>{title}</PageHeading>
			<PageLead>{say(clients ? LEADS[kind] : INTERNAL_LEADS[kind])}</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said ?? told}
			</p>

			{preview && job ? (
				<Section
					id="preview"
					heading={`Preview of ${job.fileName}`}
					lead="Nothing has been written yet. Check the rows, choose other columns if one is wrong, then import."
				>
					<Form method="post" className="flex max-w-200 flex-col gap-4">
						<input type="hidden" name="importId" value={job.id} />
						<div className="grid gap-4 @sm:grid-cols-2">
							{FIELDS[kind]
								.filter((field) => clients || (field !== "client" && field !== "client_code"))
								.map((field) => (
									<Select
										key={`${field}-${preview.mapping[field] ?? ""}`}
										label={say(FIELD_LABELS[field] ?? field)}
										name={`column-${field}`}
										defaultValue={String(preview.mapping[field] ?? "none")}
										options={[
											{ id: "none", label: "Not in this file" },
											...preview.headers.map((header, index) => ({
												id: String(index),
												label: header || `Column ${index + 1}`,
											})),
										]}
									/>
								))}
						</div>
						<div className="flex flex-wrap gap-2">
							<Button
								type="submit"
								name="intent"
								value="map"
								variant="outlined"
								{...submitting("intent", "map")}
							>
								Read these columns
							</Button>
						</div>
					</Form>

					{preview.missing.length > 0 ? (
						<p className="mt-6 max-w-160 text-body-large">
							Choose a column for {say(preview.missing.join(", "))} before anything can be imported.
						</p>
					) : (
						<>
							<p className="mt-6 text-title-medium">
								{preview.toImport} to import, {preview.skippedCount} to skip.
							</p>
							{preview.creates.clients.length +
								preview.creates.projects.length +
								preview.creates.tasks.length >
								0 && (
								<p className="mt-2 max-w-160 text-body-medium text-on-surface-variant">
									It adds{" "}
									{[
										preview.creates.clients.length > 0 &&
											`clients ${preview.creates.clients.join(", ")}`,
										preview.creates.projects.length > 0 &&
											say(`projects ${preview.creates.projects.join(", ")}`),
										preview.creates.tasks.length > 0 && `tasks ${preview.creates.tasks.join(", ")}`,
									]
										.filter(Boolean)
										.join("; ")}
									.
								</p>
							)}
							{preview.unmatched.length > 0 && (
								<div className="mt-4 max-w-160">
									<h3 className="text-title-medium">People who are not members</h3>
									<p className="text-body-medium text-on-surface-variant">
										Nothing of theirs is imported. Invite them on Team, or correct the file.
									</p>
									<ul className="mt-2 list-disc pl-6 text-body-large">
										{preview.unmatched.map((each) => (
											<li key={each.person}>
												{each.person}: {each.lines.length === 1 ? "line" : "lines"}{" "}
												{each.lines.join(", ")}
											</li>
										))}
									</ul>
								</div>
							)}
							<Form method="post" className="mt-6 flex flex-wrap gap-2">
								<input type="hidden" name="importId" value={job.id} />
								<Button
									type="submit"
									name="intent"
									value="import"
									isPending={submitting("intent", "import").isPending}
									isDisabled={submitting("intent", "import").isDisabled || preview.toImport === 0}
								>
									{say(
										`Import ${preview.toImport} ${kind === "time" ? (preview.toImport === 1 ? "entry" : "entries") : kind === "clients" ? (preview.toImport === 1 ? "client" : "clients") : preview.toImport === 1 ? "project" : "projects"}`,
									)}
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

							<div className="mt-6 max-w-200">
								<Ledger heading="To import" note={preview.toImport}>
									{kind === "time" ? (
										<LedgerRows label="Rows to import">
											{preview.rows.map((row) => (
												<LedgerRow
													key={row.line}
													aside={`Line ${row.line}`}
													title={
														<span className="wrap-anywhere">
															{row.person} · {codedName(row.projectCode, row.project)}
															{row.task ? ` · ${row.task}` : ""}
														</span>
													}
													detail={
														<span className="wrap-anywhere">
															{formatDayWithYear(row.day)}
															{row.client ? ` · ${codedName(row.clientCode, row.client)}` : ""}
															{row.notes ? ` · ${row.notes}` : ""}
														</span>
													}
													value={`${formatDuration(row.minutes * 60)}${row.overtime ? " overtime" : ""}`}
												/>
											))}
										</LedgerRows>
									) : (
										<LedgerRows label="Rows to import">
											{preview.records.map((row) => (
												<LedgerRow
													key={row.line}
													aside={`Line ${row.line}`}
													title={
														<span className="wrap-anywhere">{codedName(row.code, row.name)}</span>
													}
													detail={row.client ? codedName(row.clientCode, row.client) : undefined}
												/>
											))}
										</LedgerRows>
									)}
								</Ledger>
							</div>
							{preview.skippedCount > 0 && (
								<div className="mt-6 max-w-200">
									<Ledger heading="To skip" note={preview.skippedCount}>
										<LedgerRows label="Rows to skip">
											{preview.skipped.map((row) => (
												<LedgerRow
													key={row.line}
													aside={`Line ${row.line}`}
													title={say(row.reason)}
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
						job
							? `${job.importedCount} imported, ${job.skippedCount} skipped.`
							: "It is read, not written: you see a preview first."
					}
				>
					{job && job.skipped.length > 0 && (
						<div className="mb-6 max-w-200">
							<Ledger heading="Skipped" note={job.skippedCount}>
								<LedgerRows label="Skipped rows">
									{job.skipped.map((row) => (
										<LedgerRow key={row.line} aside={`Line ${row.line}`} title={say(row.reason)} />
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
						<input type="hidden" name="kind" value={kind} />
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
								Upload and preview
							</Button>
						</div>
					</Form>
					<Problem said={refusal} />
				</Section>
			)}

			<Section id="imports" heading="Earlier imports">
				<div className="max-w-200">
					<Ledger heading={title} note={imports.length}>
						{imports.length === 0 ? (
							<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
								Nothing imported yet.
							</p>
						) : (
							<LedgerRows label="Earlier imports">
								{imports.map((each) => (
									<LedgerRow
										key={each.id}
										title={
											<Link
												className={ACTION_LINK}
												to={importPath(organisation.slug, kind, each.id)}
											>
												{each.fileName}
											</Link>
										}
										detail={`${each.status === "imported" ? `${each.importedCount} imported, ${each.skippedCount} skipped` : each.status === "reverted" ? "Reverted" : "Previewed, not imported"}. By ${each.madeBy}, ${each.created}.`}
										action={
											kind === "time" && each.status === "imported" ? (
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
					Its {reverting?.importedCount ?? 0} entries are deleted, and nothing else. If one is
					locked, nothing is deleted and the locked ones are named.
				</p>
			</FormSheet>
		</>
	);
}
