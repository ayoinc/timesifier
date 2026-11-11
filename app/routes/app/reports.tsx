import { destination } from "~/shell/destinations";
import { PageHeading } from "~/shell/PageHeading";

const { label } = destination("reports");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Reports() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<p className="mt-2 text-body-large text-on-surface-variant">
				Totals of your tracked time by project, client and day will appear here.
			</p>
		</>
	);
}
