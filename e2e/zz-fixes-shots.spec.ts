import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, devices, expect, type Page, test, webkit } from "@playwright/test";

import { COLOR_SCHEME_COOKIE } from "../app/shell/color-scheme.server";
import { accountPath, destinationPath, invitationsPath } from "../app/shell/destinations";
import { newPerson, ownAddress, setName, signIn } from "./auth";
import { SIGNED_OUT } from "./auth-state";
import { createOrganisation } from "./organisation";

// The day an entry is stored with: the one it starts on in the browser's zone,
// which the person's becomes (TS-111).
const dayIn = (instant: number) => new Date(instant).toLocaleDateString("en-CA");

// The before and after screenshots of TS-091, the wonky audit's fixes
// (research/wonky-audit.md). Not a test of the product: it photographs the
// defects the audit lists, so the same steps run once on `main` (before) and
// once on the fixes (after). It runs only when asked:
//
//   SHOT_PHASE=before|after CI=1 E2E_PORT=5414 pnpm exec playwright test \
//     --project=setup --project=chromium --project=chromium-seeded e2e/zz-fixes-shots.spec.ts
//
// It writes to the local D1 with `wrangler d1 execute`, as reports.spec.ts
// does, so it is in the seeded project, which runs after the others, one test
// at a time. The WebKit part (W19, console only) launches WebKit itself: the
// WebKit project runs only the files its pattern names.
//
// It imports `test` from Playwright, not ./fixtures: the pages it photographs
// are broken on purpose, and their console errors are evidence, not failures.
// Every step is guarded, so a step the fixes removed or renamed costs only its
// own picture (a soft failure names it).

const PHASE = process.env.SHOT_PHASE;
const OUT =
	process.env.SHOT_DIR ??
	"/Users/ayodele.ajayi/Workspace/Personal/cmux-assets/browser/timesifier/fixes";

test.skip(
	PHASE !== "before" && PHASE !== "after",
	"Set SHOT_PHASE=before|after to take the TS-091 shots.",
);
test.describe.configure({ mode: "default" });

type Size = "d" | "m";
type Scheme = "light" | "dark";
const VIEWPORTS: Record<Size, { width: number; height: number }> = {
	d: { width: 1280, height: 800 },
	m: { width: 390, height: 844 },
};

/** The week of the entry across midnight: Monday 2 to Sunday 8 November 2026. */
const WEEK = "2026-11-02";
const WEEK_END = "2026-11-08";
/** The week whose Tuesday evening entry gets 5 hours typed into its cell (W08). */
const GRID_WEEK = "2026-10-26";

const SESSION = join(tmpdir(), `timesifier-fixes-shots-${randomUUID()}.json`);
let slug = "";
let userId = "";

/** Runs SQL against the local D1 of the server under test and returns its rows. */
function execute(sql: string): Record<string, unknown>[] {
	const out = execFileSync(
		"pnpm",
		["exec", "wrangler", "d1", "execute", "DB", "--local", "--json", "--command", sql],
		{ stdio: "pipe", encoding: "utf8" },
	);
	const parsed = JSON.parse(out.slice(out.indexOf("["))) as {
		results?: Record<string, unknown>[];
	}[];
	return parsed.flatMap((each) => each.results ?? []);
}

