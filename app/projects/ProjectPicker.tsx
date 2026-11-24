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
import { codedName } from "~/lib/codes";
import { PINNED_TITLE } from "~/pins/pins";
import { useTerms } from "~/routes/app/useOrganisation";
import { CLIENT_PROJECT_TERMS, inTerms, type Terms } from "~/workspace/work-model";

// The project of an entry or an expense, chosen by typing part of its code,
// its name, or its client's name or code (Harvest's project picker,
// research/harvest-taste.md item 5; codes TS-115a). The list opens with the
// projects the person pinned (TS-122, S2-09), then their recent projects, then
// the rest under their clients, A to Z. It is the Material 3 filled field of
// Select and TextField (see components/field.ts) over React Aria's ComboBox,
// whose server HTML has no `style` attribute; the form receives the project's
// id from a hidden input (`formValue="key"`), never the text typed. Every word
// of it is the organisation's (TS-115a).

/** A project the picker offers. The caller leaves archived projects out. */
export interface PickerProject {
	id: string;
	name: string;
	clientName: string | null;
	/** The project's code, shown before its name (TS-115a). */
	code?: string | null;
	clientCode?: string | null;
	/** A project with no client that is not billable: grouped apart where the organisation works by both. */
	workCode?: boolean;
}

/** A project as the list and the field name it: its code, then its name. */
export function pickerLabel(project: PickerProject): string {
	return codedName(project.code, project.name);
}

/** A project's client as the list names it, its code first; null without one. */
function clientLabel(project: PickerProject): string | null {
	return project.clientName === null ? null : codedName(project.clientCode, project.clientName);
}

export interface ProjectPickerProps {
	/** Names the field: "Project", or the organisation's own word for it. */
	label?: string;
	/** The field's name when submitted with a form; the value sent is the project's id. */
	name: string;
	projects: readonly PickerProject[];
	/** The ids of the person's recent projects, most recent first; at most five are shown. */
	recent?: readonly string[];
	/** The ids of the projects the person pinned; all are shown, first, A to Z. */
	pinned?: readonly string[];
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
 * The list as shown for what is typed: the pinned projects first, A to Z,
 * then up to five recent projects, then each client's projects, clients A to
 * Z and projects A to Z within them, and the projects without a client last. A
 * project is listed once: a pinned one is not repeated as recent, nor either
 * under its client. Where the organisation works by both, its work codes
 * follow in a section of their own; where it shows no clients, every project
 * not above is in one section under its own word for them (TS-115a). What is
 * typed keeps the projects whose code, name, client's name or client's code
 * holds it, in any case; an empty query keeps every one. Sections left
 * empty are dropped.
 */
export function projectSections(
	projects: readonly PickerProject[],
	recent: readonly string[],
	query: string,
	terms: Terms = CLIENT_PROJECT_TERMS,
	pinned: readonly string[] = [],
): ProjectSection[] {
	const needle = query.trim().toLocaleLowerCase();
	const holds = (text: string | null | undefined) =>
		text?.toLocaleLowerCase().includes(needle) ?? false;
	const matches = (project: PickerProject) =>
		needle === "" ||
		holds(pickerLabel(project)) ||
		(terms.clients && (holds(project.clientName) || holds(project.clientCode)));
	const byLabel = (a: PickerProject, b: PickerProject) =>
		pickerLabel(a).localeCompare(pickerLabel(b));

	const byId = new Map(projects.map((project) => [project.id, project]));
	const isPinned = new Set(pinned);
	const pinnedProjects = projects.filter((project) => isPinned.has(project.id)).sort(byLabel);
	const recentProjects: PickerProject[] = [];
	for (const id of recent) {
		const project = byId.get(id);
		if (!project || recentProjects.includes(project) || isPinned.has(id)) continue;
		recentProjects.push(project);
		if (recentProjects.length === RECENT_LIMIT) break;
	}
	const isAbove = new Set([...pinnedProjects, ...recentProjects].map((project) => project.id));
	const rest = projects.filter((project) => !isAbove.has(project.id) && matches(project));
	const above = [
		{ id: "pinned", title: PINNED_TITLE, projects: pinnedProjects.filter(matches) },
		{ id: "recent", title: RECENT_TITLE, projects: recentProjects.filter(matches) },
	];

	if (!terms.clients) {
		return [...above, { id: "all", title: terms.Projects, projects: rest.sort(byLabel) }].filter(
			(section) => section.projects.length > 0,
		);
	}

	const groups = new Map<string, PickerProject[]>();
	const noClient: PickerProject[] = [];
	const workCodes: PickerProject[] = [];
	for (const project of rest) {
		const client = clientLabel(project);
		if (client !== null) {
			const group = groups.get(client);
			if (group) group.push(project);
			else groups.set(client, [project]);
		} else if (terms.model === "both" && project.workCode) workCodes.push(project);
		else noClient.push(project);
	}

	const sections: ProjectSection[] = [
		...above,
		...[...groups]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([client, list]) => ({
				id: `client:${client}`,
				title: client,
				projects: list.sort(byLabel),
			})),
		{ id: "no-client", title: NO_CLIENT_TITLE, projects: noClient.sort(byLabel) },
		{ id: "work-codes", title: terms.WorkCodes, projects: workCodes.sort(byLabel) },
	];
	return sections.filter((section) => section.projects.length > 0);
}

/**
 * A field that chooses one project. Typing filters by code, project or
 * client; the arrow keys move through the list, Enter chooses, Escape puts
 * back the project chosen before. The field shows the chosen project's code
 * and name.
 */
export function ProjectPicker({
	label,
	name,
	projects,
	recent = [],
	pinned = [],
	value,
	onChange,
	isRequired,
	autoFocus,
	description,
}: ProjectPickerProps) {
	const terms = useTerms();
	// What the person has typed since they last chose; null shows the chosen project's name.
	const [query, setQuery] = useState<string | null>(null);
	const chosen = projects.find((project) => project.id === value) ?? null;
	const sections = projectSections(projects, recent, query ?? "", terms, pinned);

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
			inputValue={query ?? (chosen ? pickerLabel(chosen) : "")}
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
								{label ?? terms.Project}
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
										{inTerms(NO_MATCH, terms)}
									</p>
								)}
							>
								{(section) => (
									<ListBoxSection id={section.id} className="flex flex-col gap-0.5">
										<Header className="px-4 pt-3 pb-1 text-label-medium text-on-surface-variant">
											{section.title}
										</Header>
										<Collection items={section.projects}>
											{(project) => <ProjectOption project={project} showsClient={terms.clients} />}
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

function ProjectOption({ project, showsClient }: { project: PickerProject; showsClient: boolean }) {
	const client = showsClient ? clientLabel(project) : null;
	return (
		<ListBoxItem
			id={project.id}
			textValue={pickerLabel(project)}
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
				// The client line is part of the option's name, as it is of what is
				// seen (WCAG 2.5.3): "ACME-001 · Website ACME · Acme".
				<Text slot="label" className="flex min-w-0 flex-col">
					<span className="truncate text-label-large">{pickerLabel(project)}</span>
					{client !== null && (
						<span
							className={cx(
								"truncate text-body-medium",
								isSelected ? "text-on-tertiary-container" : "text-on-surface-variant",
							)}
						>
							{client}
						</span>
					)}
				</Text>
			)}
		</ListBoxItem>
	);
}
