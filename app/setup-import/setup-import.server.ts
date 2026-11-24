import { env } from "cloudflare:workers";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { ActivityAction } from "~/activity/actions";
import { changes, recordStatement, recordStatementWhen } from "~/activity/activity.server";
import {
	type ActivitySummary,
	among,
	type OrganisationScope,
	organisationScope,
	organisations,
	type ScopedStatement,
	users,
	uuidv7,
} from "~/db";
import { codedName, codeKey, isCodeClash } from "~/lib/codes";
import { isNameClash, nameKey } from "~/lib/names";
import { projectCodeRules } from "~/projects/projects.server";
import { overlaps, type Stretch, TEAM_ROLES, type TeamRole } from "~/projects/teams";
import { dayOf } from "~/time/calendar";
import { WorkModel } from "~/workspace/work-model";

import {
	type AssignmentPlan,
	countsOf,
	decideSetup,
	type PackagePlan,
	type ProjectPlan,
	readSetupFile,
	type SetupCounts,
	type SetupField,
	type SetupKnown,
	type SetupOutcome,
	stretchKey,
} from "./setup";

// The set-up import (TS-115d, docs/decisions.md entry 77): reading the
// organisation, writing an import in one batch, reverting it, and applying
// the assignments of invited people when they join.
//
// An import is a dry run first: the file is kept while each row's outcome is
// shown. Importing decides every row again against the organisation as it is
// then, and writes everything in one D1 batch, or nothing: the import marked
// imported first, then the projects, the work packages, the assignments, the
// assignments waiting for invited people, and the activity records, each table
// as one `insertMany` statement whose rows go to D1 as one JSON value
// (decision 40), so a statement binds a handful of parameters however many
// rows it adds. Projects come before the work packages that name them, and
// those before the assignments, within the batch.

/** What the organisation has, as rows are decided against it. */
export async function setupKnownOf(scope: OrganisationScope, now: Date): Promise<SetupKnown> {
	const [[organisation], rules, clients, projects, packages, members, invited, stretches, waiting] =
		await Promise.all([
			drizzle(env.DB)
				.select({
					workModel: organisations.workModel,
					currency: organisations.currency,
					timeZone: organisations.timeZone,
				})
				.from(organisations)
				.where(eq(organisations.id, scope.organisationId))
				.limit(1),
			projectCodeRules(scope.organisationId),
			scope.clients.select(),
			scope.projects.select(),
			scope.workPackages.select(),
			drizzle(env.DB)
				.select({ userId: users.id, email: users.email })
				.from(users)
				.where(
					sql`${users.id} in (select user_id from memberships where organisation_id = ${scope.organisationId})`,
				),
			scope.invitations.select((i) => and(eq(i.status, "pending"), gt(i.expiresAt, now)), {
				orderBy: (i) => [i.createdAt],
			}),
			scope.projectMembers.select(),
			scope.invitationAssignments.select(),
		]);
	const model = WorkModel.safeParse(organisation?.workModel);
	const currency = organisation?.currency ?? "GBP";
	const clientCurrency = new Map(clients.map((c) => [c.id, c.currency]));
	const byTeam = new Map<string, Stretch[]>();
	const add = (key: string, stretch: Stretch) =>
		byTeam.set(key, [...(byTeam.get(key) ?? []), stretch]);
	for (const m of stretches) {
		add(stretchKey(m.projectId, { userId: m.userId }), { startsOn: m.startsOn, endsOn: m.endsOn });
	}
	for (const w of waiting) {
		add(stretchKey(w.projectId, { invitationId: w.invitationId }), {
			startsOn: w.startsOn,
			endsOn: w.endsOn,
		});
	}
	const packageCodes = new Map<string, Set<string>>();
	for (const wp of packages) {
		packageCodes.set(wp.projectId, (packageCodes.get(wp.projectId) ?? new Set()).add(wp.codeKey));
	}
	return {
		workModel: model.success ? model.data : "client_projects",
		workCode: rules.workCode,
		currency,
		today: dayOf(now.getTime(), organisation?.timeZone ?? "UTC"),
		clients: new Map(
			clients.flatMap((c) =>
				c.code && c.codeKey
					? [
							[
								c.codeKey,
								{ id: c.id, code: c.code, archived: c.archivedAt !== null, currency: c.currency },
							],
						]
					: [],
			),
		),
		projects: new Map(
			projects.flatMap((p) =>
				p.code && p.codeKey
					? [
							[
								p.codeKey,
								{
									id: p.id,
									code: p.code,
									name: p.name,
									archived: p.archivedAt !== null,
									currency:
										p.currency ?? (p.clientId ? clientCurrency.get(p.clientId) : null) ?? currency,
									billable: p.billingType !== "non_billable",
								},
							],
						]
					: [],
			),
		),
		projectNames: new Set(projects.map((p) => p.nameKey)),
		workPackages: packageCodes,
		members: new Map(members.map((m) => [m.email.toLowerCase(), m.userId])),
		// The newest invitation to an address, as the one its person will accept.
		invited: new Map(invited.map((i) => [i.email.toLowerCase(), i.id])),
		stretches: byTeam,
	};
}

