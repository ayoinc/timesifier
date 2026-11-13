import { platformLog } from "~/platform/events.server";
import { EmptySheet, PageHeading, PageLead } from "~/shell/PageHeading";

import type { Route } from "./+types/log";
import { EventLedger } from "./ConsoleParts";

// The platform log (TS-099): every step a platform owner took in the console,
// with the reason they gave, and every reading under support access. The
// application never changes or deletes a record of it.

const HEADING = "Log";

/** The most steps the page lists. */
const SHOWN = 200;

export function meta() {
	return [{ title: `${HEADING} · Timesifier` }];
}

export async function loader() {
	return { events: await platformLog({ limit: SHOWN }) };
}

export default function Log({ loaderData }: Route.ComponentProps) {
	const { events } = loaderData;
	return (
		<>
			<PageHeading>{HEADING}</PageHeading>
			<PageLead>
				Everything done in the platform console, newest first: who did it, to what, and the reason
				they gave. Nobody can change or remove what is here.
			</PageLead>
			{events.length === 0 ? (
				<EmptySheet heading="Nothing yet">Nothing has been done in the console yet.</EmptySheet>
			) : (
				<div className="mt-10">
					<EventLedger heading="Newest first" events={events} />
				</div>
			)}
		</>
	);
}
