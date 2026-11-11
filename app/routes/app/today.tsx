import { destination } from "~/shell/destinations";
import { PageHeading } from "~/shell/PageHeading";

const { label } = destination("today");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Today() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<p className="mt-2 text-body-large text-on-surface-variant">
				Your running timer and the entries you track today will appear here.
			</p>
		</>
	);
}
