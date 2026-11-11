import { env } from "cloudflare:workers";
import { useState } from "react";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import * as z from "zod";

import {
	type ClientResult,
	createClient,
	listClients,
	renameClient,
	setClientArchived,
} from "~/clients/clients.server";
import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { RECORD_NAME_MAX_LENGTH, recordNameProblem } from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { ArchiveTabs } from "~/projects/ArchiveTabs";
import { onlyTabChanged, searchIn } from "~/projects/projects";
import { SearchForm } from "~/projects/SearchForm";
import { destination } from "~/shell/destinations";
import { PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/clients";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Clients: whom the organisation's projects are for (TS-011b). Its owners and
// admins are shown it while the organisation has Clients turned on, and
// nobody else is: the layout answers them 404, actions included
// (docs/navigation.md). They create, rename, archive and restore clients, and
// see each client's projects; a client is never deleted. An archived client is
// offered to no project, and the projects that have it keep it. The list is
// filtered by a client's name, in the address (TS-057).

const { label } = destination("clients");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/** Every client, active and archived, or those whose name has the words in the address, each with its projects. */
export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const query = searchIn(new URL(request.url).searchParams);
	const scope = organisationScope(env.DB, membership.organisation.id);
	return { clients: await listClients(scope, query), query };
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

/** The four things this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("create"), name: Name }),
	z.object({ intent: z.literal("rename"), clientId: Id, name: Name }),
	z.object({ intent: z.literal("archive"), clientId: Id }),
	z.object({ intent: z.literal("restore"), clientId: Id }),
]);

/**
 * Creates, renames, archives or restores a client of the organisation in the
 * address; a client of another is no client here, so it answers 404 and
 * nothing changes.
 */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const { organisation, user } = context.get(membershipContext);
	const scope = organisationScope(env.DB, organisation.id);
	switch (input.intent) {
		case "create":
			return answer(
				await createClient(scope, user.id, input.name),
				(name) => `Client created: ${name}.`,
			);
		case "rename":
			return answer(
				await renameClient(scope, user.id, input.clientId, input.name),
				(name) => `Client renamed: ${name}.`,
			);
		case "archive":
			return answer(
				await setClientArchived(scope, user.id, input.clientId, true),
				(name) => `${name} is archived. Its projects keep it, and no other project is offered it.`,
			);
		case "restore":
			return answer(
				await setClientArchived(scope, user.id, input.clientId, false),
				(name) => `${name} is restored. Projects can be given it again.`,
			);
	}
}

/** What the page is told: what was done, why nothing was, or 404 for a client that is not here. */
function answer(result: ClientResult, said: (name: string) => string) {
	if (result === null) throw notFound();
	return result.ok ? done(said(result.name)) : declined(result.problem);
}

type Client = Route.ComponentProps["loaderData"]["clients"][number];

/** The sheets of this page. One is open at a time. */
type Task = "create" | "rename" | "archive" | "restore";

export default function Clients({ loaderData }: Route.ComponentProps) {
	const { clients, query } = loaderData;
	const organisation = useOrganisation();

	const [task, setTask] = useState<Task | null>(null);
	// Which client the open sheet is about. Kept after it closes, so the sheet
	// goes on saying the same thing while it leaves.
	const [client, setClient] = useState<Client | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);

	const create = <Button onPress={() => setTask("create")}>Create client</Button>;

	const rows = (shown: Client[], archived: boolean) =>
		shown.length === 0 ? (
			<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
				{query !== ""
					? `No ${archived ? "archived" : "active"} client has “${query}” in its name.`
					: archived
						? "No archived clients. A client you archive is kept here, with its projects, and can be restored."
						: "No active clients. Restore one from Archived, or create one."}
			</p>
		) : (
			<LedgerRows label={archived ? "Archived clients" : "Active clients"}>
				{shown.map((each) => (
					<LedgerRow
						key={each.id}
						title={<span className="wrap-anywhere">{each.name}</span>}
						detail={
							<span className="wrap-anywhere">
								{each.projects.length === 0
									? "No projects"
									: each.projects
											.map((project) =>
												project.archived ? `${project.name} (archived)` : project.name,
											)
											.join(", ")}
							</span>
						}
						action={
							<MenuTrigger>
								<Button variant="text" aria-label={`Actions for ${each.name}`}>
									Actions
								</Button>
								<Menu
									onAction={(chosen) => {
										setClient(each);
										setTask(chosen === "rename" ? "rename" : archived ? "restore" : "archive");
									}}
								>
									<MenuItem id="rename">Rename</MenuItem>
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

	const active = clients.filter((each) => !each.archived);
	const archived = clients.filter((each) => each.archived);

	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				Whom {organisation.name}'s projects are for. Give a project its client on Projects; everyone
				sees it there.
			</PageLead>
			{/* What the last task did. Always here, so what is put in it is read out. */}
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>

			<div className="mt-10 max-w-200">
				{clients.length === 0 && query === "" ? (
					<Ledger heading="Clients" note={0}>
						<div className="flex flex-col items-start gap-4 border-t border-outline-variant px-4 py-6 @sm:px-5">
							<h2 className="text-title-large">No clients yet</h2>
							<p className="max-w-160 text-body-large text-on-surface-variant">
								A client is whom a project is for. Group projects by client to see the time each one
								takes.
							</p>
							{create}
						</div>
					</Ledger>
				) : (
					<>
						{create}
						<div className="mt-6">
							<SearchForm
								name="Filter clients"
								label="Filter by client name"
								submitLabel="Filter"
							/>
						</div>
						<div className="mt-6">
							<ArchiveTabs
								label="Clients"
								active={
									<Ledger heading="Active clients" note={active.length}>
										{rows(active, false)}
									</Ledger>
								}
								archived={
									<Ledger heading="Archived clients" note={archived.length}>
										{rows(archived, true)}
									</Ledger>
								}
							/>
						</div>
					</>
				)}
			</div>

			<FormSheet
				title="Create a client"
				intent="create"
				submitLabel="Create the client"
				isOpen={task === "create"}
				onClose={close}
				onDone={setSaid}
			>
				<p>Then give it projects on Projects.</p>
				<TextField
					label="Client name"
					name="name"
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
			</FormSheet>

			<FormSheet
				title={`Rename ${client?.name ?? "this client"}`}
				intent="rename"
				submitLabel="Save"
				isOpen={task === "rename"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="clientId" value={client?.id ?? ""} />
				<TextField
					key={client?.id}
					label="Client name"
					name="name"
					defaultValue={client?.name}
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
			</FormSheet>

			<FormSheet
				title={`Archive ${client?.name ?? "this client"}?`}
				intent="archive"
				submitLabel="Archive client"
				isOpen={task === "archive"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="clientId" value={client?.id ?? ""} />
				<p>
					It moves to Archived and no project can be given it. The projects that have it keep it,
					and their time stays in every report.
				</p>
			</FormSheet>

			<FormSheet
				title={`Restore ${client?.name ?? "this client"}?`}
				intent="restore"
				submitLabel="Restore client"
				isOpen={task === "restore"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="clientId" value={client?.id ?? ""} />
				<p>It moves back to Active and projects can be given it again.</p>
			</FormSheet>
		</>
	);
}
