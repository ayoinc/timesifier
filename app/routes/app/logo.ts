import { logoFile, logoResponse, organisationBrandOf } from "~/brand/organisation-brand.server";
import { membershipContext, notFound } from "~/organisations/membership.server";

import type { Route } from "./+types/logo";

// The organisation's logo (TS-100), as uploaded, for the band of every page and
// Workspace settings. It sits below the organisation, so the layout answers 404
// to anybody who is not a member; every member sees it. The file's key is built
// from the organisation's id, never from the request.

export async function loader({ context }: Route.LoaderArgs) {
	const { organisation } = context.get(membershipContext);
	const brand = await organisationBrandOf(organisation.id);
	if (!brand?.logo) throw notFound();
	const file = await logoFile(organisation.id);
	if (!file) throw notFound();
	return logoResponse(file, brand.logo.type);
}