test.beforeAll(async ({ browser, baseURL }) => {
	if (PHASE !== "before" && PHASE !== "after") return;
	test.setTimeout(180_000);
	mkdirSync(OUT, { recursive: true });

	const context = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
	await ownAddress(context, baseURL);
	const page = await context.newPage();
	const { email } = newPerson();
	await signIn(page, email);
	({ slug } = await createOrganisation(page, `ContainerCode ${randomUUID().slice(0, 4)}`));
	await setName(page, "Ada Lovelace").catch(() => undefined);
	await context.storageState({ path: SESSION });
	await context.close();

	const [client, upwork, internal] = [randomUUID(), randomUUID(), randomUUID()];
	const org = `(select id from organisations where slug = '${slug}')`;
	const user = `(select id from users where email = '${email}')`;
	const entry = (project: string, description: string, from: string, to: string) =>
		`insert into time_entries (id, organisation_id, user_id, project_id, description, started_at, spent_on, ended_at, created_at, updated_at) values ('${randomUUID()}', ${org}, ${user}, '${project}', '${description}', ${Date.parse(from)}, '${dayIn(Date.parse(from))}', ${Date.parse(to)}, 0, 0);`;
	execute(
		[
			`insert into clients (id, organisation_id, name, name_key, created_at, updated_at) values ('${client}', ${org}, 'AI Coding', 'ai coding', 0, 0);`,
			`insert into projects (id, organisation_id, name, name_key, client_id, created_at, updated_at) values ('${upwork}', ${org}, 'UpWork', 'upwork', '${client}', 0, 0), ('${internal}', ${org}, 'Internal', 'internal', null, 0, 0);`,
			entry(upwork, "Design review", "2026-11-02T09:00:00Z", "2026-11-02T11:30:00Z"),
			// The audit's entry: Wednesday 21:33 to Thursday 02:33, started on an odd second,
			// so the two halves are not whole minutes (W04, W07).
			entry(upwork, "Platform Built with AI", "2026-11-04T21:33:26Z", "2026-11-05T02:33:26Z"),
			// An evening entry of one hour, given 5 in the Week grid by W08.
			entry(internal, "Evening fix", "2026-10-27T21:33:00Z", "2026-10-27T22:33:00Z"),
		].join(" "),
	);
	userId = String(execute(`select id from users where email = '${email}';`)[0]?.id ?? "");
});

const path = {
	day: (day: string) => `/app/${slug}?day=${day}`,
	week: (start: string) => `/app/${slug}?view=week&start=${start}`,
	reports: (group = "project") =>
		`${destinationPath(slug, "reports")}?range=custom&group=${group}&from=${WEEK}&to=${WEEK_END}`,
	team: () => `${destinationPath(slug, "team")}?week=${WEEK}`,
	person: () => `${destinationPath(slug, "team")}?week=${WEEK}&person=${userId}`,
	approvals: () => `${destinationPath(slug, "approvals")}?week=${WEEK}`,
	projects: () => destinationPath(slug, "projects"),
	clients: () => destinationPath(slug, "clients"),
	settings: () => destinationPath(slug, "settings"),
	account: () => accountPath(slug),
	invitations: () => invitationsPath(slug),
};

/** Opens a browser of the given size and scheme, signed in as the owner, and hands its page over. */
async function withPage(
	browser: Browser,
	baseURL: string | undefined,
	size: Size,
	scheme: Scheme,
	use: (page: Page) => Promise<void>,
) {
	const context = await browser.newContext({
		baseURL,
		storageState: SESSION,
		viewport: VIEWPORTS[size],
		deviceScaleFactor: size === "m" ? 2 : 1,
		isMobile: size === "m",
		hasTouch: size === "m",
		locale: "en-US",
		timezoneId: "Europe/London",
		colorScheme: scheme,
	});
	await ownAddress(context, baseURL);
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
	try {
		await use(await context.newPage());
	} finally {
		await context.close();
	}
}

/** Waits until the page is loaded, hydrated, set in its fonts and done moving. */
async function settle(page: Page) {
	await page.waitForLoadState("networkidle").catch(() => undefined);
	await page
		.waitForFunction(
			() => {
				const link = document.querySelector("body a");
				return link !== null && Object.keys(link).some((key) => key.startsWith("__reactFiber"));
			},
			undefined,
			{ timeout: 10_000 },
		)
		.catch(() => undefined);
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
	await page.waitForTimeout(500);
}

async function visit(page: Page, to: string) {
	await page.goto(to);
	await settle(page);
}

