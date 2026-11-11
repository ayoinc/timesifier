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
		</main>
	);
}
