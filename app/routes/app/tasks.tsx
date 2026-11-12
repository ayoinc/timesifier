import { env } from "cloudflare:workers";
import { useState } from "react";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Checkbox } from "~/components/Checkbox";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { LinkTabs } from "~/components/LinkTabs";
import { Menu, MenuItem, MenuTrigger } from "~/components/Menu";
import { TextField } from "~/components/TextField";
import { organisationScope } from "~/db";
import { RECORD_NAME_MAX_LENGTH, recordNameProblem } from "~/lib/names";
import { parseRequest } from "~/lib/validate";
import { mayManageTasks } from "~/organisations/access";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";
import { ArchiveTabs } from "~/projects/ArchiveTabs";
import { onlyTabChanged } from "~/projects/projects";
import { destination, destinationPath } from "~/shell/destinations";
import { PageHeading, PageLead } from "~/shell/PageHeading";
import { createTag, listTags, renameTag, setTagArchived, type TagResult } from "~/tags/tags.server";
import {
	changeTask,
	createTask,
	listTasks,
	setTaskArchived,
	type TaskResult,
} from "~/tasks/tasks.server";

import type { Route } from "./+types/tasks";
import { FormSheet } from "./FormSheet";
import { useOrganisation } from "./useOrganisation";

// Tasks (TS-066, B4): the kinds of work the organisation's time is tracked
// to, each billable by default or not, and common (put on every new project)
// or not; and its tags (TS-085), which categorise entries, expenses and
// projects. Owners and admins keep both lists (`mayManageTasks`): the page is
// shown to nobody else (app/shell/destinations.ts), and its action refuses
// anybody else. Nothing is deleted: a task or a tag is archived, and what
// has it keeps it.

const { label } = destination("tasks");

/** The query that picks the list: tasks, or `?list=tags`. */
const LIST_PARAM = "list";
const TAGS = "tags";

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const membership = context.get(membershipContext);
	if (!mayManageTasks(membership.role)) throw notFound();
	const scope = organisationScope(env.DB, membership.organisation.id);
	const list = new URL(request.url).searchParams.get(LIST_PARAM) === TAGS ? "tags" : "tasks";
	const [tasks, tags] = await Promise.all([listTasks(scope), listTags(scope)]);
	return { list, tasks, tags } as const;
}

/** Moving between Active and Archived reads nothing again: the loader sent both lists. */
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
const Flag = z
	.enum(["on", "true", "false", ""])
	.optional()
	.transform((value) => value === "on" || value === "true");

const form = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("create"),
		name: Name,
		billableByDefault: Flag,
		common: Flag,
		addToAllProjects: Flag,
	}),
	z.object({
		intent: z.literal("change"),
		taskId: Id,
		name: Name,
		billableByDefault: Flag,
		common: Flag,
	}),
	z.object({ intent: z.literal("archive"), taskId: Id }),
	z.object({ intent: z.literal("restore"), taskId: Id }),
	z.object({ intent: z.literal("create-tag"), name: Name }),
	z.object({ intent: z.literal("rename-tag"), tagId: Id, name: Name }),
	z.object({ intent: z.literal("archive-tag"), tagId: Id }),
	z.object({ intent: z.literal("restore-tag"), tagId: Id }),
]);

/**
 * Creates, changes, archives or restores a task or a tag of the organisation
 * in the address. One of another organisation is none here: 404, and nothing
 * changes. To a manager, Finance or a member, Tasks is a destination they are
 * not shown, so the organisation's layout answers 404 before this runs; the
 * 403 below is the rule's own check should that ever change.
 */
