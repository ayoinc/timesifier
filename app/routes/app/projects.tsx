import { destination } from "~/shell/destinations";
import { PageHeading } from "~/shell/PageHeading";

const { label } = destination("projects");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Projects() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<p className="mt-2 text-body-large text-on-surface-variant">
				Your projects and the clients they belong to will appear here.
			</p>
		</>
	);
}
