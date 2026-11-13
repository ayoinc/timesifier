import { env } from "cloudflare:workers";

import { Ledger, LedgerRow, LedgerRows } from "~/components/Ledger";
import { organisationScope } from "~/db";
import { membershipContext, notFound } from "~/organisations/membership.server";
import { EmptySheet, PageHeading, PageLead, Section } from "~/shell/PageHeading";
import { LEAVE_DAYS, MINIMUM_GROUP, REGULARLY, WEEKS } from "~/wellbeing/wellbeing";
import { wellbeingSignals } from "~/wellbeing/wellbeing.server";
import type { Route } from "./+types/wellbeing";

// Wellbeing (TS-099): two rough shares of the organisation's people, for its
// owners alone. They are there to prompt a kind question, not to find anyone:
// no name is shown, each share is rounded to the nearest ten, and below
// MINIMUM_GROUP people nothing is shown at all. Admins are shown Workspace
// settings, which this page sits below, so the loader answers them with the
// 404 of a page they may not open. The page only reads; it has no action.

const TITLE = "Wellbeing";

export function meta() {
	return [{ title: `${TITLE} · Timesifier` }];
}

export async function loader({ context }: Route.LoaderArgs) {
	const { role, organisation } = context.get(membershipContext);
	if (role !== "owner") throw notFound();
	return wellbeingSignals(organisationScope(env.DB, organisation.id), new Date());
}

/** Roughly six months, as the leave share's sentence says it. */
const LEAVE_MONTHS = Math.round(LEAVE_DAYS / 30.4);

export default function Wellbeing({ loaderData }: Route.ComponentProps) {
	return (
		<>
			<PageHeading>{TITLE}</PageHeading>
			<PageLead>
				Two rough signs of how your people are doing, so you can notice when work is wearing someone
				down. No names are shown, and nobody at Timesifier ever sees this page.
			</PageLead>

			{loaderData.shown ? (
				<Section
					id="signals"
					heading="How your people are doing"
					lead={`Across all ${loaderData.people} people in your organisation, rounded to the nearest ten per cent so that no one person stands out.`}
					className="max-w-200"
				>
					<Ledger heading="Shares of your people">
						<LedgerRows>
							<LedgerRow
								title="Regularly over their hours"
								detail={`Worked more than their working week in ${REGULARLY} of the last ${WEEKS} weeks.`}
								value={`~${loaderData.overHours}%`}
							/>
							<LedgerRow
								title="No leave taken lately"
								detail={`Have had no approved leave in the last ${LEAVE_MONTHS} months.`}
								value={`~${loaderData.noLeave}%`}
							/>
						</LedgerRows>
					</Ledger>
					<p className="mt-4 max-w-160 text-body-medium text-on-surface-variant">
						A high share is worth a gentle word with your team as a whole: whether the work is
						spread fairly, and whether people feel able to take time off. It says nothing about any
						one person.
					</p>
				</Section>
			) : (
				<EmptySheet heading="Not shown yet">
					These signs appear once your organisation has {MINIMUM_GROUP} people or more. With fewer,
					a share could point at one person, so nothing is shown.
				</EmptySheet>
			)}
		</>
	);
}
