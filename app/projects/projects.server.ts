import { env } from "cloudflare:workers";
import { and, asc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, record, recordStatement } from "~/activity/activity.server";
import { findActiveClient } from "~/clients/clients.server";
import { among, type OrganisationScope, organisations, uuidv7 } from "~/db";
import {
	CODE_PROBLEM,
	type CodeRules,
	codeKey,
	codeRuleFor,
	isCodeClash,
	parsePattern,
	patternCode,
	typedCode,
} from "~/lib/codes";
import { isNameClash, nameKey, RECORD_NAME_PROBLEM, recordName } from "~/lib/names";
import type { TimeScope } from "~/organisations/access";
import { DEFAULT_INTERNAL_TERM, hasWorkCodes, termsOf, WorkModel } from "~/workspace/work-model";

import { copyName } from "./projects";
import { nameHas } from "./search.server";

/**
 * The projects of one organisation, as more than one destination reads them:
 * the timer chooses from the active ones (TS-012a), Projects lists and keeps
 * them (TS-011a), reports name them (TS-014a). Every role sees and manages
 * every project. A project is archived, never deleted, so an entry always has
 * its project (decision 25). Every change is recorded in the activity log as
 * the act of `actor`, the person who made it.
 */

export const PROJECT_NAME_TAKEN = "A project with this name already exists.";
export const CLIENT_NOT_OFFERED = "Choose an active client, or none.";
export const PROJECT_CODE_TAKEN = "A project with this code already exists.";

/** What a write answered: the project's name as stored, a sentence for the person, or null for no such project here. */
export type ProjectResult = { ok: true; name: string } | { ok: false; problem: string } | null;

/** The organisation's active projects, by name. */
export function activeProjects(scope: OrganisationScope) {
	return scope.projects.select((p) => isNull(p.archivedAt), {
		orderBy: (p) => [asc(p.nameKey)],
	});
}

/** The active project of this organisation with this id, or null: one archived or of another organisation is none. */
export async function findActiveProject(scope: OrganisationScope, id: string) {
	const [project] = await scope.projects.select((p) => and(eq(p.id, id), isNull(p.archivedAt)), {
		limit: 1,
	});
	return project ?? null;
}

/** How Projects asks for its list: the words searched for, and whether a client's name is searched too. */
export interface ProjectSearch {
	/** The words typed in the search field; "" for every project. */
	query: string;
	/** Whether a project is found by its client's name: while the organisation has Clients on. */
	byClient: boolean;
}

/**
 * Every project of the organisation, active and archived, by name, each with
 * its code and client; those whose name or code, or whose client's name or
 * code, has the words searched for when there are some (TS-057, TS-115a). The
 * projects are narrowed in SQL: the clients, read for their names anyway, give
 * the ids of those whose name or code has the words, and the projects' query
 * is passed them.
 */
export async function listProjects(scope: OrganisationScope, { query, byClient }: ProjectSearch) {
	const clients = await scope.clients.select();
	const key = nameKey(query);
	const clientsFound = byClient
		? clients
				.filter((client) => client.nameKey.includes(key) || client.codeKey?.includes(key))
				.map((client) => client.id)
		: [];
	const projects = await scope.projects.select(
		key === ""
			? undefined
			: (p) =>
					or(nameHas(p.nameKey, query), nameHas(p.codeKey, query), among(p.clientId, clientsFound)),
		{ orderBy: (p) => [asc(p.nameKey)] },
	);
	const byId = new Map(clients.map((client) => [client.id, client]));
	return projects.map((project) => {
		const client = project.clientId ? byId.get(project.clientId) : undefined;
		return {
			id: project.id,
			name: project.name,
			code: project.code,
			/** No client and bills nothing: under Both, a work code (TS-115a). */
			internal: project.clientId === null && project.billingType === "non_billable",
			archived: project.archivedAt !== null,
			client: client
				? {
						id: client.id,
						name: client.name,
						code: client.code,
						key: client.nameKey,
						archived: client.archivedAt !== null,
					}
				: null,
		};
	});
}

/**
 * The time tracked on each project to date, in seconds, by the people `whose`
 * holds (docs/security.md, "Whose time"): finished entries whole, and a
 * running one up to `now`. One statement adds them up for every project; a
 * project nobody has tracked time on is not in the map.
 */
export async function projectHours(
	scope: OrganisationScope,
	whose: TimeScope,
	now: number,
): Promise<Map<string, number>> {
	const totals = await scope.timeEntries.sum(
		(e) => sql<number>`max(0, coalesce(${e.endedAt}, ${now}) - ${e.startedAt})`,
		(e) => e.projectId,
		whose.everyone ? undefined : (e) => among(e.userId, whose.people),
	);
	return new Map(totals.map(({ key, total }) => [key, Math.floor(total / 1000)]));
}

