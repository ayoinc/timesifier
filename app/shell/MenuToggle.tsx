import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

import { menuPath } from "./menu";

/**
 * "Hide menu" and "Menu" (sweep S2-10, decision 66): in the band, from 600px,
 * at the start of the band's end, so it is always in view; at the column's
 * foot an owner's fourteen links would scroll it away on a short window. One
 * element in both states, which keeps the focus as it is pressed. Ctrl+\, or
 * ⌘\ on a Mac, presses it from anywhere but an open sheet, menu or list. A
 * focus on a link that leaves with the column comes here; any other stays.
 *
 * It is a form, so it works before script and without: with script it
 * changes the page at once and posts nothing (`onToggle` writes the cookie).
 */
export function MenuToggle({
	organisation,
	hidden,
	onToggle,
}: {
	organisation: string;
	hidden: boolean;
	onToggle: () => void;
}) {
	const { pathname, search } = useLocation();
	const toggle = useRef<HTMLButtonElement>(null);
	// Read out after each change: a shortcut moves no focus, so nothing else would say it.
	const [said, setSaid] = useState("");
	// Whether the focus was in the navigation when the column changed.
	const focusWasInNavigation = useRef(false);
	const change = () => {
		focusWasInNavigation.current = document.activeElement?.closest("nav[aria-label=Main]") != null;
		setSaid(hidden ? "Menu shown" : "Menu hidden");
		onToggle();
	};
	useLayoutEffect(() => {
		if (!hidden || !focusWasInNavigation.current) return;
		focusWasInNavigation.current = false;
		const focused = document.activeElement;
		const dropped =
			focused === null ||
			focused === document.body ||
			(focused instanceof HTMLElement && focused.getClientRects().length === 0);
		if (dropped) toggle.current?.focus();
	}, [hidden]);
	const latest = useRef(change);
	latest.current = change;
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const modified = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
			if (!modified || event.defaultPrevented) return;
			if (event.key !== "\\" && event.code !== "Backslash") return;
			// Only where the column is drawn, from 600px, and never under an open sheet or menu.
			if (toggle.current?.getClientRects().length === 0) return;
			if (document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
			event.preventDefault();
			latest.current();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);
	return (
		<form
			method="post"
			action={menuPath(organisation)}
			onSubmit={(event) => {
				event.preventDefault();
				change();
			}}
			className="shrink-0 max-medium:hidden"
		>
			<input type="hidden" name="menu" value={hidden ? "shown" : "hidden"} />
			<input type="hidden" name="back" value={`${pathname}${search}`} />
			{/* Drawn 40px tall, as the profile menu's avatar is, so the band stays 80px
			    and the column under it starts where it ends; its `before:` reaches 48px
			    to be pressed, into the band's own padding. */}
			<button
				ref={toggle}
				type="submit"
				aria-keyshortcuts="Control+\ Meta+\"
				className="group relative flex min-h-10 cursor-pointer items-center text-label-large outline-none before:absolute before:inset-x-0 before:-inset-y-1"
			>
				<span className="rounded-extra-small px-1 py-1 hover-underline transition-link group-hover:decoration-current group-focus-visible:focus-indicator">
					{hidden ? "Menu" : "Hide menu"}
				</span>
			</button>
			{/* Polite, with no role: the page's own status line stays the one found as "status". */}
			<p aria-live="polite" className="sr-only">
				{said}
			</p>
		</form>
	);
}
