import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Link, type ShouldRevalidateFunctionArgs, useSearchParams } from "react-router";
import * as z from "zod";

import {
	type ClientResult,
	createClient,
	listClients,
	renameClient,
	setClientArchived,
	setClientCurrency,
} from "~/clients/clients.server";
import {
	MANAGER_NOT_A_MEMBER,
	managersByClient,
	setClientManager,
} from "~/clients/managers.server";
import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { cx } from "~/components/cx";
import { FilterBar, FilterField } from "~/components/FilterBar";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { importPath } from "~/integrations/paths";
import { CODE_MAX_LENGTH, codedName, codeProblem } from "~/lib/codes";
import { RECORD_NAME_MAX_LENGTH, recordNameProblem } from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import { isCurrencyCode } from "~/money/money";
import { mayManageClients, mayManageIntegrations } from "~/organisations/access";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { ArchiveTabs } from "~/projects/ArchiveTabs";
import { CURRENCIES, INHERITED } from "~/projects/billing";
import { keptTab, onlyTabChanged, SEARCH_PARAM, searchIn } from "~/projects/projects";
import { destination } from "~/shell/destinations";
import { ACTION_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { peopleOf } from "~/teams/people.server";

import type { Route } from "./+types/clients";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Clients: whom the organisation's projects are for (TS-011b). Its owners,
// admins and Finance are shown it while the organisation has clients, and
// nobody else is: the layout answers them 404, actions included
// (docs/navigation.md). Owners and admins create, rename, archive and restore
// clients, and name each one's account managers, who create its projects
// (decision 42); Finance reads them, to invoice them, and the action answers
// its forms 403 (TS-075). Everyone shown it sees each client's code, projects
// and account managers; a client is never deleted. An archived client is
// offered to no project, and the projects that have it keep it. The list is
// filtered by a client's name or code, in the address (TS-057, TS-115a).

const { label } = destination("clients");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

/**
 * Every client, active and archived, or those whose name or code has the words
 * in the address, each with its projects and its account managers; and, for
 * those who name account managers, every member.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	const query = searchIn(new URL(request.url).searchParams);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const canManage = mayManageClients(membership.role);
	const [clients, managers, people] = await Promise.all([
		listClients(scope, query),
		managersByClient(scope),
		peopleOf(scope, membership.organisation),
	]);
	const nameOf = new Map(people.map((person) => [person.id, person.name]));
	return {
		clients: clients.map((client) => {
			const ids = managers.get(client.id) ?? [];
			return {
				...client,
				managers: ids
					.filter((id) => nameOf.has(id))
					.map((id) => ({ id, name: nameOf.get(id) ?? "" }))
					.sort((a, b) => a.name.localeCompare(b.name, "en")),
			};
		}),
		query,
		canManage,
		/** Every member, for the account managers' sheet: only for those who name them. */
		members: canManage ? people.map(({ id, name }) => ({ id, name })) : [],
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
// Checked by `typedCode`, in the server's words.
const Code = z.string().max(256).optional();
const Ids = z
	.union([Id, z.array(Id).max(5000)])
	.optional()
	.transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]));

/** The things this page can ask for. A form says which with its `intent`. */
const form = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("create"), name: Name, code: Code }),
	z.object({ intent: z.literal("rename"), clientId: Id, name: Name, code: Code }),
	z.object({ intent: z.literal("archive"), clientId: Id }),
	z.object({ intent: z.literal("restore"), clientId: Id }),
	z.object({ intent: z.literal("currency"), clientId: Id, currency: z.string().max(8) }),
	// The account managers the client is to have: those ticked (decision 42).
	z.object({ intent: z.literal("managers"), clientId: Id, managerIds: Ids }),
]);

