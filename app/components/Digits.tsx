import { useLayoutEffect, useRef } from "react";

/**
 * A time that changes while it is looked at. Each character stands in a place of
 * its own, counted from the right, and only a character that changes is drawn
 * again: it arrives the way a clock's digit does (`tick-digit` in app.css).
 * The figures are tabular, so nothing beside them moves.
 *
 * The characters the time is first drawn with do not arrive: they are simply
 * there, on a page that loads, reloads or is moved to. Only a character that
 * replaces one while the time is looked at moves in. Before TS-096 every
 * character of every time rose and faded in on each load, so all the figures
 * on a page blinked at once.
 *
 * A screen reader gets the time as one piece of text, not character by character.
 * Nothing announces it: put it inside a `role="timer"` or plain text, never a live region.
 */
export function Digits({ value }: { value: string }) {
	const characters = [...value];
	const keys = characters.map((character, index) => `${characters.length - index}:${character}`);
	// The characters on screen since the time was first drawn. A key leaves this
	// set when its character is replaced, so the same digit coming back later
	// arrives like any other.
	const settled = useRef<Set<string> | null>(null);
	settled.current ??= new Set(keys);
	useLayoutEffect(() => {
		const shown = new Set(keys);
		for (const key of settled.current ?? []) if (!shown.has(key)) settled.current?.delete(key);
	});

	return (
		<>
			<span className="sr-only">{value}</span>
			<span aria-hidden="true" className="tabular-nums">
				{characters.map((character, index) => {
					const key = keys[index];
					return (
						<span
							key={key}
							className={settled.current?.has(key) ? "tick-digit" : "tick-digit tick-in"}
						>
							{character}
						</span>
					);
				})}
			</span>
		</>
	);
}
