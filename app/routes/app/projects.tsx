import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import {
	Link,
	type ShouldRevalidateFunctionArgs,
	useRevalidator,
	useSearchParams,
} from "react-router";
import * as z from "zod";

import { activeClients } from "~/clients/clients.server";
import { Button } from "~/components/Button";
import { cx } from "~/components/cx";
import { FilterBar, FilterField } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { importPath } from "~/integrations/paths";
import { nameKey, RECORD_NAME_MAX_LENGTH, recordNameProblem } from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import {
	mayManageClients,
	mayManageIntegrations,
	maySeeRates,
	timeScopeOf,
} from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { ArchiveTabs } from "~/projects/ArchiveTabs";
import {
	defaultRatesPath,
	groupedByClient,
	keptTab,
	NO_CLIENT,
	onlySearchChanged,
	onlyTabChanged,
	projectMatches,
	projectPath,
	SEARCH_PARAM,
	searchIn,
} from "~/projects/projects";
import {
	changeProject,
	createProject,
	listProjects,
	type ProjectResult,
	projectHours,
	setProjectArchived,
} from "~/projects/projects.server";
import { hoursAndMinutes } from "~/reports/format";
import { destination } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { onlyQueryMoved } from "~/shell/revalidation";

import type { Route } from "./+types/projects";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Projects: what the organisation tracks time against (TS-011a). Every role
// sees every project, active and archived, and creates, renames, archives and
// restores them; none is ever deleted. A project's client is shown while the
// organisation has Clients turned on; only its owners and admins give a
// project one (TS-011b): Finance, shown Clients, changes none (TS-075). The
// list is searched by a project's or its client's name, grouped under the
// clients, and each project shows the hours tracked on it to date by the
// people whose time the viewer may see (TS-057).

const { label } = destination("projects");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** Whose hours the page shows: everyone's, the viewer's and their teams', or the viewer's own. */
export type HoursOf = "everyone" | "teams" | "own";

/**
 * Every project, or those the address searches for, each with its hours to
 * date; and the clients a project may be given when the person may give one.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const showsClients = membership.organisation.clientsEnabled;
	const givesClients = showsClients && mayManageClients(membership.role);
	const query = searchIn(new URL(request.url).searchParams);
	const access = await accessOf(membership);
	const whose = timeScopeOf(access);
	const [projects, hours, clients] = await Promise.all([
		listProjects(scope, { query, byClient: showsClients }),
		projectHours(scope, whose, Date.now()),
		givesClients ? activeClients(scope) : [],
	]);
	const hoursOf: HoursOf = whose.everyone ? "everyone" : access.managed.size > 0 ? "teams" : "own";
	return {
		projects: projects.map((project) => ({
			...project,
			client: showsClients ? project.client : null,
			hours: hoursAndMinutes(hours.get(project.id) ?? 0),
		})),
		query,
		showsClients,
		hoursOf,
		clients: clients.map(({ id, name }) => ({ id, name })),
		givesClients,
		/** Whether the default rates are the viewer's to see (TS-067). */
		seesRates: maySeeRates(membership.role),
	};
}

/**
 * Moving between the tabs reads nothing again: the loader sent both lists. Nor
 * does a search typed with script (TS-114): the page filters the list it holds
 * with each key, and asks again itself when the words no longer narrow the
 * ones it was sent (`useRevalidator` in the page).
 */
export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
	const { currentUrl, nextUrl, formMethod, defaultShouldRevalidate } = args;
	if (!formMethod && onlyTabChanged(currentUrl, nextUrl)) return false;
	if (onlyQueryMoved(args) && onlySearchChanged(currentUrl, nextUrl)) return false;
	return defaultShouldRevalidate;
}

const Id = z.string().min(1).max(64);
// Its length is the page's rule, said in the page's words; a body is at most 64 KB.
const Name = z.string();
const Client = z.string().max(64).optional();

/** The four things this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("create"), name: Name, clientId: Client }),
	z.object({ intent: z.literal("rename"), projectId: Id, name: Name, clientId: Client }),
	z.object({ intent: z.literal("archive"), projectId: Id }),
	z.object({ intent: z.literal("restore"), projectId: Id }),
]);

/**
 * Creates, renames, archives or restores a project of the organisation in the
 * address; no form names an organisation, and a project of another is no
 * project here, so it answers 404 and nothing changes.
 */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	const scope = organisationScope(env.DB, membership.organisation.id);

	switch (input.intent) {
		case "create":
		case "rename": {
			// A project's client is given by an owner or admin, and by nobody
			// while Clients is turned off. Leaving the field out keeps it as it is.
			let clientId: string | null | undefined;
			if (input.clientId !== undefined) {
				if (!membership.organisation.clientsEnabled || !mayManageClients(membership.role)) {
					return declined(NOT_ALLOWED, 403);
				}
				clientId = input.clientId === NO_CLIENT ? null : input.clientId;
			}
			if (input.intent === "create") {
				return answer(
					await createProject(scope, membership.user.id, { name: input.name, clientId }),
					(name) => `Project created: ${name}.`,
				);
			}
			return answer(
				await changeProject(scope, membership.user.id, input.projectId, {
					name: input.name,
					clientId,
				}),
				(name) => `Project saved: ${name}.`,
			);
		}

		case "archive":
			return answer(
				await setProjectArchived(scope, membership.user.id, input.projectId, true),
				(name) => `${name} is archived. It is under Archived, and the timer no longer offers it.`,
			);

		case "restore":
			return answer(
				await setProjectArchived(scope, membership.user.id, input.projectId, false),
				(name) => `${name} is restored. The timer offers it again.`,
			);
	}
}

