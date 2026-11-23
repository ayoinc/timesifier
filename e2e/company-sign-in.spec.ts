import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "@playwright/test";

import { COLOR_SCHEME_COOKIE } from "../app/shell/color-scheme.server";
import { destinationPath, invitationsPath, signInSettingsPath } from "../app/shell/destinations";
import {
	foundInMessageSentBy,
	newPerson,
	openAuthPage,
	ownAddress,
	signIn,
	TIME_WITH_TURNS,
} from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { EMPTY_INPUT, problems } from "./axe";
import { expect, openShell, test } from "./fixtures";
import { createOrganisation, expectRefusal, INVITATION_LINK, invite } from "./organisation";

// Company sign-in (TS-104), in the "providers" project: against the server
// that has a client at Google and at Microsoft (playwright.config.ts). The
// sign-in page with its two buttons, Settings › Sign-in with its domains, and
// the page that tells a member their organisation asks for Microsoft: no WCAG
// 2.2 A or AA violation and every text's contrast measured, at 390 and 1280
// pixels wide, light and dark (rules 14 and 16).
//
// With SHOT_DIR set, each page is also photographed into it at each size and
// scheme, for a person to look at:
//
//   SHOT_DIR=~/Workspace/Personal/cmux-assets/browser/timesifier/TS-104 \
//     pnpm exec playwright test --project=providers

test.use({ storageState: SIGNED_OUT, reducedMotion: "reduce" });
test.describe.configure({ timeout: 4 * TIME_WITH_TURNS });

test.beforeEach(async ({ context, baseURL }) => {
	await ownAddress(context, baseURL);
});

const SHOT_DIR = process.env.SHOT_DIR;

const LOOKS = [390, 1280].flatMap((width) =>
	(["light", "dark"] as const).map((scheme) => ({
		viewport: { width, height: width === 390 ? 844 : 800 },
		scheme,
	})),
);

/**
 * Shows the page this test is on at each size and in each scheme in turn: the
 * scheme a person chose on My account, as the cookie it sets, and the page
 * loaded again. `check` scans it; `shots` names what is photographed of it:
 * a part, or the window's view of the page where it is null.
 */
async function inEveryLook(
	page: Page,
	baseURL: string | undefined,
	open: () => Promise<void>,
	check: (scheme: "light" | "dark") => Promise<void>,
	shots: Record<string, Locator | null>,
) {
	for (const { viewport, scheme } of LOOKS) {
		await page.setViewportSize(viewport);
		await chooseScheme(page.context(), baseURL, scheme);
		await open();
		expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toContain(
			scheme,
		);
		await check(scheme);
		if (!SHOT_DIR) continue;
		mkdirSync(SHOT_DIR, { recursive: true });
		// The scan may have scrolled; the page is photographed from its top.
		await page.evaluate(() => window.scrollTo(0, 0));
		for (const [name, part] of Object.entries(shots)) {
			const path = join(SHOT_DIR, `${name}-${viewport.width}-${scheme}.png`);
			await (part ? part.screenshot({ path }) : page.screenshot({ path }));
		}
	}
}

async function chooseScheme(
	context: BrowserContext,
	baseURL: string | undefined,
	scheme: "light" | "dark",
) {
	await context.addCookies([
		{
			name: COLOR_SCHEME_COOKIE,
			value: scheme,
			domain: new URL(baseURL ?? "http://localhost").hostname,
			path: "/",
			secure: true,
			sameSite: "Lax",
		},
	]);
}

async function expectNoProblems(page: Page, what: string, unmeasurable: string[] = []) {
	expect(await problems(page, unmeasurable), `problems in ${what}`).toEqual([]);
}

/**
 * Each provider's button in the colours its guidelines fix for the scheme
 * (decision 62), with its mark: one picture, hidden from assistive technology,
 * so the button's name is its words alone.
 */
const PROVIDER_LOOKS = {
	Google: {
		light: { fill: "#ffffff", text: "#1f1f1f", stroke: "#747775" },
		dark: { fill: "#131314", text: "#e3e3e3", stroke: "#8e918f" },
	},
	Microsoft: {
		light: { fill: "#ffffff", text: "#5e5e5e", stroke: "#8c8c8c" },
		dark: { fill: "#2f2f2f", text: "#ffffff", stroke: "#2f2f2f" },
	},
} as const;

/**
 * A computed colour as #rrggbb: `rgb(…)`, or `color(srgb …)` where the state
 * layer's color-mix() made it.
 */