/** Whether another project of the organisation, archived or not, already has this name. */
async function nameTaken(scope: OrganisationScope, key: string, except?: string) {
	const found = await scope.projects.select(
		(p) => and(eq(p.nameKey, key), except ? ne(p.id, except) : undefined),
		{ limit: 1 },
	);
	return found.length > 0;
}

/** Whether another project of the organisation, archived or not, already has this code. */
async function codeTaken(scope: OrganisationScope, key: string, except?: string) {
	const found = await scope.projects.select(
		(p) => and(eq(p.codeKey, key), except ? ne(p.id, except) : undefined),
		{ limit: 1 },
	);
	return found.length > 0;
}

/** The organisation's rules for project codes (TS-115a), and under Both for work codes: `codeRuleFor` reads one project's. */
export async function projectCodeRules(organisationId: string): Promise<CodeRules> {
	const [rules] = await drizzle(env.DB)
		.select({
			required: organisations.projectCodeRequired,
			pattern: organisations.projectCodePattern,
			workModel: organisations.workModel,
			workCodeRequired: organisations.workCodeRequired,
			internalTerm: organisations.internalTerm,
		})
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	const model = WorkModel.catch("client_projects").parse(rules?.workModel);
	return {
		required: rules?.required ?? false,
		pattern: rules?.pattern ?? null,
		workCodes: hasWorkCodes(model),
		workCodeRequired: rules?.workCodeRequired ?? false,
		workCode: termsOf("internal", rules?.internalTerm ?? DEFAULT_INTERNAL_TERM).project,
	};
}

/**
 * The next `count` codes the organisation's pattern gives, in order, or none
 * with no pattern. The numbers are taken by one `UPDATE … RETURNING`, which D1
 * runs alone, so two creations at once never get the same one. A code another
 * project already has, or one in `alsoTaken` (code keys about to be stored,
 * such as an import's), is passed over and a further number taken.
 */
export async function nextPatternCodes(
	scope: OrganisationScope,
	count: number,
	alsoTaken: ReadonlySet<string> = new Set(),
): Promise<string[]> {
	const orm = drizzle(env.DB);
	const codes: string[] = [];
	while (codes.length < count) {
		const wanted = count - codes.length;
		const [taken] = await orm
			.update(organisations)
			.set({ projectCodeNext: sql`${organisations.projectCodeNext} + ${wanted}` })
			.where(
				and(
					eq(organisations.id, scope.organisationId),
					isNotNull(organisations.projectCodePattern),
					isNotNull(organisations.projectCodeNext),
				),
			)
			.returning({
				next: organisations.projectCodeNext,
				pattern: organisations.projectCodePattern,
			});
		const pattern = taken?.pattern ? parsePattern(taken.pattern) : null;
		if (!taken?.next || !pattern) return codes;
		const first = taken.next - wanted;
		const offered = Array.from({ length: wanted }, (_, n) => patternCode(pattern, first + n));
		const stored = await scope.projects.select((p) => among(p.codeKey, offered.map(codeKey)));
		const used = new Set([...alsoTaken, ...stored.map((p) => p.codeKey)]);
		codes.push(...offered.filter((code) => !used.has(codeKey(code))));
	}
	return codes;
}

/**
 * What a project is to have. `clientId` is left out to leave the client as it
 * is, null for none. `code` is the code field as typed, "" for none; left out,
 * a new project is numbered by the pattern and a changed one keeps its code.
 * Who may give a client, and who may create a project at all
 * (`mayCreateProject`), is the caller's to decide.
 */
export interface ProjectInput {
	name: string;
	clientId?: string | null;
	code?: string;
	/** On creation: a work code (TS-115a), with no client and billing nothing. */
	workCode?: boolean;
}

/**
 * The code a new project is given (TS-115a): the one typed, else the
 * pattern's next when its rule has one. A problem when what is typed is no
 * code or another project's, or when none is given where the rule requires
 * one. The pattern's number is taken last, once nothing else can refuse it.
 */
async function newProjectCode(
	scope: OrganisationScope,
	typed: string | undefined,
	workCode: boolean,
): Promise<{ code: string | null } | { problem: string }> {
	const given = typedCode(typed);
	if (given === false) return { problem: CODE_PROBLEM };
	if (given !== null) {
		return (await codeTaken(scope, codeKey(given)))
			? { problem: PROJECT_CODE_TAKEN }
			: { code: given };
	}
	const rule = codeRuleFor(await projectCodeRules(scope.organisationId), workCode);
	if (rule.pattern !== null) return { code: (await nextPatternCodes(scope, 1))[0] ?? null };
	return rule.required ? { problem: rule.problem } : { code: null };
}