/**
 * Creates, renames, archives or restores a client of the organisation in the
 * address, for an owner or admin; anyone else is answered 403. A client of
 * another organisation is no client here, so it answers 404 and nothing changes.
 */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const { organisation, user, role } = context.get(membershipContext);
	if (!mayManageClients(role)) return declined(NOT_ALLOWED, 403);
	const scope = organisationScope(env.DB, organisation.id);
	switch (input.intent) {
		case "create":
			return answer(
				await createClient(scope, user.id, input.name, input.code),
				(name) => `Client created: ${name}.`,
			);
		case "rename":
			return answer(
				await renameClient(scope, user.id, input.clientId, input.name, input.code),
				(name) => `Client saved: ${name}.`,
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
		case "currency": {
			const own = input.currency === INHERITED ? null : input.currency;
			if (own !== null && !isCurrencyCode(own)) return declined("Choose a currency.");
			return answer(
				await setClientCurrency(scope, user.id, input.clientId, own),
				(name) => `${name} is billed in ${own ?? "the organisation's currency"}.`,
			);
		}
		case "managers": {
			const [found] = await scope.clients.select((c) => eq(c.id, input.clientId), { limit: 1 });
			if (!found) throw notFound();
			const now = new Set((await managersByClient(scope)).get(found.id) ?? []);
			const wanted = new Set(input.managerIds);
			for (const userId of new Set([...now, ...wanted])) {
				if (now.has(userId) === wanted.has(userId)) continue;
				if (!(await setClientManager(scope, user.id, found.id, userId, wanted.has(userId)))) {
					return declined(MANAGER_NOT_A_MEMBER);
				}
			}
			return done(
				wanted.size === 0
					? `${found.name} has no account managers.`
					: `${found.name} has ${wanted.size === 1 ? "1 account manager" : `${wanted.size} account managers`}.`,
			);
		}
	}
}

/** What the page is told: what was done, why nothing was, or 404 for a client that is not here. */
function answer(result: ClientResult, said: (name: string) => string) {
	if (result === null) throw notFound();
	return result.ok ? done(said(result.name)) : declined(result.problem);
}

type Client = Route.ComponentProps["loaderData"]["clients"][number];

/** The sheets of this page. One is open at a time. */
type Task = "create" | "rename" | "archive" | "restore" | "currency" | "managers";

