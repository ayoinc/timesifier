import { Link, redirect } from "react-router";

import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { listOrganisations } from "~/organisations/api.server";
import { unavailable } from "~/organisations/outcome.server";
import { NEW_ORGANISATION_PATH, organisationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead } from "~/shell/PageHeading";

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
			<PageLead>Choose one to open.</PageLead>

			<div className="mt-10">
				<Ledger heading="Organisations" note={loaderData.organisations.length}>
					<LedgerRows>
						{loaderData.organisations.map(({ name, slug }) => (
							<LedgerRow
								key={slug}
								title={
									<Link to={organisationPath(slug)} className={`${TEXT_LINK} wrap-anywhere`}>
										{name}
									</Link>
								}
							/>
						))}
					</LedgerRows>
				</Ledger>
			</div>

			<p className="mt-10">
				<Link to={NEW_ORGANISATION_PATH} className={TEXT_LINK}>
					Create an organisation
				</Link>
			</p>
		</>
	);
}