/**
 * Adds a project with the name typed, the client given, which is active, and
 * its code (`newProjectCode`). A work code has no client and bills nothing.
 */
export async function createProject(
	scope: OrganisationScope,
	actor: string,
	{
		name: typed,
		clientId: givenClient = null,
		code: typedProjectCode,
		workCode = false,
	}: ProjectInput,
): Promise<ProjectResult> {
	const clientId = workCode ? null : givenClient;
	const name = recordName(typed);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key)) return { ok: false, problem: PROJECT_NAME_TAKEN };
	if (clientId !== null && !(await findActiveClient(scope, clientId))) {
		return { ok: false, problem: CLIENT_NOT_OFFERED };
	}
	const coded = await newProjectCode(scope, typedProjectCode, workCode);
	if ("problem" in coded) return { ok: false, problem: coded.problem };
	const { code } = coded;
	const id = uuidv7();
	try {
		await scope.batch([
			scope.projects.statements.insert({
				id,
				name,
				nameKey: key,
				clientId,
				code,
				codeKey: code === null ? null : codeKey(code),
				...(workCode ? { billingType: "non_billable" } : {}),
			}),
			recordStatement(
				scope,
				actor,
				"project.created",
				{ type: "project", id },
				changes(null, { name, clientId, code }, ["name", "clientId", "code"]),
			),
		]);
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: PROJECT_NAME_TAKEN };
		if (isCodeClash(error)) return { ok: false, problem: PROJECT_CODE_TAKEN };
		throw error;
	}
	return { ok: true, name };
}

/**
 * Gives the project `id` the name typed, the client given and the code typed.
 * Its own name or code in other letters is no clash. An archived client is
 * never given, but a project that already has one keeps it. A new name, a new
 * client and a new code are each recorded; a save that changes none records
 * nothing.
 */
export async function changeProject(
	scope: OrganisationScope,
	actor: string,
	id: string,
	{ name: typed, clientId, code: typedProjectCode }: ProjectInput,
): Promise<ProjectResult> {
	const [project] = await scope.projects.select((p) => eq(p.id, id), { limit: 1 });
	if (!project) return null;

	const name = recordName(typed);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key, id)) return { ok: false, problem: PROJECT_NAME_TAKEN };
	const code = typedProjectCode === undefined ? project.code : typedCode(typedProjectCode);
	if (code === false) return { ok: false, problem: CODE_PROBLEM };
	if (code !== null && (await codeTaken(scope, codeKey(code), id))) {
		return { ok: false, problem: PROJECT_CODE_TAKEN };
	}
	const keepsClient = clientId === undefined || clientId === project.clientId;
	if (code === null && project.code !== null) {
		// Judged as the project will be: one moved to or from a client changes rule.
		const clientAfter = keepsClient ? project.clientId : clientId;
		const workCode = clientAfter === null && project.billingType === "non_billable";
		const rule = codeRuleFor(await projectCodeRules(scope.organisationId), workCode);
		if (rule.required) return { ok: false, problem: rule.problem };
	}
	if (!keepsClient && clientId !== null && !(await findActiveClient(scope, clientId))) {
		return { ok: false, problem: CLIENT_NOT_OFFERED };
	}
	const subject = { type: "project", id } as const;
	const codeColumns = { code, codeKey: code === null ? null : codeKey(code) };
	try {
		const [[changed]] = await scope.batch([
			scope.projects.statements.update(
				keepsClient
					? { name, nameKey: key, ...codeColumns }
					: { name, nameKey: key, clientId, ...codeColumns },
				(p) => eq(p.id, id),
			),
			...(code === project.code
				? []
				: [
						recordStatement(
							scope,
							actor,
							"project.updated",
							subject,
							changes(project, { code }, ["code"]),
						),
					]),
			...(name === project.name
				? []
				: [
						recordStatement(
							scope,
							actor,
							"project.renamed",
							subject,
							changes(project, { name }, ["name"]),
						),
					]),
			...(keepsClient
				? []
				: [
						recordStatement(
							scope,
							actor,
							"project.client_changed",
							subject,
							changes(project, { clientId }, ["clientId"]),
						),
					]),
		]);
		return changed ? { ok: true, name } : null;
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: PROJECT_NAME_TAKEN };
		if (isCodeClash(error)) return { ok: false, problem: PROJECT_CODE_TAKEN };
		throw error;
	}
}

/** Archives the project `id`, or restores it with `archived` false. Its entries are not touched. */
export async function setProjectArchived(
	scope: OrganisationScope,
	actor: string,
	id: string,
	archived: boolean,
): Promise<ProjectResult> {
	const [changed] = await scope.projects.update({ archivedAt: archived ? new Date() : null }, (p) =>
		eq(p.id, id),
	);
	if (!changed) return null;
	await record(scope, actor, archived ? "project.archived" : "project.restored", {
		type: "project",
		id,
	});
	return { ok: true, name: changed.name };
}

