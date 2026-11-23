import { env } from "cloudflare:workers";

import { BuyerPage } from "~/landing/BuyerPage";
import { deploymentOperator, OperatorDetails } from "~/landing/operator";
import { SECTION, SectionHead } from "~/landing/Section";
import {
	CONTACT_PATH,
	HELLO_EMAIL,
	LINK,
	PRIVACY_EMAIL,
	pageMeta,
	rootOrigin,
	SECURITY_EMAIL,
} from "~/landing/Site";

import type { Route } from "./+types/contact";

// How to reach the company that runs Timesifier (TS-106, the owner's answer
// 10): an email address, no form and no script, with the company's details
// from the deployment's settings (TS-121). It promises no time to answer: the
// owner has given none.

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: CONTACT_PATH,
		title: "Contact · Timesifier",
		description:
			"How to reach the company that runs Timesifier: one email address for everything, the addresses for privacy and security, and the company's registered details.",
	});
}

/** The company that runs this deployment, which the page and its foot name. */
export function loader() {
	return { operator: deploymentOperator(env) };
}

const ADDRESSES = [
	{
		email: HELLO_EMAIL,
		for: "Anything else: a question about Timesifier or its plans, a problem, or an idea.",
	},
	{
		email: PRIVACY_EMAIL,
		for: "Your personal data, and your rights over it under the privacy notice.",
	},
	{
		email: SECURITY_EMAIL,
		for: "A security weakness you have found, or a request about accessibility.",
	},
] as const;

export default function Contact({ loaderData: { operator } }: Route.ComponentProps) {
	return (
		<BuyerPage
			path={CONTACT_PATH}
			title="Write to us."
			lead={
				<p>
					Email is the way to reach the company that runs Timesifier. Write to{" "}
					<a href={`mailto:${HELLO_EMAIL}`} className={LINK}>
						{HELLO_EMAIL}
					</a>{" "}
					about anything.
				</p>
			}
			operator={operator}
			invite={false}
		>
			<section aria-labelledby="addresses-heading" className={SECTION}>
				<SectionHead id="addresses-heading" title="The addresses">
					Three addresses, each for its own kind of question.
				</SectionHead>
				<dl className="mt-10 grid expanded:grid-cols-3 expanded:gap-8">
					{ADDRESSES.map(({ email, for: purpose }) => (
						<div key={email} className="border-t border-outline-variant py-4">
							<dt className="text-title-medium">
								<a href={`mailto:${email}`} className={LINK}>
									{email}
								</a>
							</dt>
							<dd className="mt-1 text-body-large text-on-surface-variant">{purpose}</dd>
						</div>
					))}
				</dl>
			</section>

			<section aria-labelledby="company-heading" className="border-t border-outline-variant">
				<div className={SECTION}>
					<SectionHead id="company-heading" title="The company">
						<OperatorDetails operator={operator} />
					</SectionHead>
					<dl className="mt-10 grid gap-x-8 medium:grid-cols-2 expanded:grid-cols-4">
						{[
							["Registered name", operator.name],
							["Company number", operator.companyNumber],
							["Registered in", operator.registeredIn],
							["Registered office", operator.registeredOffice],
						].map(([term, value]) => (
							<div key={term} className="border-t border-outline-variant py-4">
								<dt className="text-label-large text-on-surface-variant">{term}</dt>
								<dd className="mt-1 text-body-large">{value}</dd>
							</div>
						))}
					</dl>
				</div>
			</section>
		</BuyerPage>
	);
}
