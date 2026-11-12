import { useEffect, useState } from "react";

import { FilterBar, useApplyFilters } from "~/components/FilterBar";
import { Select } from "~/components/Select";
import { TextField } from "~/components/TextField";

import {
	ANY_TAG,
	EVERYONE,
	GROUP_LABELS,
	GROUPS,
	type Grouping,
	RANGE_LABELS,
	RANGES,
	type Range,
} from "./choices";
import type { RangeProblem } from "./query";

/** The report the fields start at: what the page shows. */
export interface ChosenReport {
	range: Range;
	from: string;
	to: string;
	group: Grouping;
	person: string;
	/** The tag the time is filtered by, or `ANY_TAG` (TS-085). */
	tag: string;
}

/** A tag the report may be filtered by. */
export interface TagChoice {
	id: string;
	name: string;
	archived: boolean;
}

export interface ReportChoiceProps {
	query: ChosenReport;
	/** The groupings offered; none for a view that is not grouped. */
	groupings?: readonly Grouping[];
	/** The people the viewer may narrow the report to; none when they see only their own time. */
	choices: readonly { id: string; name: string }[];
	/** What the person field calls everyone the viewer may see. */
	everyone: string;
	/** The range on show, in words: the label of a week or a month the stepper moved to. */
	range: string;
	/** Why the custom range typed makes no report, under its field (TS-091, W05). */
	problem: RangeProblem | null;
	/** The tags the time may be filtered by; none for a view without the filter (TS-085). */
	tags?: readonly TagChoice[];
}

/** A date field's value once a whole date is in it. */
const WHOLE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Each field of the choice grows to share its row, so every row of fields runs
 * the width of the column and their edges line up (audit W21, W22).
 */
const FIELD = "min-w-0 grow basis-44";

/**
 * The fields that choose a report, sent in the address, so a report is a
 * link (TS-014a). Every view of Reports and Dashboards uses them: a range,
 * the grouping where the view has one, the person where the viewer may
 * see more than their own time, and the tag where the view filters by it
 * (TS-085). Range, Group by, Person and Tag apply as soon as they change;
 * the days of a custom range apply once both hold a whole date,
 * or on Enter (TS-091, W15 and W28).
 */
export function ReportChoice(props: ReportChoiceProps) {
	return (
		<div className="mt-8">
			<FilterBar name="Choose a report">
				<ReportFields {...props} />
			</FilterBar>
		</div>
	);
}

function ReportFields({
	query,
	groupings,
	choices,
	everyone,
	range: shown,
	problem,
	tags = [],
}: ReportChoiceProps) {
	const apply = useApplyFilters();
	// The hidden select and the inputs hold the new value once React has drawn it.
	const applySoon = () => setTimeout(apply, 0);

	const [range, setRange] = useState<Range>(query.range);
	const [group, setGroup] = useState<Grouping>(query.group);
	const [person, setPerson] = useState(query.person);
	const [tag, setTag] = useState(query.tag);
	const [from, setFrom] = useState(query.from);
	const [to, setTo] = useState(query.to);
	// The address changed (applied, Back, a step): show what it holds.
	useEffect(() => {
		setRange(query.range);
		setGroup(query.group);
		setPerson(query.person);
		setTag(query.tag);
		setFrom(query.from);
		setTo(query.to);
	}, [query.range, query.group, query.person, query.tag, query.from, query.to]);

	// A week or a month the stepper moved to is offered while it is shown, by its days.
	const stepped = (id: Range) => id === "week" || id === "month";
	const ranges = RANGES.filter((id) => !stepped(id) || id === query.range);
	const applyDays = (first: string, last: string) => {
		if (WHOLE_DATE.test(first) && WHOLE_DATE.test(last)) applySoon();
	};
	const fieldError = (field: RangeProblem["field"]) =>
		problem?.field === field ? { isInvalid: true, errorMessage: problem.message } : {};

	return (
		<>
			<div className={FIELD}>
				<Select
					label="Range"
					name="range"
					options={ranges.map((id) => ({ id, label: stepped(id) ? shown : RANGE_LABELS[id] }))}
					value={range}
					onChange={(id) => {
						const next = RANGES.find((each) => each === id) ?? range;
						setRange(next);
						// A custom range waits for its days.
						if (next !== "custom") applySoon();
					}}
				/>
			</div>
			{groupings && groupings.length > 0 && (
				<div className={FIELD}>
					<Select
						label="Group by"
						name="group"
						options={groupings.map((id) => ({ id, label: GROUP_LABELS[id] }))}
						value={group}
						onChange={(id) => {
							setGroup(GROUPS.find((each) => each === id) ?? group);
							applySoon();
						}}
					/>
				</div>
			)}
			{range === "custom" && (
				<>
					<div className={FIELD}>
						<TextField
							label="First day"
							name="from"
							type="date"
							value={from}
							onChange={(value) => {
								setFrom(value);
								applyDays(value, to);
							}}
							{...fieldError("from")}
						/>
					</div>
					<div className={FIELD}>
						<TextField
							label="Last day"
							name="to"
							type="date"
							value={to}
							min={WHOLE_DATE.test(from) ? from : undefined}
							onChange={(value) => {
								setTo(value);
								applyDays(from, value);
							}}
							{...fieldError("to")}
						/>
					</div>
				</>
			)}
			{stepped(range) && <input type="hidden" name="from" value={query.from} />}
			{choices.length > 0 && (
				<div className={FIELD}>
					<Select
						label="Person"
						name="person"
						options={[
							{ id: EVERYONE, label: everyone },
							...choices.map(({ id, name }) => ({ id, label: name })),
						]}
						value={person}
						onChange={(id) => {
							setPerson(id ?? EVERYONE);
							applySoon();
						}}
					/>
				</div>
			)}
			{tags.length > 0 && (
				<div className={FIELD}>
					<Select
						label="Tag"
						name="tag"
						options={[
							{ id: ANY_TAG, label: "Any tag" },
							...tags.map(({ id, name, archived }) => ({
								id,
								label: archived ? `${name} (archived)` : name,
							})),
						]}
						value={tag}
						onChange={(id) => {
							setTag(id ?? ANY_TAG);
							applySoon();
						}}
					/>
				</div>
			)}
		</>
	);
}
