import { defineConfig } from "vitest/config";

// `pnpm test` runs both projects. Each has its own file because the React Router
// plugin used by the Workers project needs a config file of its own to read.
export default defineConfig({
	test: {
		projects: ["./vitest.workers.config.ts", "./vitest.node.config.ts"],
	},
});