export type Started = { ok: true; id: string } | { ok: false; problem: string };

/** Keeps an uploaded set-up file to be previewed, or says why it cannot be read. */
export async function startSetupImport(
	scope: OrganisationScope,
	actorId: string,
	fileName: string,
	text: string,
): Promise<Started> {
	const read = readSetupFile(text);
	if (!read.ok) return read;
	const id = uuidv7();
	await scope.setupImports.insert({
		id,
		status: "previewed",
		fileName: fileName.slice(0, 200),
		rowCount: read.rows.length,
		createdBy: actorId,
		source: text,
		mapping: {},
	});
	return { ok: true, id };
}

/** A set-up import's dry run: each row's outcome, and the columns read and not. */
export interface SetupPreview {
	outcomes: SetupOutcome[];
	read: SetupField[];
	unknown: string[];
	counts: SetupCounts;
}

/** Reads a previewed set-up import again, against the organisation as it is now. */
export async function previewSetupImport(
	scope: OrganisationScope,
	source: string,
	now: Date,
): Promise<SetupPreview | { problem: string }> {
	const read = readSetupFile(source);
	if (!read.ok) return { problem: read.problem };
	const outcomes = decideSetup(read.rows, await setupKnownOf(scope, now));
	return { outcomes, read: read.read, unknown: read.unknown, counts: countsOf(outcomes) };
}

/** The set-up import `id`, or null. */
export async function findSetupImport(scope: OrganisationScope, id: string) {
	const [job] = await scope.setupImports.select((j) => eq(j.id, id), { limit: 1 });
	return job ?? null;
}

/** The organisation's set-up imports, newest first. */
export function setupImports(scope: OrganisationScope) {
	return scope.setupImports.select(undefined, {
		orderBy: (j) => [desc(j.createdAt)],
		limit: 50,
	});
}

/** Drops a set-up import still a dry run, and the file it kept. */
export async function discardSetupImport(scope: OrganisationScope, id: string) {
	const [dropped] = await scope.setupImports.delete((j) =>
		and(eq(j.id, id), eq(j.status, "previewed")),
	);
	return dropped !== undefined;
}

/** Whether a write failed on the trigger that keeps one person's stretches on a team apart. */
function isOverlap(error: unknown): boolean {
	for (let at: unknown = error; at instanceof Error; at = at.cause) {
		if (/never overlap/.test(at.message)) return true;
	}
	return false;
}

/** The fields an assignment's activity record keeps, as `assignToTeam` records them. */
const ASSIGNMENT_FIELDS = ["userId", "role", "startsOn", "endsOn"] as const;

export type Imported = { ok: true; counts: SetupCounts } | { ok: false; problem: string };