export async function action({ request, context }: Route.ActionArgs) {
	const input = await parseRequest(request, form);
	const membership = context.get(membershipContext);
	if (!mayManageTasks(membership.role)) return declined(NOT_ALLOWED, 403);
	const scope = organisationScope(env.DB, membership.organisation.id);
	const actor = membership.user.id;

	switch (input.intent) {
		case "create":
			return answer(await createTask(scope, actor, input), (name) => `Task created: ${name}.`);
		case "change":
			return answer(
				await changeTask(scope, actor, input.taskId, input),
				(name) => `Task saved: ${name}.`,
			);
		case "archive":
			return answer(
				await setTaskArchived(scope, actor, input.taskId, true),
				(name) => `${name} is archived. No new entry can have it; its entries keep it.`,
			);
		case "restore":
			return answer(
				await setTaskArchived(scope, actor, input.taskId, false),
				(name) => `${name} is restored.`,
			);
		case "create-tag":
			return answer(await createTag(scope, actor, input.name), (name) => `Tag created: ${name}.`);
		case "rename-tag":
			return answer(
				await renameTag(scope, actor, input.tagId, input.name),
				(name) => `Tag saved: ${name}.`,
			);
		case "archive-tag":
			return answer(
				await setTagArchived(scope, actor, input.tagId, true),
				(name) => `${name} is archived. It can be added to nothing new; what has it keeps it.`,
			);
		case "restore-tag":
			return answer(
				await setTagArchived(scope, actor, input.tagId, false),
				(name) => `${name} is restored.`,
			);
	}
}

/** What the page is told: what was done, why nothing was, or 404 for something that is not here. */
function answer(result: TaskResult | TagResult, said: (name: string) => string) {
	if (result === null) throw notFound();
	return result.ok ? done(said(result.name)) : declined(result.problem);
}

type Data = Route.ComponentProps["loaderData"];
type Task = Data["tasks"][number];
type Tag = Data["tags"][number];

/** An empty list's sentence, in the ledger's place. */
function Empty({ children }: { children: string }) {
	return (
		<p className="border-t border-outline-variant px-4 py-6 text-body-large text-on-surface-variant @sm:px-5">
			{children}
		</p>
	);
}

export default function Tasks({ loaderData }: Route.ComponentProps) {
	const { list } = loaderData;
	const [said, setSaid] = useState<string | null>(null);
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<PageLead>
				The kinds of work your projects are made of, whether each is billed, and the tags that sort
				time, expenses and projects.
			</PageLead>
			<p role="status" className="mt-4 text-body-medium text-on-surface-variant empty:hidden">
				{said}
			</p>
			<TabsOfList list={list} />
			<div className="mt-6 max-w-200">
				{list === "tasks" ? (
					<TaskList tasks={loaderData.tasks} onSaid={setSaid} />
				) : (
					<TagList tags={loaderData.tags} onSaid={setSaid} />
				)}
			</div>
		</>
	);
}

function TabsOfList({ list }: { list: "tasks" | "tags" }) {
	const { slug } = useOrganisation();
	const base = destinationPath(slug, "tasks");
	return (
		<div className="mt-6">
			<LinkTabs
				label="Tasks and tags"
				tabs={[
					{ id: "tasks", label: "Tasks", to: base },
					{ id: "tags", label: "Tags", to: `${base}?${LIST_PARAM}=${TAGS}` },
				]}
				current={list}
			/>
		</div>
	);
}