function hexOf(computed: string): string {
	const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(computed);
	const rgb = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(computed);
	const channels = srgb
		? srgb.slice(1).map((channel) => Math.round(Number(channel) * 255))
		: rgb?.slice(1).map(Number);
	if (!channels) throw new Error(`not an opaque sRGB colour: ${computed}`);
	return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

async function expectProviderButton(
	page: Page,
	provider: keyof typeof PROVIDER_LOOKS,
	scheme: "light" | "dark",
) {
	const button = page.getByRole("button", { name: `Sign in with ${provider}`, exact: true });
	await expect(button.locator("svg")).toHaveCount(1);
	await expect(button.locator("svg")).toHaveAttribute("aria-hidden", "true");
	await expect(button.locator("svg")).toBeVisible();
	const shown = await button.evaluate((element) => {
		const style = getComputedStyle(element);
		return { fill: style.backgroundColor, text: style.color, stroke: style.borderTopColor };
	});
	expect({
		fill: hexOf(shown.fill),
		text: hexOf(shown.text),
		stroke: hexOf(shown.stroke),
	}).toEqual(PROVIDER_LOOKS[provider][scheme]);
}

/** The policy sheet of Settings › Sign-in, saved with `choice` and no tenant. */
async function requireOnly(page: Page, provider: "Google" | "Microsoft") {
	await page.getByRole("button", { name: "Change company sign-in" }).click();
	const sheet = page.getByRole("dialog", { name: "Company sign-in" });
	await sheet.getByText(`Only people signed in with ${provider}`, { exact: true }).click();
	await sheet.getByRole("button", { name: "Save" }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole("status")).toContainText(
		`Company sign-in with ${provider} is required`,
	);
}

test("the sign-in page offers Google and Microsoft beside the emailed code", async ({
	page,
	baseURL,
}) => {
	await inEveryLook(
		page,
		baseURL,
		() => openAuthPage(page),
		async (scheme) => {
			await expect(page.getByRole("heading", { level: 1, name: "Enter your email" })).toBeVisible();
			await expect(page.getByRole("button", { name: /^Sign in with / })).toHaveText([
				"Sign in with Google",
				"Sign in with Microsoft",
			]);
			await expectProviderButton(page, "Google", scheme);
			await expectProviderButton(page, "Microsoft", scheme);
			await expectNoProblems(page, "the sign-in page", [EMPTY_INPUT]);
		},
		{ "sign-in": null, "sign-in-logos": page.getByRole("main") },
	);
});

test("Settings › Sign-in: the policy, the advice to name a tenant, and a domain with its record", async ({
	page,
	baseURL,
}) => {
	const owner = newPerson();
	await signIn(page, owner.email);
	const { slug } = await createOrganisation(page);
	const settings = signInSettingsPath(slug);
	await openShell(page, settings);
	await expect(page.getByRole("heading", { level: 1, name: "Sign-in" })).toBeVisible();

	// Microsoft, at no tenant: the page says why to name one, and saved it all the same.
	await requireOnly(page, "Microsoft");
	await expect(page.getByText("Name your tenant ID: until you do,").first()).toBeVisible();

	// A domain of the company's own, not yet proved: its TXT record is shown to copy.
	const domain = `acme-${randomUUID().slice(0, 8)}.example`;
	await page.getByRole("button", { name: "Add a domain" }).click();
	const adding = page.getByRole("dialog", { name: "Add a domain" });
	await adding.getByLabel("Domain").fill(domain);
	await adding.getByRole("button", { name: "Add domain" }).click();
	await expect(adding).toBeHidden();
	const domains = page.getByRole("region", { name: "Verified domains" });
	await expect(domains.getByText(domain, { exact: true })).toBeVisible();
	await expect(domains.getByText(`_timesifier.${domain}`)).toBeVisible();

	await inEveryLook(
		page,
		baseURL,
		() => openShell(page, settings),
		async () => {
			await expect(page.getByRole("heading", { level: 1, name: "Sign-in" })).toBeVisible();
			await expect(page.getByText("Microsoft only", { exact: true })).toBeVisible();
			await expectNoProblems(page, "Settings › Sign-in");
		},
		{
			"settings-sign-in": null,
			"settings-policy": page.getByRole("region", { name: "Company sign-in" }),
			"settings-domains": domains,
		},
	);
});

test("a member signed in by code is told their organisation asks for Microsoft, and given the one button", async ({
	page,
	baseURL,
	browser,
	refusals,
}) => {
	// The owner, in a browser of their own, makes Acme and invites the member.
	const owners = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(owners, baseURL);
	const ownerPage = await owners.newPage();
	await signIn(ownerPage, newPerson().email);
	const { name, slug } = await createOrganisation(ownerPage);
	const member = newPerson();
	await openShell(ownerPage, invitationsPath(slug));
	const link = await foundInMessageSentBy(
		() => invite(ownerPage, member.email),
		INVITATION_LINK,
		"the invitation's link",
	);

	// The member joins, signed in by an emailed code.
	await page.goto(link);
	await signIn(page, member.email, page.url());
	await page.getByRole("button", { name: "Join" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Timesheet" })).toBeVisible();

	// The owner, exempt, requires Microsoft.
	await openShell(ownerPage, signInSettingsPath(slug));
	await requireOnly(ownerPage, "Microsoft");
	await owners.close();

	const timesheet = destinationPath(slug, "timesheet");
	expectRefusal(refusals, timesheet, 403);
	await inEveryLook(
		page,
		baseURL,
		async () => {
			const response = await page.goto(timesheet);
			expect(response?.status()).toBe(403);
		},
		async (scheme) => {
			await expect(
				page.getByRole("heading", { level: 1, name: `${name} asks you to sign in with Microsoft` }),
			).toBeVisible();
			await expect(page.getByRole("button", { name: /^Sign in with / })).toHaveText([
				"Sign in with Microsoft",
			]);
			await expectProviderButton(page, "Microsoft", scheme);
			await expect(page.getByRole("link", { name: "Go to your organisations" })).toBeVisible();
			await expectNoProblems(page, "the page that asks for Microsoft");
		},
		{ "asks-to-sign-in": null },
	);
});
