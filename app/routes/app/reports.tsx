import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading } from "~/shell/PageHeading";

const { label } = destination("reports");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Reports() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<EmptySheet heading="Tracked time">
				Totals of your tracked time by project, client and day will appear here.
			</EmptySheet>
		</>
	);
}
