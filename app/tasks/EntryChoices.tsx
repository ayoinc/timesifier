import { use, useState } from "react";

import { Select } from "~/components/Select";
import { ProjectPicker } from "~/projects/ProjectPicker";
import { useTerms } from "~/routes/app/useOrganisation";
import { TagPicker } from "~/tags/TagPicker";
import { inTerms } from "~/workspace/work-model";

import { OVER_BUDGET, TASK_FIELD, TrackChoicesContext } from "./track";

export interface EntryChoicesProps {
	/** The projects offered, by name, each with its code (TS-115a). */
	projects: readonly { id: string; name: string; code: string | null }[];
	/** The project chosen to start with. */
	defaultProjectId: string | null;
	/** The entry being changed, whose task and tags the fields start at; absent for a new one. */
	entryId?: string;
	/** Puts the focus in the project field when the sheet opens. */
	autoFocusProject?: boolean;
}

/**
 * An entry's project, its task from that project's list, and its tags
 * (TS-066, TS-085), as Track time and an entry's sheet ask for them. The task
 * follows the project: choosing another project offers its tasks. An entry
 * keeps a task archived or taken off the list since; a new one is offered
 * the active ones alone. Choosing a project whose budget is over, where its
 * people are warned, says so (TS-069); the entry still saves.
 */
export function EntryChoices({
	projects,
	defaultProjectId,
	entryId,
	autoFocusProject,
}: EntryChoicesProps) {
	const choices = use(TrackChoicesContext);
	const terms = useTerms();
	const [projectId, setProjectId] = useState<string | null>(defaultProjectId);
	const own = entryId === undefined ? undefined : choices?.entries[entryId];
	const keeps = projectId === defaultProjectId ? (own?.taskId ?? null) : null;
	const tasks = (projectId === null ? [] : (choices?.tasks[projectId] ?? [])).filter(
		(task) => !task.archived || task.id === keeps,
	);
	const firstActive = tasks.find((task) => !task.archived)?.id ?? null;
	const startsAt = keeps !== null && tasks.some((task) => task.id === keeps) ? keeps : firstActive;
	const [taskId, setTaskId] = useState<string | null>(startsAt);
	// A task of another project is no choice here: the field moves to this project's first.
	const shownTask = tasks.some((task) => task.id === taskId) ? taskId : startsAt;
	// Under Internal work nothing is billable, so nothing says so (TS-115a).
	const billable = terms.clients
		? tasks.find((task) => task.id === shownTask)?.billable
		: undefined;
	const over = projectId !== null && (choices?.overBudget.includes(projectId) ?? false);

	return (
		<>
			<ProjectPicker
				name="projectId"
				projects={projects.map((p) => {
					const choice = choices?.projects[p.id];
					return {
						id: p.id,
						name: p.name,
						code: p.code,
						clientName: choice?.client?.name ?? null,
						clientCode: choice?.client?.code ?? null,
						workCode: choice?.workCode ?? false,
					};
				})}
				recent={choices?.recent}
				pinned={choices?.pinned}
				value={projectId}
				onChange={setProjectId}
				autoFocus={autoFocusProject}
				isRequired
			/>
			{over && (
				<p
					role="note"
					className="rounded-medium border-2 border-on-surface px-4 py-3 text-body-large"
				>
					{inTerms(OVER_BUDGET, terms)} You can still track time to it.
				</p>
			)}
			{choices && tasks.length > 0 && (
				<Select
					key={projectId ?? ""}
					label="Task"
					name={TASK_FIELD}
					options={tasks.map((task) => ({
						id: task.id,
						label: task.archived ? `${task.name} (archived)` : task.name,
					}))}
					value={shownTask}
					onChange={setTaskId}
					description={billable === undefined ? undefined : billable ? "Billable" : "Not billable"}
					isRequired
				/>
			)}
			{choices && <TagPicker tags={choices.tags} selected={own?.tagIds ?? []} />}
		</>
	);
}