/**
 * The name a copy of the project `name` is offered (`copyName`), against the
 * projects of the organisation that have its copy's name in theirs.
 */
export async function offeredCopyName(scope: OrganisationScope, name: string): Promise<string> {
	const near = await scope.projects.select((p) => nameHas(p.nameKey, `${name} (copy`));
	return copyName(name, new Set(near.map((p) => p.nameKey)));
}

/**
 * Makes a project of the shape of `sourceId` under the name typed (TS-122,
 * S2-06): its client, how it bills, its currency, overtime rate and budget
 * with its lines and alert, its tasks with their billable flags, its tags,
 * and its rates with their dates. Never its time, expenses, invoices, dates or
 * code: the copy's code is typed, or given by the rule of a project like it
 * (`newProjectCode`, TS-115a). The copy is active, whatever the source is,
 * and the log records the project it was duplicated from. One batch: the copy
 * is whole or not there. Null for no such project here.
 */
export async function duplicateProject(
	scope: OrganisationScope,
	actor: string,
	sourceId: string,
	typed: string,
	typedProjectCode?: string,
): Promise<{ ok: true; name: string; id: string } | { ok: false; problem: string } | null> {
	const [source] = await scope.projects.select((p) => eq(p.id, sourceId), { limit: 1 });
	if (!source) return null;
	const name = recordName(typed);
	if (name === null) return { ok: false, problem: RECORD_NAME_PROBLEM };
	const key = nameKey(name);
	if (await nameTaken(scope, key)) return { ok: false, problem: PROJECT_NAME_TAKEN };
	const workCode = source.clientId === null && source.billingType === "non_billable";
	const coded = await newProjectCode(scope, typedProjectCode, workCode);
	if ("problem" in coded) return { ok: false, problem: coded.problem };
	const { code } = coded;
	const [tasks, tags, rates, lines] = await Promise.all([
		scope.projectTasks.select((t) => eq(t.projectId, sourceId)),
		scope.projectTags.select((t) => eq(t.projectId, sourceId)),
		scope.rates.select((r) => eq(r.projectId, sourceId)),
		scope.budgetLines.select((l) => eq(l.projectId, sourceId)),
	]);
	const id = uuidv7();
	try {
		await scope.batch([
			scope.projects.statements.insert({
				id,
				name,
				nameKey: key,
				code,
				codeKey: code === null ? null : codeKey(code),
				clientId: source.clientId,
				billingType: source.billingType,
				rateMode: source.rateMode,
				feeMinor: source.feeMinor,
				currency: source.currency,
				budgetKind: source.budgetKind,
				budgetAmount: source.budgetAmount,
				budgetResetsMonthly: source.budgetResetsMonthly,
				budgetAlertPercent: source.budgetAlertPercent,
				budgetWarnMembers: source.budgetWarnMembers,
				budgetIncludesExpenses: source.budgetIncludesExpenses,
				overtimeRateMilli: source.overtimeRateMilli,
			}),
			// The new project is given the common tasks as it is made (migration
			// 0014's trigger); the copy has the source's tasks instead, and only them.
			scope.projectTasks.statements.delete((t) => eq(t.projectId, id)),
			// A row a statement: D1 binds at most 100 values to one.
			...tasks.map((t) =>
				scope.projectTasks.statements.insert({
					projectId: id,
					taskId: t.taskId,
					billable: t.billable,
				}),
			),
			...tags.map((t) => scope.projectTags.statements.insert({ projectId: id, tagId: t.tagId })),
			...rates.map((r) =>
				scope.rates.statements.insert({
					kind: r.kind,
					userId: r.userId,
					projectId: id,
					taskId: r.taskId,
					amountMinor: r.amountMinor,
					currency: r.currency,
					effectiveFrom: r.effectiveFrom,
				}),
			),
			...lines.map((l) =>
				scope.budgetLines.statements.insert({
					projectId: id,
					taskId: l.taskId,
					userId: l.userId,
					amount: l.amount,
				}),
			),
			recordStatement(
				scope,
				actor,
				"project.created",
				{ type: "project", id },
				changes(null, { name, clientId: source.clientId, code, duplicatedFromId: sourceId }, [
					"name",
					"clientId",
					"code",
					"duplicatedFromId",
				]),
			),
		]);
	} catch (error) {
		if (isNameClash(error)) return { ok: false, problem: PROJECT_NAME_TAKEN };
		if (isCodeClash(error)) return { ok: false, problem: PROJECT_CODE_TAKEN };
		throw error;
	}
	return { ok: true, name, id };
}