export default function Clients({ loaderData }: Route.ComponentProps) {
	const { clients, query, canManage } = loaderData;
	const organisation = useOrganisation();
	const [task, setTask] = useState<Task | null>(null);
	// Which client the open sheet is about. Kept after it closes, so the sheet
	// goes on saying the same thing while it leaves.
	const [client, setClient] = useState<Client | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	const close = () => setTask(null);
	const [search] = useSearchParams();

	// Finance reads the clients and changes none, so it is offered nothing to press.
	const create = canManage ? (
		<Button onPress={() => setTask("create")}>Create client</Button>
	) : null;

	const rows = (shown: Client[], archived: boolean) =>
		shown.length === 0 ? (
			<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
				{query !== ""
					? `No ${archived ? "archived" : "active"} client has “${query}” in its name or code.`
					: archived
						? canManage
							? "No archived clients. A client you archive is kept here, with its projects, and can be restored."
							: "No archived clients. A client an owner or admin archives is kept here, with its projects."
						: canManage
							? "No active clients. Restore one from Archived, or create one."
							: "No active clients. Owners and admins create and restore them."}
			</p>
		) : (
			// A client's name opens its sheet, which renames it and holds Archive or
			// Restore: two things, so no menu (docs/design-direction.md, rule 2).
			// Finance changes no client, so its names are text.
			<LedgerRows label={archived ? "Archived clients" : "Active clients"}>
				{shown.map((each) => (
					<LedgerRow
						key={each.id}
						title={
							canManage ? (
								// React Aria's button presses on key up, as every button that opens a
								// sheet here does, so the sheet's field keeps the focus it is given.
								<AriaButton
									aria-haspopup="dialog"
									className={cx(ACTION_LINK, "cursor-pointer text-start wrap-anywhere")}
									onPress={() => {
										setClient(each);
										setTask("rename");
									}}
								>
									{codedName(each.code, each.name)}
								</AriaButton>
							) : (
								<span className="wrap-anywhere">{codedName(each.code, each.name)}</span>
							)
						}
						detail={
							<span className="wrap-anywhere">
								{each.projects.length === 0
									? "No projects"
									: each.projects
											.map((project) => {
												const named = codedName(project.code, project.name);
												return project.archived ? `${named} (archived)` : named;
											})
											.join(", ")}
								{each.managers.length > 0 && (
									<span className="block">
										Account {each.managers.length === 1 ? "manager" : "managers"}:{" "}
										{each.managers.map((manager) => manager.name).join(", ")}
									</span>
								)}
							</span>
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
			<PageLead>The companies your projects are for.</PageLead>
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
								takes.{canManage ? "" : " Owners and admins create them."}
							</p>
							{create}
						</div>
					</Ledger>
				) : (
					<>
						{create}
						{mayManageIntegrations(organisation.role) && (
							<Link className={`ml-4 ${ACTION_LINK}`} to={importPath(organisation.slug, "clients")}>
								Import clients from a CSV
							</Link>
						)}
						<div className="mt-6">
							<FilterBar name="Filter clients" keep={keptTab(search)}>
								<FilterField label="Search clients" param={SEARCH_PARAM} />
							</FilterBar>
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
				<TextField
					label="Code"
					name="code"
					autoComplete="off"
					maxLength={CODE_MAX_LENGTH}
					validate={codeProblem}
					description="Optional, for example ACME. Shown first wherever the client appears."
				/>
			</FormSheet>

			<FormSheet
				title={`Currency of ${client?.name ?? "this client"}`}
				intent="currency"
				submitLabel="Save"
				isOpen={task === "currency"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="clientId" value={client?.id ?? ""} />
				<p>Its projects bill in it unless a project has its own. Rates already set keep theirs.</p>
				<Select
					key={`currency-${client?.id}`}
					label="Currency"
					name="currency"
					options={[
						{ id: INHERITED, label: "The organisation's" },
						...CURRENCIES.map((code) => ({ id: code, label: code })),
					]}
					defaultValue={client?.currency ?? INHERITED}
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
				<TextField
					key={`code-${client?.id}`}
					label="Code"
					name="code"
					defaultValue={client?.code ?? ""}
					autoComplete="off"
					maxLength={CODE_MAX_LENGTH}
					validate={codeProblem}
					description="Optional, for example ACME. Shown first wherever the client appears."
				/>
				{/* Its account managers create its projects (decision 42): a sheet of their own. */}
				<div className="flex flex-col items-start gap-2 border-t border-outline-variant pt-4">
					<p className="text-body-medium text-on-surface-variant">
						{client?.managers.length
							? `Account ${client.managers.length === 1 ? "manager" : "managers"}: ${client.managers.map((m) => m.name).join(", ")}. They create its projects.`
							: "No account managers. An account manager creates the client's projects."}
					</p>
					<Button variant="outlined" onPress={() => setTask("managers")}>
						Change account managers
					</Button>
				</div>
				{/* The currency it bills in has its own sheet, as archiving does (TS-067). */}
				<div className="flex flex-col items-start gap-2 border-t border-outline-variant pt-4">
					<p className="text-body-medium text-on-surface-variant">
						{client?.currency
							? `Billed in ${client.currency}.`
							: "Billed in the organisation's currency."}
					</p>
					<Button variant="outlined" onPress={() => setTask("currency")}>
						Change currency
					</Button>
				</div>
				{/* Archiving is not renaming: it opens its own sheet, which says what it does. */}
				<div className="flex flex-col items-start gap-2 border-t border-outline-variant pt-4">
					<p className="text-body-medium text-on-surface-variant">
						{client?.archived
							? "Archived. Restore it and projects can be given it again."
							: "No longer working with them? Archive it; its projects keep it."}
					</p>
					<Button
						variant="outlined"
						onPress={() => setTask(client?.archived ? "restore" : "archive")}
					>
						{client?.archived ? "Restore client" : "Archive client"}
					</Button>
				</div>
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

			<FormSheet
				title={`Account managers of ${client?.name ?? "this client"}`}
				intent="managers"
				submitLabel="Save"
				isOpen={task === "managers"}
				onClose={close}
				onDone={setSaid}
			>
				<input type="hidden" name="clientId" value={client?.id ?? ""} />
				<p>
					An account manager creates the client's projects, and only the client's. Owners and admins
					create any project.
				</p>
				<fieldset className="flex flex-col" key={`managers-${client?.id}`}>
					<legend className="pb-1 text-title-medium">Account managers</legend>
					{loaderData.members.map((member) => (
						<Checkbox
							key={member.id}
							name="managerIds"
							value={member.id}
							defaultSelected={client?.managers.some((m) => m.id === member.id) ?? false}
						>
							{member.name}
						</Checkbox>
					))}
				</fieldset>
			</FormSheet>
		</>
	);
}