/** `<W>-<phase>-<d|m>-<scheme>[-<what>].png` in the output folder. */
function fileName(w: string, size: Size, scheme: Scheme, what?: string, extension = "png") {
	return join(OUT, `${w}-${PHASE}-${size}-${scheme}${what ? `-${what}` : ""}.${extension}`);
}

async function shoot(
	page: Page,
	w: string,
	size: Size,
	scheme: Scheme,
	what?: string,
	fullPage = true,
) {
	await page.screenshot({ path: fileName(w, size, scheme, what), fullPage });
}

/** Runs one capture; a failure is reported softly and the rest go on. */
async function attempt(what: string, run: () => Promise<void>) {
	try {
		await run();
	} catch (error) {
		expect.soft(String(error).split("\n")[0], `${what} could not be captured`).toBe("");
	}
}

/**
 * Outlines every visible control smaller than 44px in either direction (W10)
 * and returns them, one line each.
 */
async function markSmallControls(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const small: string[] = [];
		const controls = document.querySelectorAll<HTMLElement>(
			"a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=link], [role=radio]",
		);
		for (const control of controls) {
			const box = control.getBoundingClientRect();
			const style = getComputedStyle(control);
			if (box.width === 0 || box.height === 0 || style.visibility === "hidden") continue;
			if (Math.min(box.width, box.height) >= 44) continue;
			control.style.outline = "2px solid #e00";
			control.style.outlineOffset = "0";
			const name = (control.getAttribute("aria-label") ?? control.textContent ?? "")
				.trim()
				.slice(0, 40);
			small.push(
				`${Math.round(box.width)}x${Math.round(box.height)} ${control.tagName.toLowerCase()} "${name}"`,
			);
		}
		return small;
	});
}

test("W04 W06 W07 W12: an entry across midnight, and how dates are written", async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(240_000);
	for (const scheme of ["light", "dark"] as const) {
		await withPage(browser, baseURL, "d", scheme, async (page) => {
			await attempt(`W07 ${scheme}`, async () => {
				await visit(page, path.reports("day"));
				await shoot(page, "W07", "d", scheme);
			});
		});
	}
	await withPage(browser, baseURL, "d", "light", async (page) => {
		await attempt("W04 timesheet Wednesday", async () => {
			await visit(page, path.day("2026-11-04"));
			await shoot(page, "W04", "d", "light", "timesheet-wed");
			await shoot(page, "W06", "d", "light", "timesheet-day");
		});
		await attempt("W04 timesheet Thursday", async () => {
			await visit(page, path.day("2026-11-05"));
			await shoot(page, "W04", "d", "light", "timesheet-thu");
		});
		await attempt("W04 reports by day", async () => {
			await visit(page, path.reports("day"));
			await shoot(page, "W04", "d", "light", "reports-day");
		});
		await attempt("W04 team person", async () => {
			await visit(page, path.person());
			await shoot(page, "W04", "d", "light", "team-person");
			await shoot(page, "W12", "d", "light", "team-person");
		});
		await attempt("W06 timesheet week", async () => {
			await visit(page, path.week(WEEK));
			await shoot(page, "W06", "d", "light", "timesheet-week");
		});
		await attempt("W12 reports", async () => {
			await visit(page, path.reports("project"));
			await shoot(page, "W12", "d", "light", "reports");
		});
		await attempt("W12 team", async () => {
			await visit(page, path.team());
			await shoot(page, "W12", "d", "light", "team");
		});
	});
	await withPage(browser, baseURL, "m", "light", async (page) => {
		await attempt("W06 mobile day chips", async () => {
			await visit(page, path.day("2026-11-04"));
			await shoot(page, "W06", "m", "light", "timesheet-day", false);
		});
		await attempt("W06 mobile week", async () => {
			await visit(page, path.week(WEEK));
			await shoot(page, "W06", "m", "light", "timesheet-week", false);
		});
	});
});

