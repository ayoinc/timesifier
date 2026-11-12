import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import * as z from "zod";
import { MadeWith, OrganisationHeader } from "~/brand/OrganisationParts";
import { organisationBrandOf } from "~/brand/organisation-brand.server";
import { Button } from "~/components/Button";
import { estimateForLink, organisationScope } from "~/db";
import {
	decideByClient,
	ESTIMATE_LABELS,
	EstimateStatus,
	isEstimateToken,
	printedEstimate,
} from "~/estimates/estimates.server";
import { PrintedSheet } from "~/invoices/DocumentParts";
import { readForm } from "~/invoices/form.server";
import { estimateLinkPath } from "~/invoices/paths";
import { notFound } from "~/organisations/membership.server";
import { negotiateLocale } from "~/shell/locale";
import { OUTSIDE_FRAME, OUTSIDE_MAIN } from "~/shell/Outside";
import { PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/estimate.$id.$token";

// An estimate's link (TS-077): the client reads the estimate without signing
// in, and accepts or declines it once while it is sent. The link's token is
// a keyed hash of the estimate's id; a wrong token is answered exactly as an
// estimate that does not exist, so the link proves nothing it does not hold.
// The page is the organisation's (TS-100): its colour, logo and name lead, and
// the product keeps a small line at the foot.

export function meta({ loaderData }: Route.MetaArgs) {
	return [
		{ title: loaderData ? `Estimate ${loaderData.number} · Timesifier` : "Timesifier" },
		{ name: "robots", content: "noindex" },
	];
}

/** The estimate the link proves, and its organisation's scope, or a 404 for anything else. */
async function proved(id: string, token: string) {
	// Both are asked every time, so a missing estimate and a wrong token take the same path.
	const [estimate, valid] = await Promise.all([
		estimateForLink(env.DB, id),
		isEstimateToken(id, token),
	]);
	if (!estimate || !valid) throw notFound();
	const brand = await organisationBrandOf(estimate.organisationId);
	if (!brand) throw notFound();
	return {
		estimate,
		organisationName: brand.name,
		brand,
		scope: organisationScope(env.DB, estimate.organisationId),
	};
}

const Decision = z.object({ decision: z.enum(["accepted", "declined"]) });

export async function loader({ request, params }: Route.LoaderArgs) {
	const { estimate, organisationName, brand, scope } = await proved(params.id, params.token);
	const locale = negotiateLocale(request.headers.get("Accept-Language"));
	return {
		number: estimate.number,
		organisationName,
		/** Whether the organisation has a logo, at the link's own address; and its colour. */
		hasLogo: brand.logo !== null,
		colour: brand.colour,
		status: estimate.status,
		label: ESTIMATE_LABELS[EstimateStatus.parse(estimate.status)],
		printed: await printedEstimate(scope, organisationName, estimate, locale),
	};
}

export async function action({ request, params }: Route.ActionArgs) {
	const { estimate, scope } = await proved(params.id, params.token);
	const form = await readForm(request, Decision);
	if ("refusal" in form) return form.refusal;
	const decided = await decideByClient(scope, estimate.id, form.input.decision, new Date());
	if (!decided) throw notFound();
	return decided.recorded
		? { ok: true as const, said: `Thank you. The estimate is ${decided.status}.` }
		: {
				ok: false as const,
				problem: `This estimate is ${decided.status} already, so it cannot be answered again.`,
				fields: {},
			};
}

export default function EstimateLink({ loaderData, actionData, params }: Route.ComponentProps) {
	const { printed, status } = loaderData;
	const busy = useNavigation().state !== "idle";
	const link = estimateLinkPath(params.id, params.token);
	return (
		<div className={OUTSIDE_FRAME}>
			<OrganisationHeader
				name={loaderData.organisationName}
				logo={loaderData.hasLogo ? `${link}/logo` : null}
				colour={loaderData.colour}
			/>
			<main className={OUTSIDE_MAIN}>
				<PageHeading>Estimate {loaderData.number}</PageHeading>
				<PageLead>
					From {loaderData.organisationName}. {loaderData.label}.
				</PageLead>
				<div className="mt-8">
					<PrintedSheet printed={printed} />
				</div>
				{status === "sent" && !actionData?.ok && (
					<Form method="post" className="mt-8 flex flex-wrap gap-4">
						<Button type="submit" name="decision" value="accepted" isDisabled={busy}>
							Accept estimate
						</Button>
						<Button
							type="submit"
							name="decision"
							value="declined"
							variant="outlined"
							isDisabled={busy}
						>
							Decline estimate
						</Button>
					</Form>
				)}
				<p role="status" className="mt-4 text-body-large empty:hidden">
					{actionData?.ok ? actionData.said : null}
				</p>
				<p role="alert" className="mt-4 text-body-large text-error empty:hidden">
					{actionData && !actionData.ok ? actionData.problem : null}
				</p>
			</main>
			<MadeWith />
		</div>
	);
}
