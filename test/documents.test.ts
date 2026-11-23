import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deploymentOperator, icoReference } from "~/landing/operator";
import {
	ACCESSIBILITY_PATH,
	DPA_PATH,
	OUTSIDE_LINKS,
	PRICING_PATH,
	PRIVACY_EMAIL,
	PRIVACY_PATH,
	PUBLIC_PAGES,
	SECURITY_PATH,
	TERMS_PATH,
} from "~/landing/Site";
import { NOTICE_DAYS, PLAN_DETAILS, PLANS, priceInWords } from "~/plans/plans";

import { ORIGIN, setBinding } from "./auth/harness";

// The privacy notice and the terms, as the server sends them to anybody: no
// session, no script. What they claim is held to the facts in test/claims.test.ts.

async function page(path: string): Promise<string> {
	const response = await exports.default.fetch(`${ORIGIN}${path}`);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toContain("text/html");
	return response.text();
}

describe.each([PRIVACY_PATH, TERMS_PATH])("%s", (path) => {
	it("is answered whole by the server, with the date of its version and the address to write to", async () => {
		const html = await page(path);

		expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
		expect(html).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}"/i);
		expect(html).toContain(`href="mailto:${PRIVACY_EMAIL}"`);
	});

	it("links to the other of the two", async () => {
		const other = path === PRIVACY_PATH ? TERMS_PATH : PRIVACY_PATH;
		expect(await page(path)).toContain(`href="${other}"`);
	});
});

// A company's website must show its registered name, its number, where it is
// registered and its registered office (TS-121). The company is the
// deployment's, from its settings: the pages hold no company of their own.

/** The words of one element of a page, as a person reads them. */
function wordsOf(html: string, element: "main" | "footer"): string {
	const [, inside] = html.match(new RegExp(`<${element}\\b[^>]*>(.*)</${element}>`, "s")) ?? [];
	expect(inside, element).toBeDefined();
	return (inside ?? "")
		.replace(/<!--.*?-->/gs, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ");
}

/** Who runs this deployment, as every page that says it says it. */
function operatorSentences(): string {
	const { name, companyNumber, registeredIn, registeredOffice } = deploymentOperator(env);
	return `Timesifier is operated by ${name}, a company registered in ${registeredIn} with company number ${companyNumber}. Its registered office is ${registeredOffice}.`;
}

it.each(PUBLIC_PAGES)(
	"the foot of %s names the company that runs this deployment, its number, where it is registered and its registered office",
	async (path) => {
		expect(wordsOf(await page(path), "footer")).toContain(operatorSentences());
	},
);

it("the terms say which company they are with", async () => {
	const terms = wordsOf(await page(TERMS_PATH), "main");

	expect(terms).toContain(operatorSentences());
	expect(terms).toContain("These terms are between you and that company.");
});

it("the privacy notice names each organisation the controller of its work, and the company its processor and the controller of the rest", async () => {
	const notice = wordsOf(await page(PRIVACY_PATH), "main");

	expect(notice).toContain(operatorSentences());
	expect(notice).toContain("Each organisation is the controller of its people");
	expect(notice).toContain("the company processes it for the organisation, as its processor");
	expect(notice).toContain(
		"The company remains the controller of your account, your sessions and sign-ins",
	);
});

it("the home page links to both", async () => {
	const html = await page("/");
	expect(html).toContain(`href="${PRIVACY_PATH}"`);
	expect(html).toContain(`href="${TERMS_PATH}"`);
});

it("the terms' Price section says what the pricing page says, from the same prices", async () => {
	const terms = wordsOf(await page(TERMS_PATH), "main");
	const pricing = wordsOf(await page(PRICING_PATH), "main");

	expect(terms).toContain("Timesifier is free until payment opens.");
	expect(pricing).toContain("Free until payment opens.");
	for (const plan of PLANS) {
		const { label, seats } = PLAN_DETAILS[plan];
		expect(terms, plan).toContain(`${label}, up to ${seats} people ${priceInWords(plan)}.`);
		expect(pricing, plan).toContain(`${label} Up to ${seats} people`);
	}
	expect(terms).toContain("excluding VAT");
	expect(pricing).toContain("exclude VAT");
	for (const text of [terms, pricing]) {
		expect(text).toContain(`told at least ${NOTICE_DAYS} days before its first charge`);
	}
});

it.each([SECURITY_PATH, ACCESSIBILITY_PATH, DPA_PATH])(
	"%s is answered whole by the server, with its date, and says which company runs Timesifier",
	async (path) => {
		const html = await page(path);

		expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
		expect(html).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}"/i);
		expect(html).toContain('href="mailto:security@timesifier.com"');
	},
);

it("the terms incorporate the data processing agreement, which offers a signed copy on request", async () => {
	const terms = await page(TERMS_PATH);
	const processing = terms.match(/<section id="processing"[\s\S]*?<\/section>/)?.[0] ?? "";
	expect(processing).toContain("Processing your organisation&#x27;s data");
	expect(processing).toContain(`href="${DPA_PATH}"`);
	expect(wordsOf(terms, "main")).toContain("sets out how, and is part of these terms.");

	const dpa = wordsOf(await page(DPA_PATH), "main");
	expect(dpa).toContain(operatorSentences());
	expect(dpa).toContain(
		"A copy signed by the company is available on request, from security@timesifier.com",
	);
	expect(await page(DPA_PATH)).toContain(`href="${TERMS_PATH}"`);
});

// The company's registration with the ICO (TS-105) is optional: shown from its
// setting when the deployment has one, and nothing said of the ICO when not.
describe("the ICO reference", () => {
	it("the ICO reference is the setting's", async () => {
		const reference = icoReference(env);
		expect(reference).toBe("ZA000000");

		for (const path of [PRIVACY_PATH, SECURITY_PATH]) {
			const main = wordsOf(await page(path), "main").replace(/&#x27;/g, "'");
			expect(main, path).toContain(
				`registered with the Information Commissioner's Office, the UK's data protection authority, under the reference ${reference}`,
			);
			expect(await page(path), path).toContain(`href="${OUTSIDE_LINKS.icoRegister.href}"`);
		}
	});

	it("without the setting, no page says anything of the ICO", async () => {
		setBinding("OPERATOR_ICO_REFERENCE", undefined);

		for (const path of ["/", PRIVACY_PATH, TERMS_PATH, SECURITY_PATH, ACCESSIBILITY_PATH]) {
			const html = await page(path);
			expect(html, path).not.toMatch(/Information Commissioner|\bICO\b/);
			expect(html, path).not.toContain(OUTSIDE_LINKS.icoRegister.href);
		}
	});
});
