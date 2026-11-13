// What a change to the platform's brand may hold (TS-100, TS-120), apart from
// the server module that enforces it, so that the console's Brand page can
// state the same limits in the browser.

/** The most bytes one of the brand's images may have: each is sent with every message. */
export const MOST_IMAGE_BYTES = 64 * 1024;
/** The fewest and the most pixels on each side of one of the brand's images. */
export const IMAGE_SIDE = { least: 16, most: 1024 } as const;

/** The most characters of each of the brand's lines. */
export const MOST_CHARACTERS = {
	senderName: 60,
	tagline: 120,
	emailFooter: 200,
	replyTo: 254,
} as const;

/** The brand's images: the logo and the mark, each for a light ground and a dark one. */
export type PlatformImageName = "logo" | "logoDark" | "markLight" | "markDark";
export const PLATFORM_IMAGE_NAMES: readonly PlatformImageName[] = [
	"logo",
	"logoDark",
	"markLight",
	"markDark",
];
