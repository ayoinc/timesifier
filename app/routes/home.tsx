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
			<h1 className="text-3xl font-semibold">Timesifier</h1>
			<p className="mt-2">Understand and improve how you use your time.</p>
		</main>
	);
}
