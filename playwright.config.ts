import { defineConfig, devices } from "@playwright/test";

import { SIGNED_IN } from "./e2e/auth-state";

// Browser tests run against a production build served by `vite preview`, so they
// see real server rendering, hydration and the Content Security Policy that ships.
// The build is made with DESIGN_ROUTE=1: it is the only build that has /design.
// It is written to build/ like any other, so e2e/remove-build.ts deletes it when
// the tests end: a build with the gallery in it must never be the one deployed.
// The port is this one place. Two checkouts running the tests at once need two
// ports: `E2E_PORT=5386 pnpm test:e2e`.
const PORT = Number(process.env.E2E_PORT) || 5385;
const ORIGIN = `http://localhost:${PORT}`;

// React Aria locks page scrolling differently on iOS; these tests run in WebKit
// only. So does the test that WebKit applies React Aria's own <style> (W19).
const IOS_ONLY = /(?:overlays-ios|react-aria-style)\.spec\.ts/;
// The component tests run in Chromium and again in WebKit: the two have styled
// the same page differently (docs/design-system.md, "State from another
// element"). So do the tests of the public pages, which are plain HTML and CSS
// that anybody may arrive on, in any browser. These are the tests that need no
// session; see the project below.
const IN_WEBKIT_TOO =
	/[\\/](?:accessibility|components|design|field-label|reduced-motion|landing|documents|public-links|identity|react-aria-style)\.spec\.ts$/;
// Signs one person up and saves their session; every Chromium test starts with it.
const SETUP = /auth\.setup\.ts/;
// These write to the local database with `wrangler d1 execute` while the server
// runs. A write from outside can hold the database's lock while the server
// writes for another test, which then fails with a 500. They run after every
// other Chromium test, one at a time.
const SEEDS_THE_DATABASE = /[\\/](?:people|projects-search|reports|zz-fixes-shots)\.spec\.ts$/;
// What the server under test is given. None of it is a secret: the first signs
// cookies for this run only, the second is Cloudflare's published Turnstile
// test secret, which passes every check, and the third makes one address of
// the tests the platform console's owner (TS-099, e2e/platform.spec.ts).
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
// Where the checkout has a `.dev.vars`, Wrangler reads the secrets from it
// instead; it must hold the same Turnstile secret, as `.dev.vars.example` says.
const SERVER_ENV = {
	DESIGN_ROUTE: "1",
	BETTER_AUTH_SECRET: "browser-tests-only-m4Qx8Zr2Lk7Vt1Nc5Hd9Wb3Yp6Sg0Jf",
	TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
	PLATFORM_OWNERS: "platform-owner@example.com",
};

// The steps that bring the server up, in order:
// 1. build, which copies the secrets above into build/server/.dev.vars and the
//    `vars` of wrangler.jsonc into the build's own configuration. Those are a
//    developer's machine's: an ENVIRONMENT of `development`, so authentication
//    trusts localhost and nothing else, and Turnstile's published test site key;
// 2. name the console's owner in that .dev.vars. The build copies only the
//    declared secrets there, and PLATFORM_OWNERS is a variable locally
//    (wrangler.jsonc), which a line of .dev.vars replaces;
// 3. create the local D1 database from the migrations, where it does not exist;
// 4. serve. Wrangler's local EMAIL binding sends nothing: it writes each message
//    under .wrangler/tmp/email/, where e2e/auth.ts reads the sign-in codes.
const START_SERVER = [
	"pnpm exec react-router build",
	`printf 'PLATFORM_OWNERS=%s\\n' "${SERVER_ENV.PLATFORM_OWNERS}" >> build/server/.dev.vars`,
	"pnpm db:migrate:local",
	`pnpm exec vite preview --port ${PORT} --strictPort`,
].join(" && ");

export default defineConfig({
	testDir: "./e2e",
	globalTeardown: "./e2e/remove-build.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: 0,
	reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: ORIGIN,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "setup",
			testMatch: SETUP,
			use: { ...devices["Desktop Chrome"] },
		},
		{
			// Everything under /app needs a session, so these tests start signed in.
			// A test of signing in starts without one: `SIGNED_OUT` in e2e/auth.ts.
			// The session cookie is `Secure`; Chromium keeps one on http://localhost.
			name: "chromium",
			testIgnore: [IOS_ONLY, SEEDS_THE_DATABASE],
			dependencies: ["setup"],
			use: { ...devices["Desktop Chrome"], storageState: SIGNED_IN },
		},
		{
			name: "chromium-seeded",
			testMatch: SEEDS_THE_DATABASE,
			dependencies: ["chromium"],
			workers: 1,
			use: { ...devices["Desktop Chrome"], storageState: SIGNED_IN },
		},
		{
			// React Aria locks page scrolling differently on iOS. Only the tests that
			// open an overlay run here, in WebKit with an iPhone's screen and user agent.
			// They open the component gallery, which needs no session: WebKit does not
			// keep a `Secure` cookie on http://localhost, so it cannot be signed in here.
			name: "ios-webkit",
			testMatch: IOS_ONLY,
			use: { ...devices["iPhone 15"] },
		},
		{
			// Safari's engine at a desktop's size, for the component tests: every
			// component by keyboard, the gallery, its accessibility scans, reduced
			// motion and the fields' labels. They need no session, which WebKit could
			// not keep here (see the project before this one).
			name: "webkit",
			testMatch: IN_WEBKIT_TOO,
			use: { ...devices["Desktop Safari"] },
		},
	],
	webServer: {
		command: START_SERVER,
		url: ORIGIN,
		env: SERVER_ENV,
		reuseExistingServer: false,
		timeout: 180_000,
		// In the pipeline the server's own lines go to the job's log, so a 500 seen
		// by a test can be read beside it; locally they would drown the results.
		stdout: process.env.CI ? "pipe" : "ignore",
		stderr: "pipe",
	},
});
