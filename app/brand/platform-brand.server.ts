import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { platformBrand } from "~/db";
import { EMAIL_COLOURS } from "~/styles/email-colours";
import { BUILT_IN_IMAGES } from "./built-in-images";
import { HEX_COLOUR, normaliseColour } from "./colour";
import { fromBase64, imageSize, imageTypeOf, toBase64 } from "./images";

/**
 * The platform's brand (TS-100): what every email and export says of
 * Timesifier itself. It is one row of `platform_brand`; this module is the
 * only code that reads or writes it, and every message and document gets it
 * from `getPlatformBrand`. The platform console edits it through
 * `setPlatformBrand`; who may is the console's gate to decide, not this.
 */

/** One of the brand's images: a PNG, at twice the size it is shown. */
export interface BrandImage {
	bytes: Uint8Array<ArrayBuffer>;
	width: number;
	height: number;
	/** Whether it is the image the product ships with, not one the platform set. */
	builtIn: boolean;
}

export interface PlatformBrand {
	/** The display name every message is from. */
	senderName: string;
	/** Where a reply goes; null for none, so a reply goes to the sending address. */
	replyTo: string | null;
	tagline: string;
	/** The line at the foot of every message sent in the platform's own name. */
	emailFooter: string;
	/** `#rrggbb`: the band at the top of the platform's messages. No type stands on it. */
	colour: string;
	/** The logo at the top of every message, attached to it. */
	logo: BrandImage;
	/** The mark on a light ground: at the foot of a client's document and message. */
	markLight: BrandImage;
	/** The mark on a dark ground. */
	markDark: BrandImage;
	updatedAt: Date | null;
	/** Who last changed it, by user id; null while it holds the values it started with. */
	updatedBy: string | null;
}

type Texts = Pick<PlatformBrand, "senderName" | "replyTo" | "tagline" | "emailFooter" | "colour">;
type ImageName = "logo" | "markLight" | "markDark";
const IMAGE_NAMES: readonly ImageName[] = ["logo", "markLight", "markDark"];

/** What the platform's brand says until it is changed; migration 0018 starts the row at the same. */
export const PLATFORM_BRAND_DEFAULTS: Readonly<Texts> = {
	senderName: "Timesifier",
	replyTo: null,
	tagline: "Track your hours. Trust the total.",
	emailFooter: "Sent by Timesifier.",
	colour: EMAIL_COLOURS.band,
};

const ROW = "platform";

function builtIn(name: ImageName): BrandImage {
	const { base64, width, height } = BUILT_IN_IMAGES[name];
	return { bytes: fromBase64(base64), width, height, builtIn: true };
}

/** A stored image, or the built-in one where none is stored or the stored one cannot be read. */
function imageOf(name: ImageName, stored: string | null): BrandImage {
	if (stored === null) return builtIn(name);
	const bytes = fromBase64(stored);
	const size = imageSize(bytes, "image/png");
	return size ? { bytes, ...size, builtIn: false } : builtIn(name);
}

/** The platform's brand as it ships: the defaults and the built-in images, changed by nobody. */
export function builtInPlatformBrand(): PlatformBrand {
	return {
		...PLATFORM_BRAND_DEFAULTS,
		logo: builtIn("logo"),
		markLight: builtIn("markLight"),
		markDark: builtIn("markDark"),
		updatedAt: null,
		updatedBy: null,
	};
}

/** The platform's brand as it stands. */
export async function getPlatformBrand(env: { DB: D1Database }): Promise<PlatformBrand> {
	const [row] = await drizzle(env.DB)
		.select()
		.from(platformBrand)
		.where(eq(platformBrand.id, ROW))
		.limit(1);
	return {
		...PLATFORM_BRAND_DEFAULTS,
		...(row
			? {
					senderName: row.senderName,
					replyTo: row.replyTo,
					tagline: row.tagline,
					emailFooter: row.emailFooter,
					colour: row.colour,
				}
			: {}),
		logo: imageOf("logo", row?.logo ?? null),
		markLight: imageOf("markLight", row?.markLight ?? null),
		markDark: imageOf("markDark", row?.markDark ?? null),
		updatedAt: row?.updatedAt ? new Date(row.updatedAt) : null,
		updatedBy: row?.updatedBy ?? null,
	};
}

/**
 * A change to the platform's brand: each field left out stays as it is. An
 * image is a PNG's bytes, or null to go back to the built-in one; a Reply-To
 * of null or "" takes it away.
 */
