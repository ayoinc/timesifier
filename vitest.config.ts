import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime against the bindings in wrangler.jsonc.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
	resolve: { tsconfigPaths: true },
	test: {
		include: ["test/**/*.test.ts", "app/**/*.test.ts"],
	},
});
