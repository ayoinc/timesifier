/**
 * A brand colour (TS-100): six hexadecimal digits after "#", as a colour field
 * gives it. An organisation's colour carries white type wherever it is a
 * ground, on a client's email and its document, so it must be dark enough for
 * that: a contrast of at least 4.5 to 1 with white, WCAG's level AA for text.
 * The platform's colour is the band of its messages and carries no type there;
 * like the amber it started as, it must still carry one of the product's two
 * type colours, ink or white, at the same 4.5 to 1, so it is never a muddy
 * middle that neither reads on (TS-120).
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

/** The contrast between two `#rrggbb` colours, from 1 to 21, as WCAG 2 defines it. */
export function contrastBetween(one: string, other: string): number {
	const [lighter, darker] = [luminance(one), luminance(other)].sort((a, b) => b - a) as [
		number,
		number,
	];
	return (lighter + 0.05) / (darker + 0.05);
}

/** The two colours of type the platform's colour is checked against. */
export interface TypeColours {
	ink: string;
	onBrand: string;
}

/** The contrast of ink and of white on `colour`, each from 1 to 21. */
export function platformColourContrast(colour: string, type: TypeColours) {
	return { ink: contrastBetween(colour, type.ink), white: contrastBetween(colour, type.onBrand) };
}

/**
 * What is wrong with `colour` as the platform's colour, or null: it must be
 * `#rrggbb`, and ink or white must read on it at `LEAST_CONTRAST` to 1.
 */
export function platformColourProblem(colour: string, type: TypeColours): string | null {
	if (!HEX_COLOUR.test(colour)) return "Enter a colour as # followed by six hexadecimal digits.";
	const { ink, white } = platformColourContrast(colour, type);
	if (Math.max(ink, white) >= LEAST_CONTRAST) return null;
	return `Neither ink nor white reads on ${colour} at ${LEAST_CONTRAST} to 1 (ink ${ink.toFixed(1)}, white ${white.toFixed(1)}). Choose a lighter or a darker colour.`;
}

/** The colour's three channels from 0 to 1, as a PDF sets a colour. */
export function channels(colour: string): [number, number, number] {
	return [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16) / 255) as [
		number,
		number,
		number,
	];
}