test("W05: a custom range given backwards", async ({ browser, baseURL }) => {
	for (const size of ["d", "m"] as const) {
		await withPage(browser, baseURL, size, "light", async (page) => {
			await attempt(`W05 ${size}`, async () => {
				await visit(
					page,
					`${destinationPath(slug, "reports")}?range=custom&group=project&from=2026-11-15&to=2026-11-09`,
				);
				await shoot(page, "W05", size, "light");
			});
		});
	}
});

test("W08: 5 hours typed into the cell of an evening entry", async ({ browser, baseURL }) => {
	await withPage(browser, baseURL, "d", "light", async (page) => {
		await attempt("W08 week grid", async () => {
			await visit(page, path.week(GRID_WEEK));
			// Tuesday's cell of the Internal row: the second of its seven.
			const cell = page.getByRole("textbox", { name: /^Internal, / }).nth(1);
			await cell.fill("5");
			const saved = page.waitForResponse((response) => response.request().method() === "POST");
			await cell.press("Tab");
			await saved;
			await settle(page);
			await shoot(page, "W08", "d", "light", "week");
		});
		await attempt("W08 day", async () => {
			await visit(page, path.day("2026-10-27"));
			await shoot(page, "W08", "d", "light", "day");
		});
	});
});

test("W09: half a second into a slow move between pages", async ({ browser, baseURL }) => {
	await withPage(browser, baseURL, "d", "light", async (page) => {
		await attempt("W09", async () => {
			await visit(page, path.day("2026-11-04"));
			await page.route(
				(url) => url.pathname.endsWith(".data"),
				async (route) => {
					await sleep(4_000);
					await route.fallback().catch(() => undefined);
				},
			);
			await page
				.getByRole("navigation", { name: "Main" })
				.getByRole("link", { name: "Reports", exact: true })
				.first()
				.click();
			await page.waitForTimeout(500);
			await shoot(page, "W09", "d", "light", undefined, false);
			await page.unrouteAll({ behavior: "ignoreErrors" });
		});
	});
});

test("W10: touch targets at 390", async ({ browser, baseURL }) => {
	await withPage(browser, baseURL, "m", "light", async (page) => {
		for (const [what, to] of [
			["reports", path.reports("project")],
			["approvals", path.approvals()],
		] as const) {
			await attempt(`W10 ${what}`, async () => {
				await visit(page, to);
				await shoot(page, "W10", "m", "light", what);
				const small = await markSmallControls(page);
				await shoot(page, "W10", "m", "light", `${what}-marked`);
				writeFileSync(
					fileName("W10", "m", "light", `${what}-small`, "txt"),
					`Controls under 44px on ${what} at 390x844 (${PHASE}): ${small.length}\n${small.join("\n")}\n`,
				);
			});
		}
	});
});

test("W14: a 404 inside the organisation, dark", async ({ browser, baseURL }) => {
	for (const size of ["d", "m"] as const) {
		await withPage(browser, baseURL, size, "dark", async (page) => {
			await attempt(`W14 ${size}`, async () => {
				await visit(page, `/app/${slug}/does-not-exist`);
				await shoot(page, "W14", size, "dark");
			});
		});
	}
});

test("W15 W18 W28: the filter rows of Projects, Clients and Team", async ({ browser, baseURL }) => {
	for (const size of ["d", "m"] as const) {
		await withPage(browser, baseURL, size, "light", async (page) => {
			for (const [what, to] of [
				["projects", path.projects()],
				["clients", path.clients()],
				["team", path.team()],
			] as const) {
				await attempt(`W15 ${what} ${size}`, async () => {
					await visit(page, to);
					await shoot(page, "W15", size, "light", what, size === "d");
					if (size === "m" && what === "projects")
						await shoot(page, "W18", "m", "light", undefined, false);
				});
			}
		});
	}
	await withPage(browser, baseURL, "d", "light", async (page) => {
		await attempt("W28 projects typed", async () => {
			await visit(page, path.projects());
			await page.locator('main input[name="q"]').first().pressSequentially("Inter", { delay: 60 });
			// Longer than any wait to apply a filter after typing stops.
			await page.waitForTimeout(1_500);
			await settle(page);
			await shoot(page, "W28", "d", "light", "projects-typed");
		});
	});
});