export interface PlatformBrandInput {
	senderName?: string;
	replyTo?: string | null;
	tagline?: string;
	emailFooter?: string;
	colour?: string;
	logo?: Uint8Array | null;
	markLight?: Uint8Array | null;
	markDark?: Uint8Array | null;
}

export type PlatformBrandProblems = Partial<Record<keyof PlatformBrandInput, string>>;

/** The most bytes one of the brand's images may have: each is sent with every message. */
export const MOST_IMAGE_BYTES = 64 * 1024;
/** The fewest and the most pixels on each side of one of the brand's images. */
export const IMAGE_SIDE = { least: 16, most: 1024 } as const;

/** A name a header carries as it is: nothing that ends it, quotes it or starts an address. */
const SENDER_NAME = /^[^<>"@,;:\\\r\n]+$/;
/** One address, as the email adapter accepts it. */
const ADDRESS = /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]+$/;
const ONE_LINE = /^[^\r\n]*$/;

function lineProblem(value: string, label: string, most: number): string | null {
	if (value === "") return `Enter the ${label}.`;
	if (value.length > most) return `The ${label} is at most ${most} characters.`;
	if (!ONE_LINE.test(value)) return `The ${label} is one line.`;
	return null;
}

function imageProblem(bytes: Uint8Array): string | null {
	if (imageTypeOf(bytes) !== "image/png") return "Choose a PNG.";
	if (bytes.length > MOST_IMAGE_BYTES)
		return `Choose a PNG of at most ${MOST_IMAGE_BYTES / 1024} KB.`;
	const size = imageSize(bytes, "image/png");
	if (
		!size ||
		[size.width, size.height].some((side) => side < IMAGE_SIDE.least || side > IMAGE_SIDE.most)
	) {
		return `Choose a PNG from ${IMAGE_SIDE.least} to ${IMAGE_SIDE.most} pixels on each side.`;
	}
	return null;
}

/**
 * Changes the platform's brand to `input`, recording `actor` (a user id) and
 * when, and answers the brand as it now stands; or, where any field is not
 * valid, changes nothing and answers what is wrong with each.
 */
export async function setPlatformBrand(
	env: { DB: D1Database },
	input: PlatformBrandInput,
	actor: string,
): Promise<{ ok: true; brand: PlatformBrand } | { ok: false; problems: PlatformBrandProblems }> {
	const problems: PlatformBrandProblems = {};
	const texts: Partial<Texts> = {};

	if (input.senderName !== undefined) {
		const name = input.senderName.trim();
		const problem =
			lineProblem(name, "sender name", 60) ??
			(SENDER_NAME.test(name) ? null : 'The sender name has none of < > " @ , ; : or \\.');
		if (problem) problems.senderName = problem;
		else texts.senderName = name;
	}
	if (input.replyTo !== undefined) {
		const address = input.replyTo?.trim() ?? "";
		if (address === "") texts.replyTo = null;
		else if (address.length > 254 || !ADDRESS.test(address)) {
			problems.replyTo = "Enter one email address, like help@example.com.";
		} else texts.replyTo = address;
	}
	for (const [field, label, most] of [
		["tagline", "tagline", 120],
		["emailFooter", "email footer", 200],
	] as const) {
		const value = input[field];
		if (value === undefined) continue;
		const problem = lineProblem(value.trim(), label, most);
		if (problem) problems[field] = problem;
		else texts[field] = value.trim();
	}
	if (input.colour !== undefined) {
		const colour = normaliseColour(input.colour);
		if (HEX_COLOUR.test(colour)) texts.colour = colour;
		else problems.colour = "Enter a colour as # followed by six hexadecimal digits.";
	}
	const images: Partial<Record<ImageName, string | null>> = {};
	for (const name of IMAGE_NAMES) {
		const bytes = input[name];
		if (bytes === undefined) continue;
		if (bytes === null) {
			images[name] = null;
			continue;
		}
		const problem = imageProblem(bytes);
		if (problem) problems[name] = problem;
		else images[name] = toBase64(bytes);
	}
	if (Object.keys(problems).length > 0) return { ok: false, problems };

	const current = await getPlatformBrand(env);
	const stamp = { updatedAt: Date.now(), updatedBy: actor };
	await drizzle(env.DB)
		.insert(platformBrand)
		.values({
			id: ROW,
			senderName: current.senderName,
			replyTo: current.replyTo,
			tagline: current.tagline,
			emailFooter: current.emailFooter,
			colour: current.colour,
			...texts,
			...images,
			...stamp,
		})
		.onConflictDoUpdate({ target: platformBrand.id, set: { ...texts, ...images, ...stamp } });
	return { ok: true, brand: await getPlatformBrand(env) };
}
