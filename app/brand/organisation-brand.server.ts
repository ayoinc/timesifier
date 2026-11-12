import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { record } from "~/activity/activity.server";
import type { EmailImage, OrganisationLook } from "~/auth/email-frame";
import { organisationScope, organisations } from "~/db";
import { contrastWithWhite, HEX_COLOUR, LEAST_CONTRAST, normaliseColour } from "./colour";
import { type ImageType, imageSize, imageTypeOf, svgProblem } from "./images";

/**
 * An organisation's brand (TS-100): its logo and its colour, which lead the
 * documents it sends its clients and the messages that carry them, and stand
 * beside its name in the app's band. Owners and admins change them on
 * Workspace settings; who may is the caller's to decide.
 *
 * The logo is kept in R2, in the `BRAND` bucket, under a key built here from
 * the organisation's id and never taken from a request: the file as uploaded,
 * and for an SVG or a WebP a PNG the browser drew from it, for the places that
 * need pixels a mail program or a PDF can show. This module is the only code
 * that uses the binding (docs/security.md, "Organisation logos").
 */

/** The most bytes a logo, or the PNG drawn from it, may have: it is attached to every message to a client. */
export const LOGO_MAX_BYTES = 256 * 1024;
/** The fewest and the most pixels on each side of a logo. */
export const LOGO_SIDE = { least: 16, most: 2048 } as const;
/** The types a logo may be, as the file field accepts them. */
export const LOGO_TYPES: readonly ImageType[] = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/svg+xml",
];

export const LOGO_PROBLEM = `Choose a PNG, SVG, JPEG or WebP of at most ${LOGO_MAX_BYTES / 1024} KB, from ${LOGO_SIDE.least} to ${LOGO_SIDE.most} pixels on each side.`;
export const SVG_REFUSED =
	"That SVG does more than draw, so it is not used. Choose an SVG with no script, animation or link to another file, or a PNG.";
export const COLOUR_PROBLEM = "Enter a colour as # followed by six hexadecimal digits.";
export const COLOUR_TOO_LIGHT = `That colour is too light for white words on it. Choose a darker one: white on it needs a contrast of at least ${LEAST_CONTRAST} to 1.`;

const logoKey = (organisationId: string) => `org/${organisationId}/brand/logo`;
const renditionKey = (organisationId: string) => `org/${organisationId}/brand/logo.png`;

export interface OrganisationBrand {
	name: string;
	/** `#rrggbb`; null for none. */
	colour: string | null;
	logo: {
		type: ImageType;
		/** When it was uploaded: part of its address. */
		version: number;
		/** Whether a PNG drawn from it is stored beside it. */
		rendition: boolean;
	} | null;
}

/** The brand of `organisationId`, or null where there is no such organisation. */
export async function organisationBrandOf(
	organisationId: string,
): Promise<OrganisationBrand | null> {
	const [row] = await drizzle(env.DB)
		.select({
			name: organisations.name,
			colour: organisations.brandColour,
			type: organisations.brandLogoType,
			rendition: organisations.brandLogoRendition,
			version: organisations.brandLogoVersion,
		})
		.from(organisations)
		.where(eq(organisations.id, organisationId))
		.limit(1);
	if (!row) return null;
	const type = LOGO_TYPES.find((each) => each === row.type);
	return {
		name: row.name,
		colour: row.colour,
		logo: type ? { type, version: row.version ?? 0, rendition: row.rendition } : null,
	};
}

/** The stored logo of `organisationId` as uploaded, or null when it has none. */
export function logoFile(organisationId: string) {
	return env.BRAND.get(logoKey(organisationId));
}

/**
 * A stored logo as an answer: its own type and size, kept privately for a year,
 * since its address carries the upload's time. An SVG is drawn by `<img>`, where
 * it runs nothing; opened on its own it runs nothing either, as every answer that
 * is not a page carries a policy under which nothing loads
 * (workers/security-headers.ts).
 */
export function logoResponse(file: R2ObjectBody, type: ImageType): Response {
	return new Response(file.body, {
		headers: {
			"Content-Type": type,
			"Content-Length": String(file.size),
			"Content-Disposition": "inline",
			"Cache-Control": "private, max-age=31536000, immutable",
		},
	});
}

/**
 * The logo as pixels a mail program and a PDF can show: the PNG drawn from
 * it, or the file itself when it is a PNG or a JPEG. Null when there is no
 * logo, or it is an SVG or a WebP that was uploaded without a PNG beside it.
 */
export async function printableLogo(
	organisationId: string,
	brand: OrganisationBrand,
): Promise<EmailImage | null> {
	if (!brand.logo) return null;
	const { type, rendition } = brand.logo;
	const key = rendition
		? renditionKey(organisationId)
		: type === "image/png" || type === "image/jpeg"
			? logoKey(organisationId)
			: null;
	if (!key) return null;
	const file = await env.BRAND.get(key);
	if (!file) return null;
	const bytes = new Uint8Array(await file.arrayBuffer());
	const kind = imageTypeOf(bytes);
	if (kind !== "image/png" && kind !== "image/jpeg") return null;
	const size = imageSize(bytes, kind);
	return size ? { bytes, type: kind, ...size } : null;
}

/** The look of a message `organisationId` sends a client: its name, colour and logo. */
export async function organisationLook(organisationId: string): Promise<OrganisationLook | null> {
	const brand = await organisationBrandOf(organisationId);
	if (!brand) return null;
	return {
		name: brand.name,
		colour: brand.colour,
		logo: await printableLogo(organisationId, brand),
	};
}