/** What a person is told when the organisation changed between the check and the write. */
const CHANGED_MEANWHILE =
	"Something this file adds was added by someone else while it was importing, so nothing was imported. Look at the dry run again.";

/**
 * Imports set-up import `id`: every row that can be added, in one batch, and
 * marks it imported with the rows it skipped and why. A row that cannot be
 * added is skipped, as the dry run showed; none is half-added.
 */
export async function runSetupImport(
	scope: OrganisationScope,
	actorId: string,
	id: string,
	now: Date,
): Promise<Imported> {
	const job = await findSetupImport(scope, id);
	if (job?.status !== "previewed" || job.source === null) {
		return { ok: false, problem: "This import is no longer waiting to be imported." };
	}
	const preview = await previewSetupImport(scope, job.source, now);
	if ("problem" in preview) return { ok: false, problem: preview.problem };
	const { outcomes, counts } = preview;
	if (outcomes.every((o) => !o.ok))
		return { ok: false, problem: "No row of this file can be imported." };

	const plans = <K extends "project" | "work_package" | "assignment">(kind: K) =>
		outcomes.flatMap((o) => (o.ok && o.kind === kind ? [o] : [])) as Extract<
			SetupOutcome,
			{ ok: true; kind: K }
		>[];
	const projects = plans("project").map(({ plan }) => ({ id: uuidv7(), plan }));
	const newProject = new Map(projects.map((p) => [codeKey(p.plan.code), p.id]));
	const projectIdOf = ({ project }: PackagePlan | AssignmentPlan) =>
		project.existing ? project.id : (newProject.get(codeKey(project.code)) as string);
	const packages = plans("work_package").map(({ plan }) => ({
		id: uuidv7(),
		projectId: projectIdOf(plan),
		plan,
	}));
	const assignments = plans("assignment").map(({ plan }) => ({
		id: uuidv7(),
		projectId: projectIdOf(plan),
		plan,
	}));
	const members = assignments.flatMap((a) =>
		"userId" in a.plan.who ? [{ ...a, userId: a.plan.who.userId }] : [],
	);
	const waiting = assignments.flatMap((a) =>
		"invitationId" in a.plan.who ? [{ ...a, invitationId: a.plan.who.invitationId }] : [],
	);
	const skipped = outcomes.flatMap((o) =>
		o.ok ? [] : [{ line: o.line, reason: o.problems.join(" ") }],
	);

	// Everything after the first statement is written only if it marked the import.
	const marked = scope.setupImports.exists((j) =>
		and(eq(j.id, id), eq(j.status, "imported"), eq(j.importedAt, now)),
	);
	const statements: [ScopedStatement<unknown>, ...ScopedStatement<unknown>[]] = [
		scope.setupImports.statements.update(
			{
				status: "imported",
				importedAt: now,
				importedCount: projects.length + packages.length + assignments.length,
				skippedCount: skipped.length,
				skipped,
				created: {
					projects: projects.map((p) => p.id),
					workPackages: packages.map((p) => p.id),
				},
				source: null,
			},
			(j) => and(eq(j.id, id), eq(j.status, "previewed")),
		),
	];
	if (projects.length > 0) {
		statements.push(
			scope.projects.statements.insertMany(
				projects.map(({ id: projectId, plan }) => projectRow(projectId, plan, now)),
				marked,
			),
		);
	}
	if (packages.length > 0) {
		statements.push(
			scope.workPackages.statements.insertMany(
				packages.map(({ id: packageId, projectId, plan }) => ({
					id: packageId,
					projectId,
					code: plan.code,
					codeKey: codeKey(plan.code),
					name: plan.name,
					startsOn: plan.startsOn,
					endsOn: plan.endsOn,
					state: "open",
					budgetKind: plan.budget.kind,
					budgetAmount: plan.budget.amount,
					billable: plan.billable,
					createdAt: now,
					updatedAt: now,
				})),
				marked,
			),
		);
	}
	if (members.length > 0) {
		statements.push(
			scope.projectMembers.statements.insertMany(
				members.map(({ id: memberId, projectId, userId, plan }) => ({
					id: memberId,
					projectId,
					userId,
					role: plan.role,
					startsOn: plan.startsOn,
					endsOn: plan.endsOn,
					sourceKind: "import",
					sourceId: id,
					createdBy: actorId,
					createdAt: now,
					updatedAt: now,
				})),
				marked,
			),
		);
	}
	if (waiting.length > 0) {
		statements.push(
			scope.invitationAssignments.statements.insertMany(
				waiting.map(({ id: waitingId, projectId, invitationId, plan }) => ({
					id: waitingId,
					invitationId,
					projectId,
					role: plan.role,
					startsOn: plan.startsOn,
					endsOn: plan.endsOn,
					setupImportId: id,
					createdBy: actorId,
					createdAt: now,
				})),
				marked,
			),
		);
	}
	const records: {
		action: ActivityAction;
		subjectType: "project" | "work_package" | "import";
		subjectId: string;
		summary: ActivitySummary;
	}[] = [
		...projects.map(({ id: projectId, plan }) => ({
			action: "project.created" as const,
			subjectType: "project" as const,
			subjectId: projectId,
			summary: changes(
				null,
				{ name: plan.name, clientId: plan.client?.id ?? null, code: plan.code },
				["name", "clientId", "code"],
			),
		})),
		...packages.map(({ id: packageId, projectId, plan }) => ({
			action: "work_package.created" as const,
			subjectType: "work_package" as const,
			subjectId: packageId,
			summary: { after: { projectId, code: plan.code, name: plan.name } },
		})),
		...members.map(({ projectId, userId, plan }) => ({
			action: "project.member_added" as const,
			subjectType: "project" as const,
			subjectId: projectId,
			summary: changes(
				null,
				{ userId, role: plan.role, startsOn: plan.startsOn, endsOn: plan.endsOn },
				ASSIGNMENT_FIELDS,
			),
		})),
		{
			action: "import.imported",
			subjectType: "import",
			subjectId: id,
			summary: {
				after: {
					kind: "setup",
					projects: counts.projects,
					workPackages: counts.workPackages,
					assignments: counts.assignments - counts.waiting,
					waiting: counts.waiting,
					skipped: counts.skipped,
				},
			},
		},
	];
	statements.push(
		scope.activityRecords.statements.insertMany(
			records.map((r) => ({ ...r, actorId, source: "import", ownerId: null, createdAt: now })),
			marked,
		),
	);
	try {
		const [[updated]] = await scope.batch(statements);
		if (!updated) return { ok: false, problem: "This import is no longer waiting to be imported." };
	} catch (error) {
		if (isCodeClash(error) || isNameClash(error) || isOverlap(error) || isPackageClash(error)) {
			return { ok: false, problem: CHANGED_MEANWHILE };
		}
		throw error;
	}
	return { ok: true, counts };
}

