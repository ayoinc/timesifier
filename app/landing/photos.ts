// Every photograph is a file under public/images/, in AVIF with a WebP fallback at
// each of its widths. public/images/CREDITS.md records where each came from, and
// test/node/landing-images.test.ts holds the two in step.

export interface PhotoSource {
	/** The file name without its width and extension: `desk` is `/images/desk-640.avif`. */
	name: string;
	/** The widths the file exists at, narrowest first. */
	widths: readonly number[];
	/** The shape of the photograph, as the size of its widest file. */
	width: number;
	height: number;
	/** Where it was taken, as its caption says it. */
	place: string;
	/** Who took it, credited at the foot of the page and never under the photograph. */
	author: string;
	/** The photographer's page on Unsplash. */
	profile: string;
}

// Every width of a photograph has exactly the same shape (3:2 or 4:5 in whole
// pixels), so the file the browser chooses never changes the height it is drawn at.
export const PHOTOS = {
	departure: {
		name: "departure",
		widths: [600, 1200, 1800],
		width: 1800,
		height: 1200,
		place: "U-Bahn, Berlin-Tempelhof",
		author: "Karri Heiskanen",
		profile: "https://unsplash.com/@karriheiskanen",
	},
	workshop: {
		name: "workshop",
		widths: [480, 800, 1200],
		width: 1200,
		height: 1500,
		place: "A workshop in Utrecht",
		author: "Bob van Aubel",
		profile: "https://unsplash.com/@bobvanaubel",
	},
	platform: {
		name: "platform",
		widths: [600, 1200],
		width: 1200,
		height: 800,
		place: "Amsterdam Sloterdijk",
		author: "Nikolai Kolosov",
		profile: "https://unsplash.com/@nikolaikolosov",
	},
} as const satisfies Record<string, PhotoSource>;

export type PhotoFormat = "avif" | "webp";

/** The address of one file of a photograph. */
export function photoPath(photo: PhotoSource, width: number, format: PhotoFormat): string {
	return `/images/${photo.name}-${width}.${format}`;
}
