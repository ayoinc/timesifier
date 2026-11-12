import { Checkbox } from "~/components/Checkbox";

import { offeredTags, TAG_FIELD, type TagChoice } from "./tags";

export interface TagPickerProps {
	/** Every tag of the organisation; the archived ones are offered only where already chosen. */
	tags: readonly TagChoice[];
	/** The ids ticked to start with. */
	selected: readonly string[];
	/** What the tags are put on, for the group's name: "Tags". */
	label?: string;
}

/**
 * The tags of an entry, an expense or a project, as a group of boxes (TS-085).
 * It always sends one empty `tagIds`, so a form with every box clear says
 * "no tags" rather than "leave them". An archived tag the thing already has
 * stays ticked and can be cleared, never added.
 */
export function TagPicker({ tags, selected, label = "Tags" }: TagPickerProps) {
	const offered = offeredTags(tags, selected);
	if (offered.length === 0) return null;
	return (
		<fieldset className="flex flex-col">
			<legend className="pb-1 text-title-medium text-on-surface">{label}</legend>
			<input type="hidden" name={TAG_FIELD} value="" />
			<div className="flex flex-wrap gap-x-4">
				{offered.map((tag) => (
					<Checkbox
						key={tag.id}
						name={TAG_FIELD}
						value={tag.id}
						defaultSelected={selected.includes(tag.id)}
					>
						{tag.archived ? `${tag.name} (archived)` : tag.name}
					</Checkbox>
				))}
			</div>
		</fieldset>
	);
}