/** Whether a write failed on the unique index of a project's work package codes. */
function isPackageClash(error: unknown): boolean {
	for (let at: unknown = error; at instanceof Error; at = at.cause) {
		if (
			/UNIQUE constraint failed: work_packages\.project_id, work_packages\.code_key/.test(
				at.message,
			)
		)
			return true;
	}
	return false;
}

function projectRow(id: string, plan: ProjectPlan, now: Date) {
	return {
		id,
		name: plan.name,
		nameKey: nameKey(plan.name),
		clientId: plan.client?.id ?? null,
		code: plan.code,
		codeKey: codeKey(plan.code),
		billingType: plan.billing,
		startsOn: plan.startsOn,
		endsOn: plan.endsOn,
		createdAt: now,
		updatedAt: now,
	};
}

/** Where a finished import's assignments for invited people stand. */
export interface SetupStanding {
	/** Assignments for invited people still waiting for them to join. */
	waiting: number;
	/** Of those, the ones whose invitation was cancelled or ran out: they will never apply. */
	lapsed: number;
	/** Assignments the import put on teams, at the import or when a person joined. */
	onTeams: number;
}

/** How a finished set-up import's assignments stand now. */
export async function setupStandingOf(
	scope: OrganisationScope,
	id: string,
	now: Date,
): Promise<SetupStanding> {
	const [rows, onTeams] = await Promise.all([
		drizzle(env.DB).all<{ live: number }>(sql`
			select (i.status = 'pending' and i.expires_at > ${now.getTime()}) as live
			from invitation_assignments a join invitations i on i.id = a.invitation_id
			where a.organisation_id = ${scope.organisationId} and a.setup_import_id = ${id}`),
		scope.projectMembers.select((m) => and(eq(m.sourceKind, "import"), eq(m.sourceId, id))),
	]);
	return {
		waiting: rows.length,
		lapsed: rows.filter((r) => !r.live).length,
		onTeams: onTeams.length,
	};
}

