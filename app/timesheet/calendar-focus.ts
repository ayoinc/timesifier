import { useState } from "react";

/** What an item of a calendar's grid is given to take its place in the tab order. */
export interface FocusItemProps {
	tabIndex: 0 | -1;
	"data-focus-id": string;
	onFocus: () => void;
}

/**
 * The calendar's grids take one stop of Tab, and the arrow keys move within
 * them (TS-062): the item the focus was last on, or the grid's first choice,
 * is the one in the tab order. An item that has gone, a slot just filled, is
 * replaced by the first choice.
 */
export function useRovingFocus(ids: ReadonlySet<string>, first: string) {
	const [chosen, setChosen] = useState<string | null>(null);
	const active = chosen !== null && ids.has(chosen) ? chosen : first;
	return {
		active,
		itemProps: (id: string): FocusItemProps => ({
			tabIndex: id === active ? 0 : -1,
			"data-focus-id": id,
			onFocus: () => setChosen(id),
		}),
	};
}

/** Moves the focus to the item `id` of `grid`, if it is there. */
export function focusItem(grid: HTMLElement | null, id: string | undefined): boolean {
	if (!grid || id === undefined) return false;
	const item = grid.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(id)}"]`);
	item?.focus();
	return item !== null;
}
