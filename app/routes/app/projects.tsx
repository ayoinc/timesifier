import { env } from "cloudflare:workers";
import { useState } from "react";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import * as z from "zod";

import { activeClients } from "~/clients/clients.server";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { RECORD_NAME_MAX_LENGTH, recordNameProblem } from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import { isAdministrator, timeScopeOf } from "~/organisations/access";
import { accessOf } from "~/organisations/access.server";
import { membershipContext, notFound, viewerOf } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { ArchiveTabs } from "~/projects/ArchiveTabs";
import { groupedByClient, NO_CLIENT, onlyTabChanged, searchIn } from "~/projects/projects";
import {
	changeProject,
	createProject,
	listProjects,
	type ProjectResult,
	projectHours,
	setProjectArchived,
} from "~/projects/projects.server";
import { SearchForm } from "~/projects/SearchForm";
import { hoursAndMinutes } from "~/reports/format";
import { canSee, destination } from "~/shell/destinations";
import { PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/projects";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Projects: what the organisation tracks time against (TS-011a). Every role
// sees every project, active and archived, and creates, renames, archives and
// restores them; none is ever deleted. A project's client is shown while the
// organisation has Clients turned on; only those who are shown Clients, its
// owners and admins, give a project one (TS-011b). The list is searched by a
// project's or its client's name, grouped under the clients, and each project
// shows the hours tracked on it to date by the people whose time the viewer
// may see (TS-057).

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
	const givesClients = canSee(viewerOf(membership), "clients");
	const query = searchIn(new URL(request.url).searchParams);
	const access = await accessOf(membership);
	const [projects, hours, clients] = await Promise.all([
		listProjects(scope, { query, byClient: showsClients }),
		projectHours(scope, timeScopeOf(access), Date.now()),
		givesClients ? activeClients(scope) : [],
	]);
	const hoursOf: HoursOf = isAdministrator(access.role)
		? "everyone"
		: access.managed.size > 0
			? "teams"
			: "own";
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
	};
}

/** Moving between the tabs reads nothing again: the loader sent both lists. */
export function shouldRevalidate({
	currentUrl,
	nextUrl,
	formMethod,
	defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
	if (!formMethod && onlyTabChanged(currentUrl, nextUrl)) return false;
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
			// A project's client is given by those shown Clients, and by nobody
			// while Clients is turned off. Leaving the field out keeps it as it is.
			let clientId: string | null | undefined;
			if (input.clientId !== undefined) {
				if (!canSee(viewerOf(membership), "clients")) return declined(NOT_ALLOWED, 403);
				clientId = input.clientId === NO_CLIENT ? null : input.clientId;
			}
			if (input.intent === "create") {
				return answer(
					await createProject(scope, { name: input.name, clientId }),
					(name) => `Project created: ${name}.`,
				);
			}
			return answer(
				await changeProject(scope, input.projectId, { name: input.name, clientId }),
				(name) => `Project saved: ${name}.`,
			);
		}

		case "archive":
			return answer(
				await setProjectArchived(scope, input.projectId, true),
				(name) => `${name} is archived. It is under Archived, and the timer no longer offers it.`,
			);

		case "restore":
			return answer(
				await setProjectArchived(scope, input.projectId, false),
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
	everyone: "Each shows the hours tracked on it to date, a running timer included.",
	teams:
		"Each shows the hours you and the people in your teams have tracked on it to date, a running timer included.",
	own: "Each shows the hours you have tracked on it to date, a running timer included.",
};

export default function Projects({ loaderData }: Route.ComponentProps) {
	const { projects, clients, givesClients, query, showsClients, hoursOf } = loaderData;
	const organisation = useOrganisation();

	const [task, setTask] = useState<Task | null>(null);
	// Which project the open sheet is about. Kept after it closes, so the sheet
	// goes on saying the same thing while it leaves.
	const [project, setProject] = useState<Project | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	// A person who gives clients edits a project's name and client together.
	const editWord = givesClients ? "Edit" : "Rename";

	const create = <Button onPress={() => setTask("create")}>Create project</Button>;

	const list = (shown: Project[], archived: boolean, label: string) => (
		<LedgerRows label={label}>
			{shown.map((each) => (
				<LedgerRow
					key={each.id}
					title={<span className="wrap-anywhere">{each.name}</span>}
					value={each.hours}
					action={
						<MenuTrigger>
							<Button variant="text" aria-label={`Actions for ${each.name}`}>
								Actions
							</Button>
							<Menu
								onAction={(chosen) => {
									setProject(each);
									setTask(chosen === "rename" ? "rename" : archived ? "restore" : "archive");
								}}
							>
								<MenuItem id="rename">{editWord}</MenuItem>
								{archived ? (
									<MenuItem id="restore">Restore</MenuItem>
								) : (
									<MenuItem id="archive">Archive</MenuItem>
								)}
							</Menu>
						</MenuTrigger>
					}
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
		if (!showsClients) return list(shown, archived, listName);
		return groupedByClient(shown).map(({ client, projects: inGroup }) => {
			const name = client
				? `${client.name}${client.archived ? " (archived client)" : ""}`
				: "No client";
			return (
				<section key={client?.id ?? NO_CLIENT} className="border-t border-outline-variant">
					<h2 className="wrap-anywhere px-4 pt-3 text-title-small text-on-surface-variant @sm:px-5">
						{name}
					</h2>
					{list(inGroup, archived, `${listName}: ${name}`)}
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
			<PageLead>
				What everyone in {organisation.name} tracks time against. Anyone here can add one, rename
				it, or archive it when the work is done. {HOURS_SAID[hoursOf]}
			</PageLead>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

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
						<div className="mt-6">
							<SearchForm
								name="Search projects"
								label={showsClients ? "Search by project or client name" : "Search by project name"}
								submitLabel="Search"
							/>
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
				title={`${editWord} ${project?.name ?? "this project"}`}
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
