import { env } from "cloudflare:workers";
import type { EmailImage, OrganisationLook } from "~/auth/email-frame";
import type { PdfArt, PdfImage } from "~/invoices/pdf";
import { channels } from "./colour";
import { deflate, jpegSpace, pngPixels } from "./images";
import { organisationLook } from "./organisation-brand.server";
import { getPlatformBrand, type PlatformBrand } from "./platform-brand.server";

/**
 * Everything a document an organisation sends its client is branded with
 * (TS-100), read once for a PDF, a message, or a ZIP of many: the
 * organisation's look, the platform's brand, and the two prepared as a PDF
 * embeds them.
 */
export interface DocumentBrand {
	look: OrganisationLook | null;
	platform: PlatformBrand;
	art: PdfArt;
}

/** `image` as a PDF embeds it: a JPEG as it is, a PNG's pixels and alpha compressed. Null when it cannot be. */
export async function pdfImage(image: EmailImage): Promise<PdfImage | null> {
	if (image.type === "image/jpeg") {
		const space = jpegSpace(image.bytes);
		return space ? { ...image, filter: "DCTDecode", space, data: image.bytes, alpha: null } : null;
	}
	const pixels = await pngPixels(image.bytes);
	if (!pixels) return null;
	return {
		width: pixels.width,
		height: pixels.height,
		filter: "FlateDecode",
		space: pixels.space,
		data: await deflate(pixels.colour),
		alpha: pixels.alpha ? await deflate(pixels.alpha) : null,
	};
}

/** The brand of the documents `organisationId` sends. */
export async function documentBrand(organisationId: string): Promise<DocumentBrand> {
	const [look, platform] = await Promise.all([
		organisationLook(organisationId),
		getPlatformBrand(env),
	]);
	const [logo, mark] = await Promise.all([
		look?.logo ? pdfImage(look.logo) : null,
		pdfImage({ ...platform.markLight, type: "image/png" }),
	]);
	return {
		look,
		platform,
		art: {
			author: look?.name ?? null,
			logo,
			colour: look?.colour ? channels(look.colour) : null,
			mark,
		},
	};
}
