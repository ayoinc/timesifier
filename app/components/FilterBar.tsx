import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { Form, useSearchParams, useSubmit } from "react-router";

import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { CloseIcon } from "./icons/CloseIcon";
import { TextField } from "./TextField";

// A list's filters: a search form that applies itself. There is no Apply button
// for anyone with JavaScript: a field applies 300ms after typing stops and at
// once on Enter, a Select as soon as it changes. Without JavaScript the form is
// a plain GET form with an Apply button in <noscript>.

/** How long a field waits after the last keystroke before it applies. */
const DEBOUNCE_MS = 300;

const ApplyContext = createContext<(() => void) | null>(null);

export interface FilterBarProps {
	/** Accessible name of the search landmark: "Filter projects". */
	name: string;
	/** Query parameters kept as hidden inputs, e.g. { show: "archived" }. */
	keep?: Record<string, string>;
	/** FilterField and/or other controls (Selects) on one row. */
	children: ReactNode;
}

/**
 * The row of a list's filters, as a search landmark. The field and the controls
 * share one row and one baseline, and wrap under 600px. Submitting replaces the
 * address rather than adding to history, keeps the scroll position, and leaves
 * out every empty field, so a cleared search drops its parameter.
 */
export function FilterBar({ name, keep, children }: FilterBarProps) {
	const form = useRef<HTMLFormElement>(null);
	const submit = useSubmit();
	const apply = useCallback(() => {
		if (!form.current) return;
		const params = new URLSearchParams();
		for (const [key, value] of new FormData(form.current)) {
			if (typeof value === "string" && value.trim() !== "") params.append(key, value);
		}
		submit(params, { method: "get", replace: true, preventScrollReset: true });
	}, [submit]);

	return (
		<ApplyContext.Provider value={apply}>
			<Form
				ref={form}
				method="get"
				role="search"
				aria-label={name}
				replace
				preventScrollReset
				onSubmit={(event) => {
					event.preventDefault();
					apply();
				}}
				className="flex flex-wrap items-end gap-x-4 gap-y-2"
			>
				{Object.entries(keep ?? {}).map(([key, value]) => (
					<input key={key} type="hidden" name={key} value={value} />
				))}
				{children}
				<noscript>
					<Button type="submit" variant="tonal">
						Apply
					</Button>
				</noscript>
			</Form>
		</ApplyContext.Provider>
	);
}

/** Submits the enclosing FilterBar now. A Select's `onSelectionChange` calls it. */
export function useApplyFilters(): () => void {
	const apply = useContext(ApplyContext);
	if (!apply) throw new Error("useApplyFilters is used outside a FilterBar.");
	return apply;
}

export interface FilterFieldProps {
	/** Visible label, short enough for 390px: "Search projects or clients". */
	label: string;
	/** The query parameter it writes: "q". */
	param: string;
}

/**
 * The search field of a FilterBar. Its value follows the address, so Back and a
 * link to a filtered list show what is applied. A Clear button appears while it
 * holds something; it empties the field and applies at once.
 */
export function FilterField({ label, param }: FilterFieldProps) {
	const apply = useApplyFilters();
	const [params] = useSearchParams();
	const applied = params.get(param) ?? "";
	const [value, setValue] = useState(applied);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	// The address changed from elsewhere (Back, a link): show what it holds.
	useEffect(() => {
		setValue(applied);
	}, [applied]);

	useEffect(() => () => clearTimeout(timer.current), []);

	const applyNow = () => {
		clearTimeout(timer.current);
		apply();
	};

	return (
		<div className="flex min-w-0 grow basis-64 items-start gap-1">
			<div className="min-w-0 flex-1">
				<TextField
					label={label}
					name={param}
					type="search"
					value={value}
					onChange={(next) => {
						setValue(next);
						clearTimeout(timer.current);
						timer.current = setTimeout(apply, DEBOUNCE_MS);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							applyNow();
						}
					}}
				/>
			</div>
			{value !== "" && (
				<div className="flex h-14 items-center">
					<IconButton
						label="Clear search"
						onPress={() => {
							setValue("");
							// Apply after React has written the empty value into the input.
							clearTimeout(timer.current);
							timer.current = setTimeout(apply, 0);
						}}
					>
						<CloseIcon />
					</IconButton>
				</div>
			)}
		</div>
	);
}
