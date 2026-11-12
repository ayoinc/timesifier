import { env } from "cloudflare:workers";

import { logoFile, logoResponse, organisationBrandOf } from "~/brand/organisation-brand.server";
import { estimateForLink } from "~/db";
import { isEstimateToken } from "~/estimates/estimates.server";
import { notFound } from "~/organisations/membership.server";

import type { Route } from "./+types/estimate.$id.$token.logo";

// The logo of an estimate's organisation (TS-100), for the client who opens the
// estimate's link without signing in. The link's token is proved exactly as the
// estimate's page proves it; a wrong token, a missing estimate and an
// organisation with no logo all get the same 404.

export async function loader({ params }: Route.LoaderArgs) {
	const [estimate, valid] = await Promise.all([
		estimateForLink(env.DB, params.id),
		isEstimateToken(params.id, params.token),
	]);
	if (!estimate || !valid) throw notFound();
	const brand = await organisationBrandOf(estimate.organisationId);
	if (!brand?.logo) throw notFound();
	const file = await logoFile(estimate.organisationId);
	if (!file) throw notFound();
	return logoResponse(file, brand.logo.type);
}
