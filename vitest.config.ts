import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime against the bindings in wrangler.jsonc.
// The React Router plugin supplies the server build, so tests can drive the
// Worker's real fetch handler.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
		reactRouter(),
	],
	resolve: { tsconfigPaths: true },
	test: {
		// Vitest reports development mode by default. Tests check the browser policy
		// that ships, so they run with the production values of these two flags.
		env: { DEV: "", PROD: "1" },
		include: ["test/**/*.test.ts", "app/**/*.test.ts"],
	},
});