test("W20 W21 W22 W23 W24 W30 W32: tabs, the column, steppers, row actions, copy and sheets", async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(240_000);
	await withPage(browser, baseURL, "d", "light", async (page) => {
		await attempt("W20 W21 projects", async () => {
			await visit(page, path.projects());
			await shoot(page, "W20", "d", "light", "projects");
			await shoot(page, "W21", "d", "light", "projects");
		});
		await attempt("W21 W30 clients", async () => {
			await visit(page, path.clients());
			await shoot(page, "W21", "d", "light", "clients");
			await shoot(page, "W30", "d", "light", "clients");
		});
		await attempt("W20 team", async () => {
			await visit(page, path.team());
			await shoot(page, "W20", "d", "light", "team");
		});
		await attempt("W22 reports light", async () => {
			await visit(page, path.reports("project"));
			await shoot(page, "W22", "d", "light");
		});
		await attempt("W24 projects row actions", async () => {
			await visit(page, path.projects());
			const actions = page.getByRole("button", { name: /^Actions for UpWork$/ });
			if ((await actions.count()) > 0) {
				await actions.first().click();
				await expect(page.getByRole("menu")).toBeVisible();
			} else {
				// After TS-091 the name opens the edit sheet, which holds Archive.
				await page
					.getByRole("main")
					.getByRole("button", { name: "UpWork", exact: true })
					.first()
					.click();
				await expect(page.getByRole("dialog")).toBeVisible();
			}
			await page.waitForTimeout(400);
			await shoot(page, "W24", "d", "light", undefined, false);
		});
		await attempt("W30 invite sheet", async () => {
			await visit(page, path.invitations());
			await page.getByRole("button", { name: "Invite a person" }).first().click();
			await expect(page.getByRole("dialog")).toBeVisible();
			await page.waitForTimeout(800);
			await shoot(page, "W30", "d", "light", "invite-sheet", false);
		});
		await attempt("W32 track time sheet", async () => {
			await visit(page, path.day("2026-11-04"));
			await page
				.getByRole("main")
				.getByRole("button", { name: /Track time/ })
				.first()
				.click();
			await expect(page.getByRole("dialog")).toBeVisible();
			await page.waitForTimeout(800);
			await shoot(page, "W32", "d", "light", "track-time", false);
		});
		await attempt("W32 create project sheet", async () => {
			await visit(page, path.projects());
			await page
				.getByRole("button", { name: /Create (a )?project/ })
				.first()
				.click();
			await expect(page.getByRole("dialog")).toBeVisible();
			await page.waitForTimeout(800);
			await shoot(page, "W32", "d", "light", "create-project", false);
		});
	});
	await withPage(browser, baseURL, "d", "dark", async (page) => {
		await attempt("W22 W23 reports dark", async () => {
			await visit(page, path.reports("project"));
			await shoot(page, "W22", "d", "dark");
			await shoot(page, "W23", "d", "dark", "reports", false);
		});
		await attempt("W23 W30 team dark", async () => {
			await visit(page, path.team());
			await shoot(page, "W23", "d", "dark", "team", false);
			await shoot(page, "W30", "d", "dark", "team");
		});
	});
	await withPage(browser, baseURL, "m", "light", async (page) => {
		await attempt("W24 mobile", async () => {
			await visit(page, path.projects());
			await shoot(page, "W24", "m", "light", undefined, false);
		});
	});
});

