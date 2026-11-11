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

// React Aria locks page scrolling differently on iOS; these tests run in WebKit only.
const IOS_ONLY = /overlays-ios\.spec\.ts/;
// Signs one person up and saves their session; every Chromium test starts with it.
const SETUP = /auth\.setup\.ts/;

// What the server under test is given. None of it is a secret: the first signs
// cookies for this run only, and the Turnstile pair is Cloudflare's published
// test keys, which pass every check.
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
// Where the checkout has a `.dev.vars`, Wrangler reads the two secrets from it
// instead; it must hold the same Turnstile secret, as `.dev.vars.example` says.
const TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
const SERVER_ENV = {
	DESIGN_ROUTE: "1",
	BETTER_AUTH_SECRET: "browser-tests-only-m4Qx8Zr2Lk7Vt1Nc5Hd9Wb3Yp6Sg0Jf",
	TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
};

// The steps that bring the server up, in order:
// 1. build, which copies the secrets above into build/server/.dev.vars;
// 2. give the build the two `vars` a test server needs. They are not secrets, so
//    the build does not copy them, and `vite preview` reads no other file: the
//    test site key, and an ENVIRONMENT that is not production's, so that
//    authentication trusts localhost and not timesifier.com;
// 3. create the local D1 database from the migrations, where it does not exist;
// 4. serve. Wrangler's local EMAIL binding sends nothing: it writes each message
//    under .wrangler/tmp/email/, where e2e/auth.ts reads the sign-in codes.
const START_SERVER = [
	"pnpm exec react-router build",
	`echo TURNSTILE_SITE_KEY=${TURNSTILE_SITE_KEY} >> build/server/.dev.vars`,
	"echo ENVIRONMENT=development >> build/server/.dev.vars",
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
			testIgnore: IOS_ONLY,
			dependencies: ["setup"],
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
	],
	webServer: {
		command: START_SERVER,
		url: ORIGIN,
		env: SERVER_ENV,
		reuseExistingServer: false,
		timeout: 180_000,
		stdout: "ignore",
		stderr: "pipe",
	},
});
