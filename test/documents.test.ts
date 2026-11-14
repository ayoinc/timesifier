import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deploymentOperator } from "~/landing/operator";
import { PRIVACY_EMAIL, PRIVACY_PATH, TERMS_PATH } from "~/landing/Site";
import { SIGN_IN_PATH } from "~/routes/auth/paths";

import { ORIGIN } from "./auth/harness";

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

it.each(["/", SIGN_IN_PATH, PRIVACY_PATH, TERMS_PATH])(
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

it("the privacy notice says which company answers for what is stored", async () => {
	const notice = wordsOf(await page(PRIVACY_PATH), "main");

	expect(notice).toContain(operatorSentences());
	expect(notice).toContain("Data protection law calls it the controller.");
});

it("the home page links to both", async () => {
	const html = await page("/");
	expect(html).toContain(`href="${PRIVACY_PATH}"`);
	expect(html).toContain(`href="${TERMS_PATH}"`);
});
