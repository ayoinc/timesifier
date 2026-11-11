import { defineConfig, devices } from "@playwright/test";

// Browser tests run against a production build served by `vite preview`, so they
// see real server rendering, hydration and the Content Security Policy that ships.
// The build is made with DESIGN_ROUTE=1: it is the only build that has /design.
// It is written to build/ like any other, so e2e/remove-build.ts deletes it when
// the tests end: a build with the gallery in it must never be the one deployed.
const PORT = 5385;
const ORIGIN = `http://localhost:${PORT}`;

// React Aria locks page scrolling differently on iOS; these tests run in WebKit only.
const IOS_ONLY = /overlays-ios\.spec\.ts/;

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
			name: "chromium",
			testIgnore: IOS_ONLY,
			use: { ...devices["Desktop Chrome"] },
		},
		{
			// React Aria locks page scrolling differently on iOS. Only the tests that
			// open an overlay run here, in WebKit with an iPhone's screen and user agent.
			name: "ios-webkit",
			testMatch: IOS_ONLY,
			use: { ...devices["iPhone 15"] },
		},
	],
	webServer: {
		command: `pnpm exec react-router build && pnpm exec vite preview --port ${PORT} --strictPort`,
		url: ORIGIN,
		env: { DESIGN_ROUTE: "1" },
		reuseExistingServer: false,
		timeout: 180_000,
		stdout: "ignore",
		stderr: "pipe",
	},
});
