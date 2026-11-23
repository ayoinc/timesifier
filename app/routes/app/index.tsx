import { useEffect, useState } from "react";
import { Link, redirect, useFetcher } from "react-router";
import * as z from "zod";

import { Button } from "~/components/Button";
import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { parseRequest } from "~/lib/validate";
import { listOrganisations } from "~/organisations/api.server";
import { joinableOrganisations, joinByDomain } from "~/organisations/domains.server";
import { declined, unavailable } from "~/organisations/outcome.server";
import type { Outcome } from "~/organisations/problems";
import { signedInContext } from "~/routes/auth/session.server";
import { NEW_ORGANISATION_PATH, organisationPath } from "~/shell/destinations";
import { TEXT_LINK } from "~/shell/links";
import { PageHeading, PageLead, Section } from "~/shell/PageHeading";

import type { Route } from "./+types/index";

// `/app`: where a signed-in person goes when no organisation is named. With
// one organisation that is where they go; with none, they create one; with
// several, they choose. A person whose verified address is at a domain an
// organisation has verified, with joining on (TS-104 slice 104c), is offered
// "Join" here first, so this page is shown to them whatever they belong to.

export function meta() {
	return [{ title: "Your organisations · Timesifier" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const signedIn = context.get(signedInContext);
	const [organisations, joinable] = await Promise.all([
		listOrganisations(request),
		joinableOrganisations(signedIn, new Date()),
	]);
	if (!organisations.ok) throw unavailable(organisations);

	const [first, ...others] = organisations.data;
	if (joinable.length === 0) {
		if (!first) throw redirect(NEW_ORGANISATION_PATH);
		if (others.length === 0) throw redirect(organisationPath(first.slug));
	}
	return { organisations: organisations.data, joinable };
}

const form = z.object({ intent: z.literal("join"), organisationId: z.string().min(1).max(64) });

export async function action({ request, context }: Route.ActionArgs) {
	const signedIn = context.get(signedInContext);
	const { organisationId } = await parseRequest(request, form);
	const joined = await joinByDomain(signedIn, organisationId, new Date());
	if (joined.ok) throw redirect(organisationPath(joined.slug));
	return joined.problem === "full"
		? declined(
				`${joined.name} has no free seat, so you can't join yet. Ask one of its owners for another seat.`,
				409,
			)
		: declined(
				"You can't join that organisation on your own now. Sign in again with a code sent to your address, or ask one of its owners for an invitation.",
				404,
			);
}

export default function Organisations({ loaderData }: Route.ComponentProps) {
	const { organisations, joinable } = loaderData;
	return (
		<>
			<PageHeading>Your organisations</PageHeading>
			<PageLead>
				{organisations.length > 0 ? "Choose one to open." : "Join your company's, or create one."}
			</PageLead>

			{joinable.length > 0 && (
				<Section
					id="join"
					heading="You can join"
					lead="Your email address is at a domain these organisations have verified."
				>
					<Ledger heading="Organisations you can join" note={joinable.length}>
						<LedgerRows>
							{joinable.map((place) => (
								<JoinRow key={place.organisationId} place={place} />
							))}
						</LedgerRows>
					</Ledger>
				</Section>
			)}

			{organisations.length > 0 && (
				<div className="mt-10">
					<Ledger heading="Organisations" note={organisations.length}>
						<LedgerRows>
							{organisations.map(({ name, slug }) => (
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
			)}

			<p className="mt-10">
				<Link to={NEW_ORGANISATION_PATH} className={TEXT_LINK}>
					Create an organisation
				</Link>
			</p>
		</>
	);
}

/** One organisation the person may join, with "Join Acme", and why not when it is full. */
function JoinRow({ place }: { place: Route.ComponentProps["loaderData"]["joinable"][number] }) {
	const fetcher = useFetcher<Outcome>();
	const [problem, setProblem] = useState<string | null>(null);
	const answer = fetcher.state === "idle" ? fetcher.data : undefined;
	useEffect(() => {
		setProblem(answer && !answer.ok ? answer.problem : null);
	}, [answer]);
	return (
		<LedgerRow
			title={<span className="wrap-anywhere">{place.name}</span>}
			detail={
				<>
					People at {place.domain} may join as members.
					<span role="alert" className="block text-error empty:hidden">
						{problem}
					</span>
				</>
			}
			action={
				<Button
					isPending={fetcher.state !== "idle"}
					onPress={() =>
						fetcher.submit(
							{ intent: "join", organisationId: place.organisationId },
							{ method: "post" },
						)
					}
				>
					{`Join ${place.name}`}
				</Button>
			}
		/>
	);
}
