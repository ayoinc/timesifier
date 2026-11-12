/**
 * A brand colour (TS-100): six hexadecimal digits after "#", as a colour field
 * gives it. An organisation's colour carries white type wherever it is a
 * ground, on a client's email and its document, so it must be dark enough for
 * that: a contrast of at least 4.5 to 1 with white, WCAG's level AA for text.
 */

export const HEX_COLOUR = /^#[0-9a-f]{6}$/;

/** The least contrast between white type and an organisation's colour. */
export const LEAST_CONTRAST = 4.5;

/** A colour as typed: trimmed, lower case, the "#" supplied where it was left out. */
export function normaliseColour(typed: string): string {
	const trimmed = typed.trim().toLowerCase();
	return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

/** The relative luminance of a `#rrggbb` colour, as WCAG 2 defines it. */
function luminance(colour: string): number {
	const [red, green, blue] = [1, 3, 5].map((at) => {
		const channel = Number.parseInt(colour.slice(at, at + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** The contrast between white and `colour`, from 1 to 21. */
export function contrastWithWhite(colour: string): number {
	return 1.05 / (luminance(colour) + 0.05);
}

/** The colour's three channels from 0 to 1, as a PDF sets a colour. */
export function channels(colour: string): [number, number, number] {
	return [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16) / 255) as [
		number,
		number,
		number,
	];
}
