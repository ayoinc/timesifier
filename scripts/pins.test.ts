import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// What the pipeline runs is the same from one run to the next: each tool's
// version is written once, in full (docs/security.md, "Supply chain").

const repository = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(repository, path), "utf8");

const EXACT = /^\d+\.\d+\.\d+$/;
const manifest = JSON.parse(read("package.json"));

describe("pinned versions", () => {
	it("Node: an exact version in .node-version, which the pipeline reads", () => {
		expect(read(".node-version").trim()).toMatch(EXACT);
	});

	it("pnpm: an exact version in package.json's packageManager", () => {
		expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+(\+sha512\.[0-9a-f]+)?$/);
	});

	it.each([
		["wrangler", "devDependencies"],
		["better-auth", "dependencies"],
	])("%s: an exact version in package.json", (name, section) => {
		expect(manifest[section][name]).toMatch(EXACT);
	});
});

describe("the workflows", () => {
	const workflows = readdirSync(join(repository, ".github/workflows")).map((file) => ({
		file,
		text: read(join(".github/workflows", file)),
	}));

	it("use every action at a full commit id, with its version beside it", () => {
		const uses = workflows.flatMap(({ file, text }) =>
			text
				.split("\n")
				.filter((line) => /^\s*-?\s*uses:/.test(line))
				.map((line) => `${file}: ${line.trim()}`),
		);

		expect(uses.length).toBeGreaterThan(0);
		for (const line of uses) {
			expect(line).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
		}
	});

	it("run every job on one named image version, never on a label that moves", () => {
		const images = workflows.flatMap(({ text }) =>
			[...text.matchAll(/^\s*runs-on: (.+)$/gm)].map(([, image]) => image),
		);

		expect(images.length).toBeGreaterThan(0);
		expect(new Set(images).size).toBe(1);
		expect(images[0]).toMatch(/^ubuntu-\d+\.\d+$/);
	});

	it("run a job in a container only from an image pinned by digest, and Playwright's at the version in package.json", () => {
		const images = workflows.flatMap(({ text }) =>
			[...text.matchAll(/^\s*image: (.+)$/gm)].map(([, image]) => image),
		);

		for (const image of images)
			expect(image).toMatch(/:v?\d+\.\d+\.\d+[\w-]*@sha256:[0-9a-f]{64}$/);
		const playwright = images.find((image) => image.startsWith("mcr.microsoft.com/playwright:"));
		expect(playwright).toContain(`:v${manifest.devDependencies["@playwright/test"]}-`);
	});

	it("take Node's version from .node-version and name none themselves", () => {
		for (const { file, text } of workflows) {
			expect(text, file).not.toMatch(/node-version:/);
			expect(text, file).not.toMatch(/\bversion: \d/);
		}
	});

	it("install with the lockfile as it is, and run Wrangler from it", () => {
		for (const { file, text } of workflows) {
			const installs = text.split("\n").filter((line) => /pnpm install/.test(line));
			for (const line of installs) expect(line, file).toContain("--frozen-lockfile");
			expect(text, file).not.toMatch(/\bnpx\b|\bpnpm dlx\b|(?<![a-z])npm (install|i)\b/);
		}
	});
});
