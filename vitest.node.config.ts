import { defineConfig } from "vitest/config";

// Checks that need Node itself, which the Workers runtime cannot give them:
// reading files, starting processes, drizzle-kit's schema comparison.
export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		name: "node",
		environment: "node",
		include: ["test/node/**/*.test.ts", "scripts/**/*.test.ts"],
	},
});
