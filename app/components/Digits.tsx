/**
 * A time that changes while it is looked at. Each character stands in a place of
 * its own, counted from the right, and only a character that changes is drawn
 * again: it arrives the way a clock's digit does (`tick-digit` in app.css).
 * The figures are tabular, so nothing beside them moves.
 *
 * A screen reader gets the time as one piece of text, not character by character.
 * Nothing announces it: put it inside a `role="timer"` or plain text, never a live region.
 */
export function Digits({ value }: { value: string }) {
	const characters = [...value];

	return (
		<>
			<span className="sr-only">{value}</span>
			<span aria-hidden="true" className="tabular-nums">
				{characters.map((character, index) => {
					const place = characters.length - index;
					return (
						<span key={`${place}:${character}`} className="tick-digit">
							{character}
						</span>
					);
				})}
			</span>
		</>
	);
}
