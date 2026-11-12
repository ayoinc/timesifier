import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "~/components/Button";
import { Sheet } from "~/components/Sheet";

/**
 * The Timesheet's keys (taste HT-D, Harvest's "Hit the N key"): N for a new
 * entry (Track time on the Day view, a new row on the Week view), `[` and `]`
 * for the period before and after, T for today, and `?` for the list of them.
 * Each acts only when the focus is not in a field and no sheet, menu or list
 * is open, and never with Ctrl, Cmd or Alt, so typing is never taken. Escape
 * closes what is open, as it already does.
 */

export interface TimesheetKeys {
	/** N. */
	onNew?: () => void;
	/** `[`: the address of the period before. */
	previous?: string;
	/** `]`: the address of the period after. */
	next?: string;
	/** T: the address of the period that holds today. */
	today?: string;
}

export const SHORTCUTS: readonly { keys: string; does: string }[] = [
	{ keys: "N", does: "Track time on the Day view; add a row on the Week view" },
	{ keys: "[", does: "The day, week or month before" },
	{ keys: "]", does: "The day, week or month after" },
	{ keys: "T", does: "Back to today" },
	{ keys: "+ and -", does: "Zoom in and out of the calendar" },
	{ keys: "?", does: "This list" },
	{ keys: "Esc", does: "Close a sheet, a menu or a list" },
];

/** Whether a key press belongs to what has the focus, or to an overlay. */
function isTyping(event: KeyboardEvent): boolean {
	if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return true;
	const target = event.target as HTMLElement | null;
	if (
		target?.closest(
			"input, textarea, select, [contenteditable], [role=dialog], [role=listbox], [role=menu]",
		)
	) {
		return true;
	}
	return document.querySelector("[role=dialog], [role=menu], [role=listbox]") !== null;
}

/** Listens for the Timesheet's keys while the view is on screen; returns the `?` sheet's state. */
export function useTimesheetKeys(keys: TimesheetKeys) {
	const navigate = useNavigate();
	const [helpOpen, setHelpOpen] = useState(false);
	// The latest handlers, without listening again on each render.
	const latest = useRef(keys);
	latest.current = keys;
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (isTyping(event)) return;
			const { onNew, previous, next, today } = latest.current;
			const go = (to: string | undefined) => {
				if (to === undefined) return;
				event.preventDefault();
				void navigate(to, { preventScrollReset: true });
			};
			switch (event.key) {
				case "n":
				case "N":
					if (!onNew) return;
					event.preventDefault();
					onNew();
					return;
				case "[":
					return go(previous);
				case "]":
					return go(next);
				case "t":
				case "T":
					return go(today);
				case "?":
					event.preventDefault();
					setHelpOpen(true);
					return;
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [navigate]);
	return { helpOpen, setHelpOpen };
}

/** The list `?` opens. */
export function ShortcutsSheet({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Sheet
			title="Keyboard shortcuts"
			isOpen={isOpen}
			onOpenChange={onOpenChange}
			actions={
				<Button variant="text" slot="close">
					Close
				</Button>
			}
		>
			<dl className="flex flex-col gap-2 text-body-large text-on-surface">
				{SHORTCUTS.map(({ keys, does }) => (
					<div key={keys} className="flex items-baseline gap-4">
						<dt className="w-20 shrink-0">
							<kbd className="rounded-small border border-outline-variant px-2 py-0.5 font-sans text-label-large">
								{keys}
							</kbd>
						</dt>
						<dd className="text-on-surface-variant">{does}</dd>
					</div>
				))}
			</dl>
		</Sheet>
	);
}
