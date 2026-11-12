import { useState } from "react";
import {
	Button,
	Collection,
	ComboBox,
	FieldError,
	Header,
	Input,
	Label,
	ListBox,
	ListBoxItem,
	ListBoxSection,
	Popover,
	Text,
} from "react-aria-components";

import { cx } from "~/components/cx";
import {
	FIELD_CONTROL,
	FIELD_ERROR,
	fieldContainer,
	fieldIndicator,
	fieldLabel,
	fieldSupporting,
} from "~/components/field";
import { ArrowDropDownIcon } from "~/components/icons/ArrowDropDownIcon";
import { POPOVER_MOTION } from "~/components/motion";

// The project of an entry or an expense, chosen by typing part of its name or
// its client's (Harvest's project picker, research/harvest-taste.md item 5).
// The list opens with the person's recent projects, then the rest under their
// clients, A to Z. It is the Material 3 filled field of Select and TextField
// (see components/field.ts) over React Aria's ComboBox, whose server HTML has
// no `style` attribute; the form receives the project's id from a hidden input
// (`formValue="key"`), never the text typed.

/** A project the picker offers. The caller leaves archived projects out. */
export interface PickerProject {
	id: string;
	name: string;
	clientName: string | null;
}

export interface ProjectPickerProps {
	/** Names the field: "Project". */
	label?: string;
	/** The field's name when submitted with a form; the value sent is the project's id. */
	name: string;
	projects: readonly PickerProject[];
	/** The ids of the person's recent projects, most recent first; at most five are shown. */
	recent?: readonly string[];
	/** The chosen project's id. */
	value: string | null;
	/** Called with the id of the project the person chose. */
	onChange: (id: string | null) => void;
	isRequired?: boolean;
	autoFocus?: boolean;
	/** Supporting text under the field. */
	description?: string;
}

/** A heading of the list and the projects under it. */
export interface ProjectSection {
	id: string;
	title: string;
	projects: PickerProject[];
}

/** How many recent projects head the list. */
export const RECENT_LIMIT = 5;
export const RECENT_TITLE = "Recent";
export const NO_CLIENT_TITLE = "No client";
export const NO_MATCH = "No project matches";

/**
 * The list as shown for what is typed: up to five recent projects first, then
 * each client's projects, clients A to Z and projects A to Z within them, and
 * the projects without a client last. A recent project is not repeated under
 * its client. What is typed keeps the projects whose name or client's name
 * holds it, in any case; an empty query keeps every one. Sections left empty
 * are dropped.
 */
export function projectSections(
	projects: readonly PickerProject[],
	recent: readonly string[],
	query: string,
): ProjectSection[] {
	const needle = query.trim().toLocaleLowerCase();
	const matches = (project: PickerProject) =>
		needle === "" ||
		project.name.toLocaleLowerCase().includes(needle) ||
		(project.clientName?.toLocaleLowerCase().includes(needle) ?? false);

	const byId = new Map(projects.map((project) => [project.id, project]));
	const recentProjects: PickerProject[] = [];
	for (const id of recent) {
		const project = byId.get(id);
		if (!project || recentProjects.includes(project)) continue;
		recentProjects.push(project);
		if (recentProjects.length === RECENT_LIMIT) break;
	}
	const isRecent = new Set(recentProjects.map((project) => project.id));

	const groups = new Map<string, PickerProject[]>();
	const noClient: PickerProject[] = [];
	for (const project of projects) {
		if (isRecent.has(project.id) || !matches(project)) continue;
		if (project.clientName === null) {
			noClient.push(project);
			continue;
		}
		const group = groups.get(project.clientName);
		if (group) group.push(project);
		else groups.set(project.clientName, [project]);
	}

	const sections: ProjectSection[] = [
		{ id: "recent", title: RECENT_TITLE, projects: recentProjects.filter(matches) },
		...[...groups]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([client, list]) => ({
				id: `client:${client}`,
				title: client,
				projects: list.sort((a, b) => a.name.localeCompare(b.name)),
			})),
		{
			id: "no-client",
			title: NO_CLIENT_TITLE,
			projects: noClient.sort((a, b) => a.name.localeCompare(b.name)),
		},
	];
	return sections.filter((section) => section.projects.length > 0);
}

/**
 * A field that chooses one project. Typing filters by project or client;
 * the arrow keys move through the list, Enter chooses, Escape puts back the
 * project chosen before. The field shows the chosen project's name.
 */
