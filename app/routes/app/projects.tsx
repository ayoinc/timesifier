import { destination } from "~/shell/destinations";
import { EmptySheet, PageHeading } from "~/shell/PageHeading";

const { label } = destination("projects");

export function meta() {
	return [{ title: `${label} · Timesifier` }];
}

export default function Projects() {
	return (
		<>
			<PageHeading>{label}</PageHeading>
			<EmptySheet heading="Projects">
				Your projects and the clients they belong to will appear here.
			</EmptySheet>
		</>
	);
}
