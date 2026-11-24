import { use, useState } from "react";
import { useFetcher } from "react-router";

import { Button } from "~/components/Button";
import { Select } from "~/components/Select";
import { codedName } from "~/lib/codes";
import { ProjectPicker } from "~/projects/ProjectPicker";
import { JOIN_INTENT, JOIN_LABEL, joinNote, mayJoin, onTeam } from "~/projects/teams";
import { WORK_PACKAGE_FIELD } from "~/projects/work-packages";
import { useOrganisation, useTerms } from "~/routes/app/useOrganisation";
import { TagPicker } from "~/tags/TagPicker";
import type { Day } from "~/time/calendar";
import { timerAction } from "~/timesheet/views";
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
	/** The entry's day (TS-115c), whose team the project is asked of; left out, today. */
	day?: Day;
}

/**
 * An entry's project, its task from that project's list, and its tags
 * (TS-066, TS-085), as Track time and an entry's sheet ask for them. The task
 * follows the project: choosing another project offers its tasks. An entry
 * keeps a task archived or taken off the list since; a new one is offered
 * the active ones alone. Choosing a project whose budget is over, where its
 * people are warned, says so (TS-069); the entry still saves. A project with
 * open work packages is chosen by one of them (TS-115b); an entry keeps a
 * work package closed since, the one it has, and a new one is offered the
 * open ones alone. The person's own projects come first (TS-115c); where only
 * a project's team tracks to it, a project they are not on the team of on
 * the day is offered only to those who may add themselves to it, with the
 * button that does, and to nobody else, unless it is the entry's own.
 */
export function EntryChoices({
	projects,
	defaultProjectId,
	entryId,
	autoFocusProject,
	day,
}: EntryChoicesProps) {
	const choices = use(TrackChoicesContext);
	const terms = useTerms();
	const team = choices?.team;
	const onDay = day ?? team?.today;
	const mine = (id: string) => team !== undefined && onDay !== undefined && onTeam(team, id, onDay);
	const assigned = projects.filter((p) => mine(p.id)).map((p) => p.id);
	const byAssignment = team?.tracking === "assigned";
	const joinable = byAssignment
		? projects.filter((p) => !mine(p.id) && mayJoin(team, p.id)).map((p) => p.id)
		: [];
	// An entry keeps its own project, whatever its team; a new one is offered what may take it.
	const offered = byAssignment
		? projects.filter(
				(p) =>
					mine(p.id) ||
					joinable.includes(p.id) ||
					(entryId !== undefined && p.id === defaultProjectId),
			)
		: projects;
	const startsOn =
		entryId !== undefined || defaultProjectId === null || !byAssignment || mine(defaultProjectId)
			? defaultProjectId
			: (assigned[0] ?? null);
	const [projectId, setProjectId] = useState<string | null>(startsOn);
	const own = entryId === undefined ? undefined : choices?.entries[entryId];
	const [workPackageId, setWorkPackageId] = useState<string | null>(own?.workPackageId ?? null);
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
				workPackageName={WORK_PACKAGE_FIELD}
				projects={offered.map((p) => {
					const choice = choices?.projects[p.id];
					return {
						id: p.id,
						name: p.name,
						code: p.code,
						clientName: choice?.client?.name ?? null,
						clientCode: choice?.client?.code ?? null,
						workCode: choice?.workCode ?? false,
						workPackages: (choices?.workPackages[p.id] ?? []).filter(
							(wp) =>
								wp.open || (p.id === defaultProjectId && wp.id === (own?.workPackageId ?? null)),
						),
					};
				})}
				recent={choices?.recent}
				pinned={choices?.pinned}
				assigned={assigned}
				joinable={joinable}
				value={projectId}
				workPackageId={workPackageId}
				onChange={(id, wp) => {
					setProjectId(id);
					setWorkPackageId(wp);
				}}
				autoFocus={autoFocusProject}
				isRequired
			/>
			{projectId !== null && onDay !== undefined && joinable.includes(projectId) && (
				<JoinTeam project={projects.find((p) => p.id === projectId) ?? null} day={onDay} />
			)}
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

/**
 * Where only a project's team tracks to it, the note that the person is not
 * on the chosen project's team on the day, and the one step that adds them
 * (TS-115c): an owner or an admin, or one of its delivery managers. Nothing
 * is let in silently: the button says what it does, and the change is
 * recorded as theirs.
 */
function JoinTeam({
	project,
	day,
}: {
	project: { id: string; name: string; code: string | null } | null;
	day: Day;
}) {
	const fetcher = useFetcher();
	const organisation = useOrganisation();
	if (project === null) return null;
	const answer = fetcher.data as { ok: boolean; problem?: string } | undefined;
	return (
		<div
			role="note"
			className="flex flex-col items-start gap-2 rounded-medium border-2 border-on-surface px-4 py-3 text-body-large"
		>
			<p>{joinNote(codedName(project.code, project.name))}</p>
			<Button
				variant="outlined"
				isPending={fetcher.state !== "idle"}
				onPress={() =>
					fetcher.submit(
						{ intent: JOIN_INTENT, projectId: project.id, day },
						{ method: "post", action: timerAction(organisation.slug) },
					)
				}
			>
				{JOIN_LABEL}
			</Button>
			{answer && !answer.ok && answer.problem && (
				<p role="alert" className="text-body-medium text-error">
					{answer.problem}
				</p>
			)}
		</div>
	);
}
