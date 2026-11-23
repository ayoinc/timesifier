import { env } from "cloudflare:workers";
import type { ComponentType } from "react";

import { BuyerPage } from "~/landing/BuyerPage";
import { CAPABILITIES, type Capability, inWords, placeLabels } from "~/landing/capabilities";
import { deploymentOperator } from "~/landing/operator";
import { RunningDayProvider } from "~/landing/RunningDay";
import { SECTION, SectionHead } from "~/landing/Section";
import { FEATURES_PATH, INTEGRATIONS_PATH, LINK, PAGE, pageMeta, rootOrigin } from "~/landing/Site";
import { TimerStates } from "~/landing/TimerStates";
import { WeekReport } from "~/landing/WeekReport";

import type { Route } from "./+types/features";

// What Timesifier does, a section a capability (TS-106). The words are
// ~/landing/capabilities, which test/claims.test.ts holds to the application;
// the two drawings are the home page's, and say they are an example.

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: FEATURES_PATH,
		title: "Features · Timesifier",
		description:
			"What Timesifier does today: the timer and timesheets, approvals, leave, expenses, invoices and estimates, reports, roles and the activity log, and integrations.",
	});
}

/** The company that runs this deployment, which the foot names. */
export function loader() {
	return { operator: deploymentOperator(env) };
}

/** The drawing beside a capability, where it has one. */
const DRAWINGS: Partial<Record<string, ComponentType>> = {
	time: TimerStates,
	reports: WeekReport,
};

function CapabilitySection({ capability }: { capability: Capability }) {
	const { id, title, lead, points } = capability;
	const Drawing = DRAWINGS[id];
	return (
		<section id={id} aria-labelledby={`${id}-heading`} className="border-t border-outline-variant">
			<div className={SECTION}>
				<SectionHead id={`${id}-heading`} title={title}>
					{lead}
				</SectionHead>
				<div className="mt-10 grid gap-8 expanded:grid-cols-12">
					<p className="text-label-large text-on-surface-variant expanded:col-span-3">
						In Timesifier: {inWords(placeLabels(capability))}
					</p>
					<ul className="grid gap-x-8 expanded:col-span-9 expanded:grid-cols-2">
						{points.map((point) => (
							<li key={point} className="border-t border-outline-variant py-4 text-body-large">
								{point}
							</li>
						))}
					</ul>
				</div>
				{Drawing && (
					<div className="mt-12 expanded:grid expanded:grid-cols-12">
						<div className="expanded:col-span-9 expanded:col-start-4">
							<Drawing />
						</div>
					</div>
				)}
				{id === "integrations" && (
					<p className="mt-8 text-body-large">
						<a href={INTEGRATIONS_PATH} className={LINK}>
							Every integration, and the API reference
						</a>
					</p>
				)}
			</div>
		</section>
	);
}

export default function Features({ loaderData: { operator } }: Route.ComponentProps) {
	return (
		<RunningDayProvider>
			<BuyerPage
				path={FEATURES_PATH}
				title="Everything it does today."
				lead={
					<p>
						Timesifier is a timer and a weekly report, with timesheets, leave, expenses and invoices
						beside it. Each part below is in the application now, on every plan.
					</p>
				}
				operator={operator}
			>
				<nav aria-labelledby="features-contents" className={`${PAGE} py-10`}>
					<h2 id="features-contents" className="text-label-large text-on-surface-variant">
						On this page
					</h2>
					<ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-body-large">
						{CAPABILITIES.map(({ id, title }) => (
							<li key={id}>
								<a href={`#${id}`} className={LINK}>
									{title}
								</a>
							</li>
						))}
					</ul>
				</nav>
				{CAPABILITIES.map((capability) => (
					<CapabilitySection key={capability.id} capability={capability} />
				))}
			</BuyerPage>
		</RunningDayProvider>
	);
}
