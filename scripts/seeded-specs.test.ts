import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A browser spec that writes to the local database with `wrangler d1 execute`
// can hold its lock while the server writes for another test, which then gets
// a 500. playwright.config.ts runs those specs after the others, one at a
// time, by name. This keeps the list complete.

const repository = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(repository, path), "utf8");

describe("browser specs that write to the database themselves", () => {
	it("all run in the seeded project", () => {
		const match = read("playwright.config.ts").match(/const SEEDS_THE_DATABASE =\s*(\/.+\/);/);
		expect(match, "SEEDS_THE_DATABASE in playwright.config.ts").not.toBeNull();
		const source = (match?.[1] ?? "").slice(1, -1);
		const seeded = new RegExp(source);

		const writers = readdirSync(join(repository, "e2e"))
			.filter((file) => file.endsWith(".spec.ts"))
			.filter((file) => /"d1",\s*"execute"/.test(read(join("e2e", file))));

		expect(writers.length).toBeGreaterThan(0);
		for (const file of writers) expect(`/${file}`, file).toMatch(seeded);
	});
});