/** What the page is told: what was done, why nothing was, or 404 for a project that is not here. */
function answer(result: ProjectResult, said: (name: string) => string) {
	if (result === null) throw notFound();
	return result.ok ? done(said(result.name)) : declined(result.problem);
}

type Project = Route.ComponentProps["loaderData"]["projects"][number];

/** The sheets of this page. One is open at a time. */
type Task = "create" | "rename" | "archive" | "restore";

/** The sentence that says whose hours a project's figure adds up. */
const HOURS_SAID: Record<HoursOf, string> = {
	everyone:
		"The projects everyone tracks time against, each with the hours tracked on it to date, a running timer included.",
	teams:
		"The projects everyone tracks time against, each with the hours you and your teams have tracked on it to date, a running timer included.",
	own: "The projects everyone tracks time against, each with the hours you have tracked on it to date, a running timer included.",
};

export default function Projects({ loaderData }: Route.ComponentProps) {
	const { clients, givesClients, showsClients, hoursOf } = loaderData;
	const organisation = useOrganisation();
	const [search] = useSearchParams();
	// The words in the address, which the field writes with each key. The list
	// the server sent is filtered here while they narrow the words it was sent
	// for; words that do not are asked of the server.
	const query = searchIn(search);
	const narrows = nameKey(query).includes(nameKey(loaderData.query));
	const { revalidate, state } = useRevalidator();
	useEffect(() => {
		if (!narrows && state === "idle") void revalidate();
	}, [narrows, state, revalidate]);
	const projects = narrows
		? loaderData.projects.filter((each) => projectMatches(each, query, showsClients))
		: loaderData.projects;

	const [task, setTask] = useState<Task | null>(null);
	// Which project the open sheet is about. Kept after it closes, so the sheet
	// goes on saying the same thing while it leaves.
	const [project, setProject] = useState<Project | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	const create = <Button onPress={() => setTask("create")}>Create project</Button>;

	// A project's name opens its own page (harvest-taste.md item 11); Edit
	// opens its sheet, which edits it and holds Archive or Restore: two things,
	// so no menu (docs/design-direction.md, rule 2).
	const list = (shown: Project[], label: string) => (
		<LedgerRows label={label}>
			{shown.map((each) => (
				<LedgerRow
					key={each.id}
					title={
						<Link
							to={projectPath(organisation.slug, each.id)}
							className={cx(ACTION_LINK, "wrap-anywhere")}
						>
							{each.name}
						</Link>
					}
					action={
						// React Aria's button presses on key up, as every button that opens a
						// sheet here does, so the sheet's field keeps the focus it is given.
						<Button
							variant="text"
							aria-label={`Edit ${each.name}`}
							onPress={() => {
								setProject(each);
								setTask("rename");
							}}
						>
							Edit
						</Button>
					}
					value={each.hours}
				/>
			))}
		</LedgerRows>
	);

	const rows = (shown: Project[], archived: boolean) => {
		const listName = archived ? "Archived projects" : "Active projects";
		if (shown.length === 0) {
			return (
				<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
					{query !== ""
						? `No ${archived ? "archived" : "active"} project has “${query}” in its name${showsClients ? " or its client’s" : ""}.`
						: archived
							? "No archived projects. A project you archive is kept here, with its time, and can be restored."
							: "No active projects. Restore one from Archived, or create one."}
				</p>
			);
		}
		// While Clients is off no project shows a client, so there are no groups.
		if (!showsClients) return list(shown, listName);
		return groupedByClient(shown).map(({ client, projects: inGroup }) => {
			const name = client
				? `${client.name}${client.archived ? " (archived client)" : ""}`
				: "No client";
			return (
				<section key={client?.id ?? NO_CLIENT} className="border-t border-outline-variant">
					<h2 className="wrap-anywhere px-4 pt-3 text-title-small text-on-surface-variant @sm:px-5">
						{name}
					</h2>
					{list(inGroup, `${listName}: ${name}`)}
				</section>
			);
		});
	};

	const active = projects.filter((each) => !each.archived);
	const archived = projects.filter((each) => each.archived);

	// The client field: the active clients, and a project's own client when it
	// is archived, so that saving keeps it (TS-011b).
	const clientOptions = (current: Project | null) => [
		{ id: NO_CLIENT, label: "No client" },
		...clients.map(({ id, name }) => ({ id, label: name })),
		...(current?.client?.archived
			? [{ id: current.client.id, label: `${current.client.name} (archived)` }]
			: []),
	];

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>{HOURS_SAID[hoursOf]}</PageLead>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			{loaderData.seesRates && (
				<p className="mt-4 text-body-large">
					<Link to={defaultRatesPath(organisation.slug)} className={ACTION_LINK}>
						Default rates
					</Link>
				</p>
			)}

			<div className="mt-10 max-w-200">
				{projects.length === 0 && query === "" ? (
					<Ledger heading="Projects" note={0}>
						<div className="flex flex-col items-start gap-4 border-t border-outline-variant px-4 py-6 @sm:px-5">
							<h2 className="text-title-large">No projects yet</h2>
							<p className="max-w-160 text-body-large text-on-surface-variant">
								A project is what you track time against, such as a client job or a piece of your
								own work.
							</p>
							{create}
						</div>
					</Ledger>
				) : (
					<>
						{create}
						{mayManageIntegrations(organisation.role) && (
							<Link
								className={`ml-4 ${ACTION_LINK}`}
								to={importPath(organisation.slug, "projects")}
							>
								Import projects from a CSV
							</Link>
						)}
						<div className="mt-6">
							<FilterBar name="Filter projects" keep={keptTab(search)}>
								<FilterField
									label={showsClients ? "Search projects or clients" : "Search projects"}
									param={SEARCH_PARAM}
									live
								/>
							</FilterBar>
						</div>
						<div className="mt-6">
							<ArchiveTabs
								label="Projects"
								active={
									<Ledger heading="Active projects" note={active.length}>
										{rows(active, false)}
									</Ledger>
								}
								archived={
									<Ledger heading="Archived projects" note={archived.length}>
										{rows(archived, true)}
									</Ledger>
								}
							/>
						</div>
					</>
				)}
			</div>

			<FormSheet
				title="Create a project"
				intent="create"
				submitLabel="Create the project"
				isOpen={task === "create"}
				onClose={close}
				onDone={setSaid}
			>
				<p>Everyone in {organisation.name} can track time against it.</p>
				<TextField
					label="Project name"
					name="name"
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
				{givesClients && (
					<Select
						label="Client"
						name="clientId"
						options={clientOptions(null)}
						defaultValue={NO_CLIENT}
						description={clients.length === 0 ? "Add clients on Clients." : undefined}
					/>
				)}
			</FormSheet>

			<FormSheet
				title={`Edit ${project?.name ?? "this project"}`}
				intent="rename"
				submitLabel="Save"
				isOpen={task === "rename"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="projectId" value={project?.id ?? ""} />
				{/* Keyed by the project, so the fields start at what it has. */}
				<TextField
					key={`name-${project?.id}`}
					label="Project name"
					name="name"
					defaultValue={project?.name}
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
				{givesClients && (
					<Select
						key={`client-${project?.id}`}
						label="Client"
						name="clientId"
						options={clientOptions(project)}
						defaultValue={project?.client?.id ?? NO_CLIENT}
					/>
				)}
				{/* Archiving is not saving: it opens its own sheet, which says what it does. */}
				<div className="flex flex-col items-start gap-2 border-t border-outline-variant pt-4">
					<p className="text-body-medium text-on-surface-variant">
						{project?.archived
							? "Archived. Restore it and the timer offers it again."
							: "Done with it? Archive it and the timer stops offering it; its time stays."}
					</p>
					<Button
						variant="outlined"
						onPress={() => setTask(project?.archived ? "restore" : "archive")}
					>
						{project?.archived ? "Restore project" : "Archive project"}
					</Button>
				</div>
			</FormSheet>

			<FormSheet
				title={`Archive ${project?.name ?? "this project"}?`}
				intent="archive"
				submitLabel="Archive project"
				isOpen={task === "archive"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="projectId" value={project?.id ?? ""} />
				<p>
					It moves to Archived and the timer no longer offers it. Its time stays in every report,
					and anyone can restore it.
				</p>
			</FormSheet>

			<FormSheet
				title={`Restore ${project?.name ?? "this project"}?`}
				intent="restore"
				submitLabel="Restore project"
				isOpen={task === "restore"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="projectId" value={project?.id ?? ""} />
				<p>It moves back to Active and the timer offers it again.</p>
			</FormSheet>
		</>
	);
}
