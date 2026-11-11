import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime against the bindings in wrangler.jsonc.
export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// The committed SQL migrations, read here in Node and handed to the
				// runtime as a test-only binding; test/db/database.ts applies them
				// to the local D1 before each test.
				bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") },
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
	},
});
