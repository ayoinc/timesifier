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

import { lineKey, lineOf, projectAndPackage, WORK_PACKAGE_REFUSALS } from "./work-packages";

// The project of an entry or an expense, chosen by typing part of its code,
// its name, or its client's name or code (Harvest's project picker,
// research/harvest-taste.md item 5; codes TS-115a). The list opens with the
// projects the person pinned (TS-122, S2-09), then their recent projects, then
// the rest under their clients, A to Z. It is the Material 3 filled field of
// Select and TextField (see components/field.ts) over React Aria's ComboBox,
// whose server HTML has no `style` attribute; the form receives the project's
// id from a hidden input, never the text typed. Every word of it is the
// organisation's (TS-115a). A project with open work packages is offered by
// each of them, "ACME-001 · Website rebuild › WP2 Build", found by the work
// package's code or name too, and a second hidden input sends the work
// package's id (TS-115b). The person's own projects, those whose team they
// are on, head the list (TS-115c); a project they may add themselves to's
// team, where only its team tracks to it, is offered last, apart.

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
	/**
	 * The work packages it is offered by (TS-115b); none, or left out, offers
	 * the project alone. Time goes to one of them, so the project is then not
	 * offered on its own.
	 */
	workPackages?: readonly PickerPackage[];
}

/** A work package the picker offers under its project. */
export interface PickerPackage {
	id: string;
	code: string;
	name: string;
}

/** One choice of the list: a project and one of its work packages, or the project alone. */
export interface PickerOption {
	/** The option's key, `lineKey` of its project and work package. */
	id: string;
	project: PickerProject;
	workPackage: PickerPackage | null;
}

/** An option as the list and the field name it: "ACME-001 · Website rebuild › WP2 Build". */
export function optionLabel(option: Pick<PickerOption, "project" | "workPackage">): string {
	return projectAndPackage(option.project, option.workPackage);
}

/** The options of `project`: one for each of its work packages, or the project alone. */
function optionsOf(project: PickerProject): PickerOption[] {
	const packages = project.workPackages ?? [];
	return packages.length === 0
		? [{ id: project.id, project, workPackage: null }]
		: packages.map((wp) => ({ id: lineKey(project.id, wp.id), project, workPackage: wp }));
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
	/** The ids of the projects whose team the person is on (TS-115c): shown first, A to Z. */
	assigned?: readonly string[];
	/** The ids of the projects the person may add themselves to the team of (TS-115c): shown last, apart. */
	joinable?: readonly string[];
	/** The chosen project's id. */
	value: string | null;
	/** The chosen work package's id (TS-115b); null or left out for none. */
	workPackageId?: string | null;
	/** Called with the id of the project the person chose, and of its work package, if any. */
	onChange: (id: string | null, workPackageId: string | null) => void;
	/** The name of the field that sends the work package's id; left out, none is sent. */
	workPackageName?: string;
	isRequired?: boolean;
	autoFocus?: boolean;
	/** Supporting text under the field. */
	description?: string;
}

/** A heading of the list and the options under it. */
export interface ProjectSection {
	id: string;
	title: string;
	options: PickerOption[];
}

/** How many recent projects head the list. */
export const RECENT_LIMIT = 5;
export const RECENT_TITLE = "Recent";
export const NO_CLIENT_TITLE = "No client";
export const NO_MATCH = "No project matches";
/** The heading of the person's own projects, in the organisation's word for them. */
export const ASSIGNED_TITLE = "Your projects";
/** The heading of the projects the person may add themselves to the team of. */
export const JOINABLE_TITLE = "Not on the team";

/**
 * The list as shown for what is typed: the person's own projects first, those
 * whose team they are on (TS-115c), then the pinned projects, A to Z,
 * then up to five recent projects, then each client's projects, clients A to
 * Z and projects A to Z within them, and the projects without a client last. A
 * project is listed once: a pinned one is not repeated as recent, nor either
 * under its client. Where the organisation works by both, its work codes
 * follow in a section of their own; where it shows no clients, every project
 * not above is in one section under its own word for them (TS-115a). Each
 * project is listed as its options (TS-115b), its work packages by code. What
 * is typed keeps the options whose project's code or name, client's name or
 * code, or work package's code or name holds it, in any case; an empty query
 * keeps every one. Sections left empty are dropped. The projects the person
 * may add themselves to the team of come last, in a section of their own.
 */
