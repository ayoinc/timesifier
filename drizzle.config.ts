import { defineConfig } from "drizzle-kit";

// Used only to generate SQL migrations from the schema (`pnpm db:generate`).
// Wrangler applies them; drizzle-kit never connects to a database.
export default defineConfig({
	dialect: "sqlite",
	schema: "./app/db/schema.ts",
	out: "./migrations",
});
