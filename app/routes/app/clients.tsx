import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading } from "~/shell/PageHeading";

// Clients: whom the organisation's projects are for. Shown to owners and
// admins while the organisation has Clients turned on (app/shell/destinations.ts).
// TS-011b builds it.

const { label } = destination("clients");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Clients() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<EmptySheet heading="Clients">
				The organisation's clients, and the projects that belong to each, will appear here.
			</EmptySheet>
		</>
	);
}