function TaskList({ tasks, onSaid }: { tasks: Task[]; onSaid: (said: string) => void }) {
	const [sheet, setSheet] = useState<"create" | "change" | "archive" | "restore" | null>(null);
	const [task, setTask] = useState<Task | null>(null);
	const close = () => setSheet(null);
	const create = <Button onPress={() => setSheet("create")}>Create task</Button>;

	const rows = (shown: Task[], archived: boolean) =>
		shown.length === 0 ? (
			<Empty>
				{archived
					? "No archived tasks. A task you archive is kept here, with its entries, and can be restored."
					: "No active tasks. Create one, or restore one from Archived."}
			</Empty>
		) : (
			<LedgerRows label={archived ? "Archived tasks" : "Active tasks"}>
				{shown.map((each) => (
					<LedgerRow
						key={each.id}
						title={<span className="wrap-anywhere">{each.name}</span>}
						detail={[
							each.billableByDefault ? "Billable by default" : "Non-billable by default",
							each.common ? "On every new project" : null,
							`${each.projects} ${each.projects === 1 ? "project" : "projects"}`,
						]
							.filter(Boolean)
							.join(" · ")}
						action={
							<MenuTrigger>
								<Button variant="text" aria-label={`Actions for ${each.name}`}>
									Actions
								</Button>
								<Menu
									onAction={(chosen) => {
										setTask(each);
										setSheet(chosen === "change" ? "change" : archived ? "restore" : "archive");
									}}
								>
									<MenuItem id="change">Edit</MenuItem>
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

	const active = tasks.filter((t) => !t.archived);
	const archived = tasks.filter((t) => t.archived);
	return (
		<>
			{tasks.length === 0 ? (
				<Ledger heading="Tasks" note={0}>
					<div className="flex flex-col items-start gap-4 border-t border-outline-variant px-4 py-6 @sm:px-5">
						<h2 className="text-title-large">No tasks yet</h2>
						<p className="max-w-160 text-body-large text-on-surface-variant">
							A task is a kind of work, such as Design or Meetings, and says whether it is billed.
						</p>
						{create}
					</div>
				</Ledger>
			) : (
				<>
					{create}
					<div className="mt-6">
						<ArchiveTabs
							label="Tasks"
							active={
								<Ledger heading="Active tasks" note={active.length}>
									{rows(active, false)}
								</Ledger>
							}
							archived={
								<Ledger heading="Archived tasks" note={archived.length}>
									{rows(archived, true)}
								</Ledger>
							}
						/>
					</div>
				</>
			)}

			<FormSheet
				title="Create a task"
				intent="create"
				submitLabel="Create the task"
				isOpen={sheet === "create"}
				onClose={close}
				onDone={onSaid}
			>
				<TextField
					label="Task name"
					name="name"
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
				<Checkbox name="billableByDefault" defaultSelected>
					Billable by default
				</Checkbox>
				<Checkbox name="common" defaultSelected>
					Put it on every new project
				</Checkbox>
				<Checkbox name="addToAllProjects">Put it on every project now</Checkbox>
			</FormSheet>

			<FormSheet
				title={`Edit ${task?.name ?? "this task"}`}
				intent="change"
				submitLabel="Save"
				isOpen={sheet === "change"}
				onClose={close}
				onDone={onSaid}
			>
				<input type="hidden" name="taskId" value={task?.id ?? ""} />
				<TextField
					key={`name-${task?.id}`}
					label="Task name"
					name="name"
					defaultValue={task?.name}
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
				<Checkbox
					key={`billable-${task?.id}`}
					name="billableByDefault"
					defaultSelected={task?.billableByDefault}
				>
					Billable by default
				</Checkbox>
				<Checkbox key={`common-${task?.id}`} name="common" defaultSelected={task?.common}>
					Put it on every new project
				</Checkbox>
				<p className="text-body-medium text-on-surface-variant">
					Whether it is billable on a project already is set on that project's Tasks.
				</p>
			</FormSheet>

			<FormSheet
				title={`Archive ${task?.name ?? "this task"}?`}
				intent="archive"
				submitLabel="Archive task"
				isOpen={sheet === "archive"}
				onClose={close}
				onDone={onSaid}
			>
				<input type="hidden" name="taskId" value={task?.id ?? ""} />
				<p>No new entry can have it. The entries that have it keep it, and it can be restored.</p>
			</FormSheet>

			<FormSheet
				title={`Restore ${task?.name ?? "this task"}?`}
				intent="restore"
				submitLabel="Restore task"
				isOpen={sheet === "restore"}
				onClose={close}
				onDone={onSaid}
			>
				<input type="hidden" name="taskId" value={task?.id ?? ""} />
				<p>It can be chosen for new entries again, on the projects that have it.</p>
			</FormSheet>
		</>
	);
}

function TagList({ tags, onSaid }: { tags: Tag[]; onSaid: (said: string) => void }) {
	const [sheet, setSheet] = useState<"create" | "rename" | "archive" | "restore" | null>(null);
	const [tag, setTag] = useState<Tag | null>(null);
	const close = () => setSheet(null);
	const create = <Button onPress={() => setSheet("create")}>Create tag</Button>;

	const rows = (shown: Tag[], archived: boolean) =>
		shown.length === 0 ? (
			<Empty>
				{archived
					? "No archived tags. A tag you archive stays on what has it, and can be restored."
					: "No active tags. Create one, or restore one from Archived."}
			</Empty>
		) : (
			<LedgerRows label={archived ? "Archived tags" : "Active tags"}>
				{shown.map((each) => (
					<LedgerRow
						key={each.id}
						title={<span className="wrap-anywhere">{each.name}</span>}
						detail={`${each.entries} ${each.entries === 1 ? "entry" : "entries"} · ${each.projects} ${
							each.projects === 1 ? "project" : "projects"
						}`}
						action={
							<MenuTrigger>
								<Button variant="text" aria-label={`Actions for ${each.name}`}>
									Actions
								</Button>
								<Menu
									onAction={(chosen) => {
										setTag(each);
										setSheet(chosen === "rename" ? "rename" : archived ? "restore" : "archive");
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

	const active = tags.filter((t) => !t.archived);
	const archived = tags.filter((t) => t.archived);
	return (
		<>
			{tags.length === 0 ? (
				<Ledger heading="Tags" note={0}>
					<div className="flex flex-col items-start gap-4 border-t border-outline-variant px-4 py-6 @sm:px-5">
						<h2 className="text-title-large">No tags yet</h2>
						<p className="max-w-160 text-body-large text-on-surface-variant">
							A tag sorts work across projects, such as Research or Support. People put them on
							their entries and expenses, and Reports filter by them.
						</p>
						{create}
					</div>
				</Ledger>
			) : (
				<>
					{create}
					<div className="mt-6">
						<ArchiveTabs
							label="Tags"
							active={
								<Ledger heading="Active tags" note={active.length}>
									{rows(active, false)}
								</Ledger>
							}
							archived={
								<Ledger heading="Archived tags" note={archived.length}>
									{rows(archived, true)}
								</Ledger>
							}
						/>
					</div>
				</>
			)}

			<FormSheet
				title="Create a tag"
				intent="create-tag"
				submitLabel="Create the tag"
				isOpen={sheet === "create"}
				onClose={close}
				onDone={onSaid}
			>
				<TextField
					label="Tag name"
					name="name"
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
			</FormSheet>

			<FormSheet
				title={`Rename ${tag?.name ?? "this tag"}`}
				intent="rename-tag"
				submitLabel="Save"
				isOpen={sheet === "rename"}
				onClose={close}
				onDone={onSaid}
			>
				<input type="hidden" name="tagId" value={tag?.id ?? ""} />
				<TextField
					key={`tag-${tag?.id}`}
					label="Tag name"
					name="name"
					defaultValue={tag?.name}
					autoComplete="off"
					autoFocus
					isRequired
					maxLength={RECORD_NAME_MAX_LENGTH}
					validate={recordNameProblem}
				/>
			</FormSheet>

			<FormSheet
				title={`Archive ${tag?.name ?? "this tag"}?`}
				intent="archive-tag"
				submitLabel="Archive tag"
				isOpen={sheet === "archive"}
				onClose={close}
				onDone={onSaid}
			>
				<input type="hidden" name="tagId" value={tag?.id ?? ""} />
				<p>It can be added to nothing new. What has it keeps it, and it can be restored.</p>
			</FormSheet>

			<FormSheet
				title={`Restore ${tag?.name ?? "this tag"}?`}
				intent="restore-tag"
				submitLabel="Restore tag"
				isOpen={sheet === "restore"}
				onClose={close}
				onDone={onSaid}
			>
				<input type="hidden" name="tagId" value={tag?.id ?? ""} />
				<p>It can be put on entries, expenses and projects again.</p>
			</FormSheet>
		</>
	);
}