export type Reverted =
	| {
			ok: true;
			projects: number;
			workPackages: number;
			assignments: number;
			waiting: number;
	  }
	| { ok: false; problem: string };

/** At most this many things are named in a refusal; the rest are counted. */
const NAMED = 3;

function listed(names: readonly string[]): string {
	const shown = names.slice(0, NAMED);
	const more = names.length - shown.length;
	const head =
		shown.length <= 1
			? (shown[0] ?? "")
			: `${shown.slice(0, -1).join(", ")}${more > 0 ? ", " : " and "}${shown.at(-1)}`;
	return more > 0 ? `${head} and ${more} more` : head;
}

/**
 * Reverts set-up import `id`: the projects and work packages it added, and
 * every assignment it made, at the import or when an invited person joined,
 * are deleted, with the assignments still waiting for people to join. A
 * project goes with everything that hangs from it, so anything added to an
 * imported project by hand since goes too, as the page says before the button.
 *
 * Refused whole while anything it made has time on it: time tracked to one of
 * its projects or work packages, or by a person on one of its teams in the
 * stretch it gave them; or while one of its projects has an expense, an
 * invoice line or a retainer. Those are records of work done, which a revert
 * must not take away, and the project they name cannot go without them.
 */
export async function revertSetupImport(
	scope: OrganisationScope,
	actorId: string,
	id: string,
	now: Date,
): Promise<Reverted> {
	const job = await findSetupImport(scope, id);
	if (job?.status !== "imported") {
		return { ok: false, problem: "Only a set-up import that was imported can be reverted." };
	}
	const created = job.created ?? { projects: [], workPackages: [] };
	const db = drizzle(env.DB);
	const org = scope.organisationId;
	const projectIds = JSON.stringify(created.projects);
	const packageIds = JSON.stringify(created.workPackages);
	const [projects, packages, members, waiting, tracked, money] = await Promise.all([
		scope.projects.select((p) => among(p.id, created.projects)),
		scope.workPackages.select((w) => among(w.id, created.workPackages)),
		scope.projectMembers.select((m) => and(eq(m.sourceKind, "import"), eq(m.sourceId, id))),
		scope.invitationAssignments.select((a) => eq(a.setupImportId, id)),
		// Time on what it made: its projects, its work packages, and each person in
		// the stretch it put them on a team of a project it did not add, named
		// "ada@example.com on ACME-001 · Website".
		db.all<{ kind: string; ref: string }>(sql`
			select distinct 'project' as kind, e.project_id as ref from time_entries e
			where e.organisation_id = ${org} and e.project_id in (select value from json_each(${projectIds}))
			union
			select distinct 'package', e.work_package_id from time_entries e
			where e.organisation_id = ${org} and e.work_package_id in (select value from json_each(${packageIds}))
			union
			select distinct 'member', u.email || ' on ' || coalesce(p.code || ' · ', '') || p.name
			from project_members m
			join users u on u.id = m.user_id
			join projects p on p.id = m.project_id
			join time_entries e on e.organisation_id = m.organisation_id and e.project_id = m.project_id
				and e.user_id = m.user_id and e.spent_on >= m.starts_on
				and (m.ends_on is null or e.spent_on <= m.ends_on)
			where m.organisation_id = ${org} and m.source_kind = 'import' and m.source_id = ${id}
				and m.project_id not in (select value from json_each(${projectIds}))`),
		db.all<{ ref: string }>(sql`
			select project_id as ref from expenses
			where organisation_id = ${org} and project_id in (select value from json_each(${projectIds}))
			union select project_id from invoice_lines
			where organisation_id = ${org} and project_id in (select value from json_each(${projectIds}))
			union select project_id from retainers
			where organisation_id = ${org} and project_id in (select value from json_each(${projectIds}))`),
	]);
	const projectName = new Map(projects.map((p) => [p.id, codedName(p.code, p.name)]));
	const packageName = new Map(packages.map((w) => [w.id, `work package ${w.code}`]));
	// Time on a project it added is named once, with the project.
	const timed = [
		...new Set(
			tracked.map((t) =>
				t.kind === "project"
					? (projectName.get(t.ref) ?? "a project")
					: t.kind === "package"
						? (packageName.get(t.ref) ?? "a work package")
						: t.ref,
			),
		),
	];
	const paid = [...new Set(money.map((m) => projectName.get(m.ref) ?? "a project"))];
	if (timed.length > 0 || paid.length > 0) {
		return {
			ok: false,
			problem: [
				timed.length > 0 && `Time has been tracked to ${listed(timed)}, which this import added.`,
				paid.length > 0 &&
					`${listed(paid)} ${paid.length === 1 ? "has" : "have"} expenses, invoices or a retainer.`,
				"Nothing was reverted: time and money keep what they were recorded against. Change or remove what the import added by hand instead.",
			]
				.filter(Boolean)
				.join(" "),
		};
	}

	const reverted = scope.setupImports.exists((j) =>
		and(eq(j.id, id), eq(j.status, "reverted"), eq(j.revertedAt, now)),
	);
	// Assignments on projects that stay are recorded as taken off, as one by hand is.
	const staying = members.filter((m) => !projectName.has(m.projectId));
	const statements: [ScopedStatement<unknown>, ...ScopedStatement<unknown>[]] = [
		scope.setupImports.statements.update({ status: "reverted", revertedAt: now }, (j) =>
			and(eq(j.id, id), eq(j.status, "imported")),
		),
		scope.invitationAssignments.statements.delete((a) => and(eq(a.setupImportId, id), reverted)),
		scope.projectMembers.statements.delete((m) =>
			and(eq(m.sourceKind, "import"), eq(m.sourceId, id), reverted),
		),
	];
	if (created.workPackages.length > 0) {
		statements.push(
			scope.workPackages.statements.delete((w) => and(among(w.id, created.workPackages), reverted)),
		);
	}
	if (created.projects.length > 0) {
		statements.push(
			scope.projects.statements.delete((p) => and(among(p.id, created.projects), reverted)),
		);
	}
	if (staying.length > 0) {
		statements.push(
			scope.activityRecords.statements.insertMany(
				staying.map((m) => ({
					actorId,
					source: "import",
					action: "project.member_removed",
					subjectType: "project",
					subjectId: m.projectId,
					ownerId: null,
					summary: changes(m, null, ASSIGNMENT_FIELDS),
				})),
				reverted,
			),
		);
	}
	statements.push(
		recordStatementWhen(
			scope,
			reverted,
			actorId,
			"import.reverted",
			{ type: "import", id },
			{
				before: {
					kind: "setup",
					projects: projects.length,
					workPackages: packages.length,
					assignments: members.length,
					waiting: waiting.length,
				},
			},
			"import",
		),
	);
	try {
		const [[updated]] = await scope.batch(statements);
		if (!updated)
			return { ok: false, problem: "Only a set-up import that was imported can be reverted." };
	} catch (error) {
		// Time, an expense or an invoice line reached what it made after the check above.
		if (/FOREIGN KEY constraint failed/.test(`${error} ${(error as Error).cause ?? ""}`)) {
			return {
				ok: false,
				problem:
					"Time or money was recorded against what this import added while it was reverting, so nothing was reverted.",
			};
		}
		throw error;
	}
	return {
		ok: true,
		projects: projects.length,
		workPackages: packages.length,
		assignments: members.length,
		waiting: waiting.length,
	};
}