export function ProjectPicker({
	label = "Project",
	name,
	projects,
	recent = [],
	value,
	onChange,
	isRequired,
	autoFocus,
	description,
}: ProjectPickerProps) {
	// What the person has typed since they last chose; null shows the chosen project's name.
	const [query, setQuery] = useState<string | null>(null);
	const chosen = projects.find((project) => project.id === value) ?? null;
	const sections = projectSections(projects, recent, query ?? "");

	return (
		<ComboBox
			name={name}
			formValue="key"
			items={sections}
			selectedKey={chosen?.id ?? null}
			onSelectionChange={(key) => {
				setQuery(null);
				onChange(key === null ? null : `${key}`);
			}}
			inputValue={query ?? chosen?.name ?? ""}
			onInputChange={setQuery}
			onOpenChange={(isOpen) => {
				if (!isOpen) setQuery(null);
			}}
			allowsEmptyCollection
			isRequired={isRequired}
			className="relative flex flex-col gap-1"
		>
			{({ isInvalid, isDisabled, isOpen, isRequired: required }) => {
				const field = { isInvalid, isDisabled, isActive: isOpen };
				return (
					<>
						<div className={fieldContainer(field)}>
							{/* The one-space placeholder lets the label tell an empty input from a filled one. */}
							<Input
								placeholder=" "
								autoFocus={autoFocus}
								className={cx(
									FIELD_CONTROL,
									"ps-4 pe-12 pt-6 pb-2 text-body-large",
									isInvalid ? "caret-error" : "caret-primary",
								)}
							/>
							<Label
								className={cx(
									fieldLabel(field),
									"end-12",
									!isOpen &&
										"peer-placeholder-shown:group-not-has-data-focused/field:top-4 peer-placeholder-shown:group-not-has-data-focused/field:text-body-large",
								)}
							>
								{label}
								{required && <span aria-hidden="true"> *</span>}
							</Label>
							<Button className="absolute inset-y-0 end-0 flex w-12 cursor-pointer items-center justify-center pt-2 outline-none disabled:cursor-not-allowed">
								<ArrowDropDownIcon
									className={cx(
										"transition motion-reduce:transition-none",
										isOpen && "rotate-180",
										!isDisabled && (isInvalid ? "text-error" : "text-on-surface-variant"),
									)}
								/>
							</Button>
							<span className={fieldIndicator(field)} />
						</div>
						{description && !isInvalid && (
							<Text slot="description" className={fieldSupporting(field)}>
								{description}
							</Text>
						)}
						<FieldError className={FIELD_ERROR} />
						<Popover
							placement="bottom start"
							offset={4}
							className={cx(
								POPOVER_MOTION,
								"w-(--trigger-width) overflow-auto rounded-large bg-surface-container-low shadow-level2 outline-none",
							)}
						>
							<ListBox<ProjectSection>
								className="flex flex-col gap-0.5 p-1 outline-none"
								renderEmptyState={() => (
									<p className="flex min-h-12 items-center px-4 text-body-large text-on-surface-variant">
										{NO_MATCH}
									</p>
								)}
							>
								{(section) => (
									<ListBoxSection id={section.id} className="flex flex-col gap-0.5">
										<Header className="px-4 pt-3 pb-1 text-label-medium text-on-surface-variant">
											{section.title}
										</Header>
										<Collection items={section.projects}>
											{(project) => <ProjectOption project={project} />}
										</Collection>
									</ListBoxSection>
								)}
							</ListBox>
						</Popover>
					</>
				);
			}}
		</ComboBox>
	);
}

function ProjectOption({ project }: { project: PickerProject }) {
	return (
		<ListBoxItem
			id={project.id}
			textValue={project.name}
			className={({ isSelected }) =>
				cx(
					"flex min-h-12 cursor-pointer select-none flex-col justify-center px-4 py-1 outline-none state-layer transition-control",
					"data-focused:state-hover data-focus-visible:state-focus data-focus-visible:focus-indicator-inner data-pressed:state-pressed",
					isSelected
						? "rounded-medium over-tertiary-container text-on-tertiary-container"
						: "rounded-extra-small text-on-surface",
				)
			}
		>
			{({ isSelected }) => (
				<>
					<Text slot="label" className="truncate text-label-large">
						{project.name}
					</Text>
					{project.clientName !== null && (
						<Text
							slot="description"
							className={cx(
								"truncate text-body-medium",
								isSelected ? "text-on-tertiary-container" : "text-on-surface-variant",
							)}
						>
							{project.clientName}
						</Text>
					)}
				</>
			)}
		</ListBoxItem>
	);
}