export function projectSections(
	projects: readonly PickerProject[],
	recent: readonly string[],
	query: string,
	terms: Terms = CLIENT_PROJECT_TERMS,
	pinned: readonly string[] = [],
	{
		assigned = [],
		joinable = [],
	}: { assigned?: readonly string[]; joinable?: readonly string[] } = {},
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
	/** The options of `list`, in its order, that what is typed keeps. */
	const kept = (list: readonly PickerProject[]) =>
		list
			.flatMap(optionsOf)
			.filter(
				(option) =>
					matches(option.project) ||
					(option.workPackage !== null &&
						(holds(option.workPackage.code) ||
							holds(option.workPackage.name) ||
							holds(optionLabel(option)))),
			);

	const isJoinable = new Set(joinable);
	const joinableProjects = projects.filter((project) => isJoinable.has(project.id)).sort(byLabel);
	const offered = projects.filter((project) => !isJoinable.has(project.id));
	const byId = new Map(offered.map((project) => [project.id, project]));
	const isAssigned = new Set(assigned);
	const assignedProjects = offered.filter((project) => isAssigned.has(project.id)).sort(byLabel);
	const isPinned = new Set(pinned);
	const pinnedProjects = offered
		.filter((project) => isPinned.has(project.id) && !isAssigned.has(project.id))
		.sort(byLabel);
	const recentProjects: PickerProject[] = [];
	for (const id of recent) {
		const project = byId.get(id);
		if (!project || recentProjects.includes(project) || isPinned.has(id) || isAssigned.has(id))
			continue;
		recentProjects.push(project);
		if (recentProjects.length === RECENT_LIMIT) break;
	}
	const isAbove = new Set(
		[...assignedProjects, ...pinnedProjects, ...recentProjects].map((project) => project.id),
	);
	const rest = offered.filter((project) => !isAbove.has(project.id));
	const above = [
		{ id: "assigned", title: inTerms(ASSIGNED_TITLE, terms), options: kept(assignedProjects) },
		{ id: "pinned", title: PINNED_TITLE, options: kept(pinnedProjects) },
		{ id: "recent", title: RECENT_TITLE, options: kept(recentProjects) },
	];
	const apart = { id: "joinable", title: JOINABLE_TITLE, options: kept(joinableProjects) };

	if (!terms.clients) {
		return [
			...above,
			{ id: "all", title: terms.Projects, options: kept(rest.sort(byLabel)) },
			apart,
		].filter((section) => section.options.length > 0);
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
				options: kept(list.sort(byLabel)),
			})),
		{ id: "no-client", title: NO_CLIENT_TITLE, options: kept(noClient.sort(byLabel)) },
		{ id: "work-codes", title: terms.WorkCodes, options: kept(workCodes.sort(byLabel)) },
		apart,
	];
	return sections.filter((section) => section.options.length > 0);
}

/**
 * A field that chooses one project, and one of its work packages where it
 * has them. Typing filters by code, project, client or work package; the
 * arrow keys move through the list, Enter chooses, Escape puts back the
 * choice before. The field shows the chosen project's code and name, and its
 * work package's.
 */
export function ProjectPicker({
	label,
	name,
	projects,
	recent = [],
	pinned = [],
	assigned = [],
	joinable = [],
	value,
	workPackageId = null,
	onChange,
	workPackageName,
	isRequired,
	autoFocus,
	description,
}: ProjectPickerProps) {
	const terms = useTerms();
	// What the person has typed since they last chose; null shows the chosen option's name.
	const [query, setQuery] = useState<string | null>(null);
	const project = projects.find((each) => each.id === value) ?? null;
	// The chosen option, where it is one offered: a project with work packages is chosen by one of them.
	const chosen = project
		? (optionsOf(project).find((option) => option.id === lineKey(project.id, workPackageId)) ??
			null)
		: null;
	const sections = projectSections(projects, recent, query ?? "", terms, pinned, {
		assigned,
		joinable,
	});
	// Its project chosen but none of its work packages, as an entry tracked before the project had
	// any is (TS-115b): the field says one must be chosen, and is not sent until one is.
	const lacksPackage =
		project !== null && chosen === null && (project.workPackages?.length ?? 0) > 0
			? `${pickerLabel(project)} has work packages. ${inTerms(WORK_PACKAGE_REFUSALS["no-work-package"], terms)}`
			: null;

	return (
		<ComboBox
			items={sections}
			selectedKey={chosen?.id ?? null}
			onSelectionChange={(key) => {
				setQuery(null);
				if (key === null) return onChange(null, null);
				const line = lineOf(`${key}`);
				onChange(line.projectId, line.workPackageId);
			}}
			inputValue={query ?? (chosen ? optionLabel(chosen) : "")}
			onInputChange={setQuery}
			onOpenChange={(isOpen) => {
				if (!isOpen) setQuery(null);
			}}
			allowsEmptyCollection
			isRequired={isRequired}
			validate={({ selectedKey }) => (selectedKey === null ? lacksPackage : null)}
			className="relative flex flex-col gap-1"
		>
			{({ isInvalid, isDisabled, isOpen, isRequired: required }) => {
				const field = { isInvalid, isDisabled, isActive: isOpen };
				return (
					<>
						<input type="hidden" name={name} value={chosen?.project.id ?? ""} />
						{workPackageName && (
							<input type="hidden" name={workPackageName} value={chosen?.workPackage?.id ?? ""} />
						)}
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
						{(lacksPackage ?? description) && !isInvalid && (
							<Text slot="description" className={fieldSupporting(field)}>
								{lacksPackage ?? description}
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
										<Collection items={section.options}>
											{(option) => <ProjectOption option={option} showsClient={terms.clients} />}
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

function ProjectOption({ option, showsClient }: { option: PickerOption; showsClient: boolean }) {
	const client = showsClient ? clientLabel(option.project) : null;
	return (
		<ListBoxItem
			id={option.id}
			textValue={optionLabel(option)}
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
					<span className="truncate text-label-large">{optionLabel(option)}</span>
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
