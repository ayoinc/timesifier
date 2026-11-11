import type { Page } from "@playwright/test";

import {
	addAuthenticator,
	codeSentBy,
	newPerson,
	openAuthPage,
	ownAddress,
	TIME_WITH_TURNS,
	wrongCode,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { expect, test } from "./fixtures";

// What the pages say when the answer is no: a wrong code, a code tried too
// often, too many attempts, a code that has expired, a robot check that fails,
// and a passkey prompt that comes to nothing. No message says whether an
// address has an account.

test.use({ storageState: SIGNED_OUT });
test.describe.configure({ timeout: TIME_WITH_TURNS });

/** This test's own client address, for a request it makes without the page. */
let address: string;

test.beforeEach(async ({ context, baseURL }) => {
	address = await ownAddress(context, baseURL);
});

const SIGN_IN = "/api/auth/sign-in/email-otp";
const SEND = "/api/auth/email-otp/send-verification-otp";

/** The email-code path of the sign-in page, as far as the code field, with the code that was sent. */
async function askForCode(page: Page, email: string) {
	await openAuthPage(page, "/sign-in");
	await page.getByRole("button", { name: "Use an email code instead" }).click();
	await page.getByLabel("Email").fill(email);
	const code = await codeSentBy(() => page.getByRole("button", { name: "Continue" }).click());
	await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
	return code;
}

test.describe("a wrong code", () => {
	test.use({ refusals: { [SIGN_IN]: [400] } });

	test("is said to be wrong, and a new one signs in", async ({ page }) => {
		const { email } = newPerson();
		const first = await askForCode(page, email);

		await page.getByLabel("Code").fill(wrongCode(first));
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(page.getByRole("alert")).toHaveText(
			"That code is not right. Check it, or send a new one.",
		);
		await expect(page).toHaveURL("/sign-in");

		const second = await codeSentBy(() =>
			page.getByRole("button", { name: "Send a new code" }).click(),
		);
		await expect(page.getByRole("status")).toHaveText(
			"A new code has been asked for. Use the newest one you receive.",
		);
		await expect(page.getByLabel("Code")).toHaveValue("");

		await page.getByLabel("Code").fill(second);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(page).toHaveURL("/app");
	});
});

test.describe("too many attempts", () => {
	test.use({ refusals: { [SIGN_IN]: [400, 403, 429] } });

	test("the code stops working after three wrong tries, and the eleventh attempt in a minute is turned away", async ({
		page,
	}) => {
		const code = await askForCode(page, newPerson().email);
		await page.getByLabel("Code").fill(wrongCode(code));

		const answers: number[] = [];
		const said: string[] = [];
		for (let attempt = 1; attempt <= 11; attempt++) {
			const answered = page.waitForResponse((response) => response.url().endsWith(SIGN_IN));
			await page.getByRole("button", { name: "Sign in", exact: true }).click();
			answers.push((await answered).status());
			await expect(page.getByRole("alert")).not.toHaveText("");
			said.push((await page.getByRole("alert").textContent()) ?? "");
		}

		// Three wrong tries are allowed; the fourth finds the code used up, and
		// from then on there is no code. The eleventh attempt in the minute is not looked at.
		expect(answers.slice(0, 4)).toEqual([400, 400, 400, 403]);
		expect(said[0]).toBe("That code is not right. Check it, or send a new one.");
		expect(said[3]).toBe(
			"That code no longer works: it was entered wrongly too many times. Send a new one.",
		);
		expect(answers[10]).toBe(429);
		expect(said[10]).toBe("Too many attempts. Try again in a minute.");
		await expect(page).toHaveURL("/sign-in");
	});
});

test.describe("an expired code", () => {
	test.use({ refusals: { [SIGN_IN]: [400] } });

	test("is said to have expired, with the way to a new one beside it", async ({ page }) => {
		const code = await askForCode(page, newPerson().email);
		// A code lasts five minutes. The server's answer to one that has run out
		// is given here in its place; test/auth/email-code.test.ts shows the server gives it.
		await page.route(`**${SIGN_IN}`, (route) =>
			route.fulfill({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({ code: "OTP_EXPIRED", message: "OTP expired" }),
			}),
		);

		await page.getByLabel("Code").fill(code);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(page.getByRole("alert")).toHaveText("That code has expired. Send a new one.");
		await expect(page.getByRole("button", { name: "Send a new code" })).toBeVisible();
	});
});

test.describe("a robot check that fails", () => {
	// Cloudflare's published site key whose widget fails every check.
	const ALWAYS_PASSES = "1x00000000000000000000AA";
	const ALWAYS_FAILS = "2x00000000000000000000AB";

	test("stops the page from asking for a code, and the server refuses a request made anyway", async ({
		page,
	}) => {
		// The site key reaches the page in the loader's data. The server under test
		// has the key that passes, so the page is given the failing one on its way in.
		await page.route("**/sign-up", async (route) => {
			const response = await route.fetch();
			const html = await response.text();
			expect(html).toContain(ALWAYS_PASSES);
			await route.fulfill({ response, body: html.replaceAll(ALWAYS_PASSES, ALWAYS_FAILS) });
		});
		let asked = 0;
		page.on("request", (request) => {
			if (request.url().endsWith(SEND)) asked++;
		});

		const person = newPerson();
		await openAuthPage(page, "/sign-up");
		await page.getByLabel("Name").fill(person.name);
		await page.getByLabel("Email").fill(person.email);
		await page.getByRole("button", { name: "Continue" }).click();

		await expect(page.getByRole("alert")).toHaveText(
			"We could not check that you are not a robot. Reload the page and try again.",
		);
		await expect(
			page.getByRole("heading", { level: 1, name: "Create your account" }),
		).toBeVisible();
		expect(asked, "requests for a code made by the page").toBe(0);

		// Whoever skips the page gets no further: no token, and a token Turnstile never issued.
		// These two come from the test itself, so they name its address themselves.
		const data = { email: person.email, type: "sign-in" };
		const from = { "cf-connecting-ip": address };
		const without = await page.request.post(SEND, { data, headers: from });
		expect(without.status()).toBe(400);
		const forged = await page.request.post(SEND, {
			data,
			headers: { ...from, "x-captcha-response": "not-a-token-turnstile-issued" },
		});
		expect(forged.status()).toBe(403);
	});
});

test.describe("a passkey prompt that comes to nothing", () => {
	test("on the sign-in page says no passkey was used and keeps the email code in reach", async ({
		page,
	}) => {
		// An authenticator with nothing on it: the browser has no passkey to offer.
		await addAuthenticator(page);
		await openAuthPage(page, "/sign-in");
		await page.getByRole("button", { name: "Sign in with a passkey" }).click();

		await expect(page.getByRole("alert")).toHaveText(
			"No passkey was used. Try again, or use an email code instead.",
		);
		await expect(page.getByRole("button", { name: "Use an email code instead" })).toBeVisible();
		await expect(page).toHaveURL("/sign-in");
	});
});

test.describe("without script", () => {
	test.use({ javaScriptEnabled: false });

	test("the sign-in page says it needs JavaScript", async ({ page }) => {
		await page.goto("/sign-in");
		await expect(page.locator("main p").first()).toHaveText(
			"Signing in needs JavaScript. Turn it on for this site and reload the page.",
		);
	});

	test("the sign-up page says so too, and a press on Continue sends what was typed nowhere", async ({
		page,
	}) => {
		const person = newPerson();
		const requests: string[] = [];
		await page.goto("/sign-up");
		await expect(page.locator("main p").first()).toHaveText(
			"Creating an account needs JavaScript. Turn it on for this site and reload the page.",
		);

		page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
		await page.getByLabel("Name").fill(person.name);
		await page.getByLabel("Email").fill(person.email);
		await page.getByRole("button", { name: "Continue" }).click();

		// The name and the address are not put into the page's address, and nothing is asked of the server.
		await expect(page).toHaveURL("/sign-up");
		expect(requests).toEqual([]);
		await expect(page.getByLabel("Email")).toHaveValue(person.email);
	});
});
