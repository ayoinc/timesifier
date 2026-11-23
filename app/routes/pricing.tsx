import { env } from "cloudflare:workers";

import { BuyerPage } from "~/landing/BuyerPage";
import { CAPABILITIES } from "~/landing/capabilities";
import { deploymentOperator } from "~/landing/operator";
import { SECTION, SectionHead } from "~/landing/Section";
import {
	FEATURES_PATH,
	LINK,
	PRICING_PATH,
	pageMeta,
	rootOrigin,
	TERMS_PATH,
} from "~/landing/Site";
import { NOTICE_DAYS, PLAN_DETAILS, PLANS, PRICES, pounds } from "~/plans/plans";

import type { Route } from "./+types/pricing";

// What Timesifier will cost, and what it costs today (TS-106, the owner's
// answers 8 and 9; decision 64). The plans and their seats are the console's
// (TS-099), the prices `PRICES`: the page names no number of its own. The
// plans differ in the people they hold, never in what they can do, so every
// capability on the features page is on every plan.

export function meta({ matches }: Route.MetaArgs) {
	return pageMeta({
		origin: rootOrigin(matches),
		path: PRICING_PATH,
		title: "Pricing · Timesifier",
		description:
			"Timesifier is free until payment opens. Then Free for up to 5 people, Team for 25 and Business for 100, priced a person a month in pounds, excluding VAT.",
	});
}

/** The company that runs this deployment, which the foot names. */
export function loader() {
	return { operator: deploymentOperator(env) };
}

/** Sign-in for companies (TS-104), as the owner decided it is to be offered on the plans (answer 8). */
const COMPANY_SIGN_IN = {
	everyPlan: [
		"Sign in with Google or with a Microsoft work or school account",
		"Require company sign-in for an organisation",
		"Verified email domains",
	],
	business: "SAML single sign-on, on request",
} as const;

export default function Pricing({ loaderData: { operator } }: Route.ComponentProps) {
	return (
		<BuyerPage
			path={PRICING_PATH}
			title="Free until payment opens."
			lead={
				<p>
					Then one price a person a month, by the number of people an organisation holds. Every plan
					has everything Timesifier does. Prices are in pounds sterling and exclude VAT.
				</p>
			}
			operator={operator}
		>
			<section aria-labelledby="plans-heading" className={SECTION}>
				<h2 id="plans-heading" className="sr-only">
					The plans
				</h2>
				<ul className="grid gap-6 expanded:grid-cols-3">
					{PLANS.map((plan) => {
						const { label, seats } = PLAN_DETAILS[plan];
						const { monthly, billedYearly } = PRICES[plan];
						return (
							<li
								key={plan}
								className="flex flex-col rounded-large border border-outline-variant p-6"
							>
								<h3 className="text-headline-small">{label}</h3>
								<p className="mt-1 text-body-large text-on-surface-variant">Up to {seats} people</p>
								<p className="mt-8 flex items-baseline gap-2">
									<span className="text-display-medium tabular-nums">{pounds(monthly)}</span>
									{monthly > 0 && (
										<span className="text-body-large text-on-surface-variant">
											a person a month
										</span>
									)}
								</p>
								<p className="mt-2 text-body-large text-on-surface-variant">
									{monthly > 0 ? `or ${pounds(billedYearly)} billed yearly` : "Always"}
								</p>
								<p className="mt-8 border-t border-outline-variant pt-4 text-body-large">
									Everything Timesifier does
								</p>
							</li>
						);
					})}
				</ul>
				<p className="mt-6 text-body-medium text-on-surface-variant">
					Excluding VAT, which is added at the rate in force. A person is anyone the organisation
					holds: its members, and the people invited who have not yet joined.
				</p>
			</section>

			<section aria-labelledby="until-heading" className="border-t border-outline-variant">
				<div className={SECTION}>
					<SectionHead id="until-heading" title="Nothing to pay today.">
						Timesifier is free for every organisation until payment opens. Each organisation is told
						at least {NOTICE_DAYS} days before its first charge, and nothing is charged for the time
						before it.
					</SectionHead>
					<p className="mt-8 text-body-large">
						<a href={`${TERMS_PATH}#price`} className={LINK}>
							The terms say the same
						</a>
					</p>
				</div>
			</section>

			<section aria-labelledby="every-heading" className="border-t border-outline-variant">
				<div className={SECTION}>
					<SectionHead id="every-heading" title="Every plan has all of it.">
						The plans differ in the people they hold, never in what those people can do.
					</SectionHead>
					<ul className="mt-10 grid gap-x-8 medium:grid-cols-2 expanded:grid-cols-4">
						{CAPABILITIES.map(({ id, title }) => (
							<li key={id} className="border-t border-outline-variant py-4 text-title-medium">
								<a href={`${FEATURES_PATH}#${id}`} className={LINK}>
									{title}
								</a>
							</li>
						))}
					</ul>
				</div>
			</section>

			<section
				aria-labelledby="company-sign-in-heading"
				className="border-t border-outline-variant"
			>
				<div className={SECTION}>
					<SectionHead id="company-sign-in-heading" title="Company sign-in, being built.">
						Today a person signs in with a code sent to their email address. When sign-in for
						companies arrives, it comes to the plans as follows.
					</SectionHead>
					<dl className="mt-10 grid gap-x-8 expanded:grid-cols-2">
						<div className="border-t border-outline-variant py-4">
							<dt className="text-title-medium">On every plan</dt>
							<dd className="mt-1 text-body-large text-on-surface-variant">
								<ul className="flex flex-col gap-1">
									{COMPANY_SIGN_IN.everyPlan.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							</dd>
						</div>
						<div className="border-t border-outline-variant py-4">
							<dt className="text-title-medium">On Business</dt>
							<dd className="mt-1 text-body-large text-on-surface-variant">
								{COMPANY_SIGN_IN.business}
							</dd>
						</div>
					</dl>
				</div>
			</section>
		</BuyerPage>
	);
}