test("W26 W27: My account as the only owner, and deleting the organisation", async ({
	browser,
	baseURL,
}) => {
	for (const scheme of ["light", "dark"] as const) {
		for (const size of ["d", "m"] as const) {
			await withPage(browser, baseURL, size, scheme, async (page) => {
				if (scheme === "light") {
					await attempt(`W26 ${size}`, async () => {
						await visit(page, path.account());
						await shoot(page, "W26", size, "light");
					});
				}
				await attempt(`W27 ${size} ${scheme}`, async () => {
					await visit(page, path.settings());
					await shoot(page, "W27", size, scheme, "settings");
					await page.getByRole("button", { name: "Delete organisation" }).first().click();
					const dialog = page.getByRole("dialog");
					await expect(dialog).toBeVisible();
					// The name typed, as a person about to confirm would have it; never sent.
					const name = await page.evaluate(
						() => document.querySelector("dialog strong, [role=dialog] strong")?.textContent ?? "",
					);
					if (name) await dialog.getByRole("textbox").first().fill(name);
					await page.waitForTimeout(800);
					await shoot(page, "W27", size, scheme, "dialog", false);
				});
			});
		}
	}
});

test("W19: WebKit's console on public pages with React Aria buttons", async ({ baseURL }) => {
	const browser = await webkit.launch();
	try {
		const context = await browser.newContext({
			...devices["iPhone 15"],
			baseURL,
			locale: "en-US",
			timezoneId: "Europe/London",
		});
		const page = await context.newPage();
		const lines: string[] = [];
		page.on("console", (message) => lines.push(`[${message.type()}] ${message.text()}`));
		page.on("pageerror", (error) => lines.push(`[pageerror] ${error.message}`));
		await page.addInitScript(() => {
			document.addEventListener("securitypolicyviolation", (event) => {
				console.log(
					`securitypolicyviolation ${event.effectiveDirective} ${event.blockedURI} ${event.sample}`,
				);
			});
			// Which <style> each refusal belongs to: the app's (React Aria's) or the tool's.
			new MutationObserver((records) => {
				for (const node of records.flatMap((record) => [...record.addedNodes])) {
					if (node instanceof HTMLStyleElement) {
						const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
						console.log(`<style${node.id ? ` id="${node.id}"` : ""}> inserted: ${text}`);
					}
				}
			}).observe(document, { childList: true, subtree: true });
		});
		const report: string[] = [`WebKit ${browser.version()}, iPhone 15 (390x844), ${PHASE}`, ""];
		for (const to of ["/sign-in", "/design"]) {
			lines.length = 0;
			await page.goto(to);
			await page
				.locator("#react-aria-pressable-style")
				.waitFor({ state: "attached", timeout: 10_000 })
				.catch(() => undefined);
			await page.waitForTimeout(1_000);
			// Whether React Aria's rule took effect: a refused sheet is in the document but applies nothing.
			const pressable = await page.evaluate(() => ({
				present: document.getElementById("react-aria-pressable-style") !== null,
				applied: [...document.styleSheets].some(
					(sheet) => (sheet.ownerNode as Element | null)?.id === "react-aria-pressable-style",
				),
			}));
			report.push(
				`== ${to}: react-aria-pressable-style present ${pressable.present}, applied ${pressable.applied}`,
				`-- while loading: ${lines.length} message(s)`,
				...lines,
			);
			// The audit photographed every page, and Playwright's screenshot hides the
			// caret by inserting a <style> of its own, which this policy refuses. So a
			// screenshot that leaves the caret alone comes first, then one that hides it;
			// what each is followed by is kept apart.
			lines.length = 0;
			await page.screenshot({
				path: join(OUT, `W19-${PHASE}-m-light-${to.slice(1)}.png`),
				caret: "initial",
			});
			await page.waitForTimeout(500);
			report.push(
				`-- after a screenshot with caret: "initial": ${lines.length} message(s)`,
				...lines,
			);
			lines.length = 0;
			await page.screenshot({ caret: "hide" });
			await page.waitForTimeout(500);
			report.push(
				`-- after a screenshot with caret: "hide" (Playwright's default): ${lines.length} message(s)`,
				...lines,
				"",
			);
		}
		writeFileSync(join(OUT, `W19-${PHASE}-webkit-console.txt`), report.join("\n"));
		await context.close();
	} finally {
		await browser.close();
	}
});
