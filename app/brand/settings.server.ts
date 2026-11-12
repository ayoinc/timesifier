import * as z from "zod";

import { isAdministrator } from "~/organisations/access";
import type { Membership } from "~/organisations/membership.server";
import { declined, done } from "~/organisations/outcome.server";
import { NOT_ALLOWED } from "~/organisations/problems";

import {
	LOGO_MAX_BYTES,
	organisationBrandOf,
	removeLogo,
	saveLogo,
	setBrandColour,
} from "./organisation-brand.server";
import { logoPath } from "./paths";

/**
 * Workspace settings' Brand (TS-100): the forms that change the organisation's
 * logo and colour, which only its owners and admins send, and what the
 * section shows.
 */

/** The most a settings form may send: a logo, the PNG drawn from it, and room to say what is too large. */
export const SETTINGS_MAX_BYTES = 4 * LOGO_MAX_BYTES;

/** A file field: a file, or an empty string where nothing was chosen. */
const FileField = z.union([z.instanceof(File), z.literal("")]).optional();

export const BRAND_FORMS = [
	z.object({ intent: z.literal("brand-logo"), logo: FileField, rendition: FileField }),
	z.object({ intent: z.literal("remove-logo") }),
	z.object({ intent: z.literal("brand-colour"), colour: z.string().max(32) }),
] as const;

const BrandForm = z.discriminatedUnion("intent", [...BRAND_FORMS]);
export type BrandForm = z.infer<typeof BrandForm>;

/** What the section shows: the logo's address and kind, and the colour. */
export interface BrandData {
	logo: { path: string; kind: string } | null;
	colour: string | null;
}

const KINDS: Record<string, string> = {
	"image/png": "PNG",
	"image/jpeg": "JPEG",
	"image/webp": "WebP",
	"image/svg+xml": "SVG",
};

export async function brandData(organisation: { id: string; slug: string }): Promise<BrandData> {
	const brand = await organisationBrandOf(organisation.id);
	return {
		logo: brand?.logo
			? {
					path: logoPath(organisation.slug, brand.logo.version),
					kind: KINDS[brand.logo.type] ?? "",
				}
			: null,
		colour: brand?.colour ?? null,
	};
}

/** What one of the section's forms asks for, as `membership`, at `now`. */
export async function brandAction(input: BrandForm, membership: Membership, now: number) {
	const { organisation, role, user } = membership;
	if (!isAdministrator(role)) return declined(NOT_ALLOWED, 403);

	if (input.intent === "brand-logo") {
		if (!input.logo || (input.logo.size === 0 && input.logo.name === "")) {
			return declined("Choose the logo's file.");
		}
		const rendition = input.rendition instanceof File ? input.rendition : null;
		const saved = await saveLogo(organisation.id, user.id, input.logo, rendition, now);
		return saved.ok
			? done(`The logo is saved. It leads your documents and stands beside ${organisation.name}.`)
			: declined(saved.problem);
	}
	if (input.intent === "remove-logo") {
		await removeLogo(organisation.id, user.id, now);
		return done("The logo is removed. Your documents carry your name alone.");
	}
	const set = await setBrandColour(organisation.id, user.id, input.colour, now);
	if (!set.ok) return declined(set.problem);
	return done(
		input.colour.trim() === ""
			? "The colour is removed."
			: "The colour is saved. It leads your documents and the emails that carry them.",
	);
}