// ── Accepting ────────────────────────────────────────────────────────────────

/** Why an assignment waiting for a person was not made when they joined. */
const NOT_APPLIED = {
	archived: "Its project was archived before they joined.",
	overlaps: "They were already on the project's team on some of those days when they joined.",
	failed: "It could not be added when they joined.",
} as const;

/**
 * Puts the person who accepted invitation `invitationId` on the project teams
 * a set-up import named them to while they were invited (decision 77). Each
 * waiting assignment is taken once, and becomes the person's stretch on the
 * team, recorded as made by whoever imported it. One whose project is
 * archived, or that now overlaps a stretch they were given by hand meanwhile,
 * is skipped and recorded with why. Joining never fails because of one.
 *
 * Assignments that waited on another invitation to the same address, one
 * cancelled or run out, never apply: they are dropped now the person is in.
 */
export async function applyWaitingAssignments(
	organisationId: string,
	invitationId: string,
	user: { id: string; email: string },
): Promise<void> {
	const scope = organisationScope(env.DB, organisationId);
	const [taken] = await scope.batch([
		scope.invitationAssignments.statements.delete((a) => eq(a.invitationId, invitationId)),
		scope.invitationAssignments.statements.delete(
			(a) =>
				sql`${a.invitationId} in (select id from invitations where organisation_id = ${organisationId} and lower(email) = ${user.email.toLowerCase()} and id <> ${invitationId})`,
		),
	]);
	for (const waiting of taken) {
		const actor = waiting.createdBy ?? user.id;
		const role: TeamRole = TEAM_ROLES.includes(waiting.role as TeamRole)
			? (waiting.role as TeamRole)
			: "member";
		const row = {
			projectId: waiting.projectId,
			userId: user.id,
			role,
			startsOn: waiting.startsOn,
			endsOn: waiting.endsOn,
		};
		const subject = { type: "project", id: waiting.projectId } as const;
		const skip = (reason: keyof typeof NOT_APPLIED) =>
			scope.batch([
				recordStatement(
					scope,
					actor,
					"project.member_skipped",
					subject,
					{
						after: { ...changes(null, row, ASSIGNMENT_FIELDS).after, reason: NOT_APPLIED[reason] },
					},
					"import",
				),
			]);
		try {
			const [[project], stretches] = await Promise.all([
				scope.projects.select((p) => eq(p.id, waiting.projectId), { limit: 1 }),
				scope.projectMembers.select((m) =>
					and(eq(m.projectId, waiting.projectId), eq(m.userId, user.id)),
				),
			]);
			if (!project || project.archivedAt !== null) {
				await skip("archived");
				continue;
			}
			if (stretches.some((s) => overlaps(s, row))) {
				await skip("overlaps");
				continue;
			}
			await scope.batch([
				scope.projectMembers.statements.insert({
					...row,
					sourceKind: "import",
					sourceId: waiting.setupImportId,
					createdBy: waiting.createdBy,
				}),
				recordStatement(
					scope,
					actor,
					"project.member_added",
					subject,
					changes(null, row, ASSIGNMENT_FIELDS),
					"import",
				),
			]);
		} catch (error) {
			if (isOverlap(error)) {
				await skip("overlaps");
				continue;
			}
			// Joining goes on: the assignment is recorded as not made, and the error kept in the log.
			console.error("A waiting assignment could not be applied", error);
			await skip("failed");
		}
	}
}
