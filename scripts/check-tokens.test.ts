import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("..", import.meta.url));

function checkTokens(directory?: string) {
	const args = ["scripts/check-tokens.ts", ...(directory ? [directory] : [])];
	const result = spawnSync(process.execPath, args, { cwd: repository, encoding: "utf8" });
	return { status: result.status, lines: result.stdout.trim().split("\n") };
}

describe("pnpm check:tokens", () => {
	it("fails on the dirty fixture and lists every finding with its file, line and match", () => {
		const { status, lines } = checkTokens("scripts/fixtures/check-tokens/dirty");
		const card = "scripts/fixtures/check-tokens/dirty/card.tsx";

		expect(status).toBe(1);
		expect(lines).toEqual([
			`${card}:4:29  hex colour  #1a2b3c`,
			`${card}:5:18  arbitrary value  w-[13px]`,
			`${card}:6:18  arbitrary value  bg-[#fff]`,
			`${card}:6:22  hex colour  #fff`,
			`${card}:7:18  arbitrary value  hover:text-[color:red]`,
			`${card}:8:18  arbitrary property  [mask-type:luminance]`,
			`${card}:9:18  arbitrary value  bg-primary/[0.5]`,
			`${card}:10:18  arbitrary value  min-[320px]:`,
			`${card}:11:18  sibling attribute state  peer-data-focused:`,
			`${card}:12:41  sibling attribute state  peer-not-aria-invalid/field:`,
			"scripts/fixtures/check-tokens/dirty/styles/tokens.css:3:11  hex colour  #4f5bd5",
		]);
	});

	it("passes array indexing, index signatures, attribute selectors, URL fragments and state that is not a sibling's attribute", () => {
		const { status, lines } = checkTokens("scripts/fixtures/check-tokens/clean");

		expect(lines).toEqual([
			"No raw colours or arbitrary values under scripts/fixtures/check-tokens/clean.",
		]);
		expect(status).toBe(0);
	});

	it("passes the application, whose only raw colours are in the generated token file", () => {
		expect(checkTokens().status).toBe(0);
	});
});
