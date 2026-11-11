import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime against the bindings in wrangler.jsonc.
// That file is a developer's machine's; the tests check what ships, so they are
// given the settings of a deployment of their own. None reaches anything: the
// hosts are only ever the address of a `Request` handed to the Worker.
export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					// The committed SQL migrations, read here in Node and handed to the
					// runtime as a test-only binding; test/db/database.ts applies them
					// to the local D1 before each test.
					TEST_MIGRATIONS: await readD1Migrations("./migrations"),
					// Not a secret: a throwaway value that signs cookies in tests only.
					BETTER_AUTH_SECRET: "tests-only-Zk3vQ8mT1xW6bN4rY9cH2jL7pD5sF0gA",
					// Not secrets: Turnstile's published test keys, which pass every check.
					// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
					TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
					TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
					// The deployment under test: production, on the first host. Tests that
					// set ENVIRONMENT to `preview` use the suffix. app/auth/hosts.ts.
					ENVIRONMENT: "production",
					APP_HOST: "timesifier.example",
					PREVIEW_HOST_SUFFIX: "-timesifier.acme.workers.dev",
					EMAIL_FROM: "no-reply@mail.timesifier.example",
				},
			},
		})),
		// Supplies the server build, so tests can drive the Worker's real fetch handler.
		reactRouter(),
	],
	resolve: { tsconfigPaths: true },
	test: {
		name: "workers",
		// Vitest reports development mode by default. Tests check the browser policy
		// that ships, so they run with the production values of these two flags.
		env: { DEV: "", PROD: "1" },
		include: ["test/**/*.test.ts", "app/**/*.test.ts"],
		exclude: ["test/node/**"],
		// The first request in a test file loads the whole application, Better Auth
		// included, one module at a time. With every file loading at once that can
		// take several seconds, so the default of five is too close.
		testTimeout: 20_000,
	},
});
