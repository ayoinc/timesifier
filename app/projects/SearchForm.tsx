import { useState } from "react";
import { Form, Link, useSearchParams } from "react-router";

import { Button } from "~/components/Button";
import { TextField } from "~/components/TextField";
import { TEXT_LINK } from "~/shell/links";

import { ARCHIVED, SEARCH_PARAM, SHOW_PARAM, searchIn, shownIn } from "./projects";

export interface SearchFormProps {
	/** What the form is, for assistive technology: "Search projects". */
	name: string;
	/** The field's label, which says what is searched: "Search by project or client name". */
	label: string;
	/** The button's words: "Search", "Filter". */
	submitLabel: string;
}

/**
 * The field that narrows a list of records by name (TS-057). What is typed is
 * sent in the address, `?q=`, so the list is narrowed on the server and a
 * search can be linked to and reloaded; the tab chosen stays as it is.
 */
export function SearchForm({ name, label, submitLabel }: SearchFormProps) {
	const [search] = useSearchParams();
	const query = searchIn(search);
	const archived = shownIn(search) === ARCHIVED;
	// The field follows the address when it changes without the field, as the
	// back button does; until then it holds what is typed.
	const [typed, setTyped] = useState(query);
	const [typedFor, setTypedFor] = useState(query);
	if (typedFor !== query) {
		setTypedFor(query);
		setTyped(query);
	}

	return (
		<Form
			method="get"
			role="search"
			aria-label={name}
			preventScrollReset
			className="flex max-w-120 flex-wrap items-center gap-x-4 gap-y-2"
		>
			{archived && <input type="hidden" name={SHOW_PARAM} value={ARCHIVED} />}
			<div className="min-w-0 flex-1 basis-60">
				<TextField
					label={label}
					name={SEARCH_PARAM}
					type="search"
					autoComplete="off"
					value={typed}
					onChange={setTyped}
				/>
			</div>
			<Button type="submit" variant="outlined">
				{submitLabel}
			</Button>
			{query !== "" && (
				<Link
					to={{ search: archived ? `?${SHOW_PARAM}=${ARCHIVED}` : "" }}
					preventScrollReset
					className={TEXT_LINK}
				>
					Clear search
				</Link>
			)}
		</Form>
	);
}
