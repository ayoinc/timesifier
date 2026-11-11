import { Link, redirect } from "react-router";

import { listOrganisations } from "~/organisations/api.server";
import { unavailable } from "~/organisations/outcome.server";
import { NEW_ORGANISATION_PATH, organisationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading } from "~/shell/PageHeading";

import type { Route } from "./+types/index";

// `/app`: where a signed-in person goes when no organisation is named. With
// one organisation that is where they go; with none, they create one; with
// several, they choose.

export function meta() {
	return [{ title: "Your organisations · Timesifier" }];
}

export async function loader({ request }: Route.LoaderArgs) {
	const organisations = await listOrganisations(request);
	if (!organisations.ok) throw unavailable(organisations);

	const [first, ...others] = organisations.data;
	if (!first) throw redirect(NEW_ORGANISATION_PATH);
	if (others.length === 0) throw redirect(organisationPath(first.slug));
	return { organisations: organisations.data };
}

export default function Organisations({ loaderData }: Route.ComponentProps) {
	return (
		<>
			<PageHeading>Your organisations</PageHeading>
			<p className="mt-2 text-body-large text-on-surface-variant">Choose one to open.</p>

			<ul className="mt-6 flex flex-col gap-2">
				{loaderData.organisations.map(({ name, slug }) => (
					<li key={slug}>
						<Link
							to={organisationPath(slug)}
							className="flex min-h-14 items-center rounded-medium px-4 py-3 text-body-large text-on-surface outline-none over-surface-container state-layer transition-control hover:state-hover focus-visible:focus-indicator focus-visible:state-focus active:state-pressed"
						>
							{name}
						</Link>
					</li>
				))}
			</ul>

			<p className="mt-6">
				<Link to={NEW_ORGANISATION_PATH} className={TEXT_LINK}>
					Create an organisation
				</Link>
			</p>
		</>
	);
}
