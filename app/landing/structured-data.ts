import type { Operator } from "./operator";

/** The mark on its square, as the browser's install icon shows it: 512 by 512. */
const LOGO_PATH = "/icon-512.png";

/**
 * What the home page tells a search engine about who and what Timesifier is
 * (`docs/decisions.md`, entries 43 and 46). The organisation is the brand,
 * with the registered name and number of the company that runs the deployment,
 * read from the same settings as the foot of the page; where there is no
 * company to name, the brand alone. Google documents `legalName` but no
 * property for a company's registration number, so the number is schema.org's
 * `identifier`. The application carries no price and no rating: it has neither
 * to state. It is a data block, not a script: the browser runs nothing from it,
 * so it needs no nonce.
 */
export function homeStructuredData(origin: string, description: string, operator?: Operator) {
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "Organization",
				name: "Timesifier",
				url: `${origin}/`,
				logo: `${origin}${LOGO_PATH}`,
				...(operator && {
					legalName: operator.name,
					identifier: {
						"@type": "PropertyValue",
						propertyID: "Company number",
						value: operator.companyNumber,
					},
				}),
			},
			{
				"@type": "SoftwareApplication",
				name: "Timesifier",
				url: `${origin}/`,
				description,
				applicationCategory: "BusinessApplication",
				operatingSystem: "Web",
			},
		],
	};
}
