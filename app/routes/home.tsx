import { Link } from "react-router";

import { APP_PATH } from "~/shell/destinations";

import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Timesifier" },
		{
			name: "description",
			content: "Understand and improve how you use your time.",
		},
	];
}

export default function Home() {
	return (
		<main className="mx-auto max-w-2xl p-8">
			<h1 className="text-headline-medium">Timesifier</h1>
			<p className="mt-2 text-body-large">Understand and improve how you use your time.</p>
			<p className="mt-6">
				<Link
					to={APP_PATH}
					className="rounded-extra-small text-label-large text-primary underline underline-offset-4 outline-none focus-visible:focus-indicator"
				>
					Open Timesifier
				</Link>
			</p>
		</main>
	);
}