type Checked = { ok: true; bytes: Uint8Array; type: ImageType } | { ok: false; problem: string };

/**
 * An uploaded file checked as a logo: its kind judged by its first bytes, which
 * must agree with the type the browser gave; its size; its pixels; and an SVG
 * refused when it could do more than draw.
 */
async function checkLogo(file: File, only?: ImageType): Promise<Checked> {
	if (file.size === 0 || file.size > LOGO_MAX_BYTES) return { ok: false, problem: LOGO_PROBLEM };
	const bytes = new Uint8Array(await file.arrayBuffer());
	const type = imageTypeOf(bytes);
	if (!type || (only && type !== only)) return { ok: false, problem: LOGO_PROBLEM };
	// A browser names an SVG `image/svg+xml`; some leave the type out.
	const declared = file.type.toLowerCase();
	if (declared !== "" && declared !== type) return { ok: false, problem: LOGO_PROBLEM };
	const size = imageSize(bytes, type);
	if (
		!size ||
		[size.width, size.height].some((side) => side < LOGO_SIDE.least || side > LOGO_SIDE.most)
	) {
		return { ok: false, problem: LOGO_PROBLEM };
	}
	if (type === "image/svg+xml" && svgProblem(bytes)) return { ok: false, problem: SVG_REFUSED };
	return { ok: true, bytes, type };
}

const recordChange = (
	organisationId: string,
	actor: string,
	before: Record<string, string>,
	after: Record<string, string>,
) =>
	record(
		organisationScope(env.DB, organisationId),
		actor,
		"brand.changed",
		{ type: "organisation", id: organisationId, ownerId: null },
		{ before, after },
	);

const LOGO_NAMES: Record<ImageType, string> = {
	"image/png": "PNG",
	"image/jpeg": "JPEG",
	"image/webp": "WebP",
	"image/svg+xml": "SVG",
};

/**
 * Stores `file` as the organisation's logo, replacing any before it, with
 * `rendition`, the PNG the browser drew from an SVG or a WebP, when it sent
 * one; and records the change.
 */
export async function saveLogo(
	organisationId: string,
	actor: string,
	file: File,
	rendition: File | null,
	now: number,
): Promise<{ ok: true } | { ok: false; problem: string }> {
	const logo = await checkLogo(file);
	if (!logo.ok) return logo;
	let drawn: Uint8Array | null = null;
	if (rendition && rendition.size > 0 && logo.type !== "image/png" && logo.type !== "image/jpeg") {
		const checked = await checkLogo(rendition, "image/png");
		if (!checked.ok) return checked;
		drawn = checked.bytes;
	}
	const before = await organisationBrandOf(organisationId);
	await env.BRAND.put(logoKey(organisationId), logo.bytes, {
		httpMetadata: { contentType: logo.type },
	});
	if (drawn) {
		await env.BRAND.put(renditionKey(organisationId), drawn, {
			httpMetadata: { contentType: "image/png" },
		});
	} else {
		await env.BRAND.delete(renditionKey(organisationId));
	}
	await drizzle(env.DB)
		.update(organisations)
		.set({
			brandLogoType: logo.type,
			brandLogoRendition: drawn !== null,
			brandLogoVersion: now,
			updatedAt: new Date(now),
		})
		.where(eq(organisations.id, organisationId));
	await recordChange(
		organisationId,
		actor,
		{ logo: before?.logo ? LOGO_NAMES[before.logo.type] : "none" },
		{ logo: LOGO_NAMES[logo.type] },
	);
	return { ok: true };
}

/** Removes the organisation's logo, if it has one, and records that. */
export async function removeLogo(
	organisationId: string,
	actor: string,
	now: number,
): Promise<void> {
	const before = await organisationBrandOf(organisationId);
	if (!before?.logo) return;
	await env.BRAND.delete([logoKey(organisationId), renditionKey(organisationId)]);
	await drizzle(env.DB)
		.update(organisations)
		.set({
			brandLogoType: null,
			brandLogoRendition: false,
			brandLogoVersion: null,
			updatedAt: new Date(now),
		})
		.where(eq(organisations.id, organisationId));
	await recordChange(
		organisationId,
		actor,
		{ logo: LOGO_NAMES[before.logo.type] },
		{ logo: "none" },
	);
}

/**
 * Sets the organisation's colour, or takes it away when `typed` is empty, and
 * records the change. A colour too light for white words on it is refused.
 */
export async function setBrandColour(
	organisationId: string,
	actor: string,
	typed: string,
	now: number,
): Promise<{ ok: true } | { ok: false; problem: string }> {
	let colour: string | null = null;
	if (typed.trim() !== "") {
		colour = normaliseColour(typed);
		if (!HEX_COLOUR.test(colour)) return { ok: false, problem: COLOUR_PROBLEM };
		if (contrastWithWhite(colour) < LEAST_CONTRAST) return { ok: false, problem: COLOUR_TOO_LIGHT };
	}
	const before = await organisationBrandOf(organisationId);
	if (!before || before.colour === colour) return { ok: true };
	await drizzle(env.DB)
		.update(organisations)
		.set({ brandColour: colour, updatedAt: new Date(now) })
		.where(eq(organisations.id, organisationId));
	await recordChange(
		organisationId,
		actor,
		{ colour: before.colour ?? "none" },
		{ colour: colour ?? "none" },
	);
	return { ok: true };
}
