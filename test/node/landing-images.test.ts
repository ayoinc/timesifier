import { expect, it } from "vitest";

import { PHOTOS, photoPath } from "~/landing/photos";

// The photographs the home page asks for are files we serve ourselves, and the
// source of each one is on record. e2e/landing.spec.ts checks, in a browser,
// that each has the shape its markup says.

const DIRECTORY = "../../public/images/";
// Only the names are read: nothing is loaded.
const files = Object.keys(import.meta.glob("../../public/images/*.{avif,webp}")).map((path) =>
	path.slice(DIRECTORY.length),
);
const everything = Object.keys(import.meta.glob("../../public/images/*"));
const credits = import.meta.glob<string>("../../public/images/CREDITS.md", {
	eager: true,
	query: "?raw",
	import: "default",
})[`${DIRECTORY}CREDITS.md`];

const shown = Object.values(PHOTOS).flatMap((photo) =>
	photo.widths.flatMap((width) =>
		(["avif", "webp"] as const).map((format) =>
			photoPath(photo, width, format).slice("/images/".length),
		),
	),
);

it("every file the page asks for exists, and no other image is served", () => {
	expect([...files].sort()).toEqual([...shown].sort());
	// The directory holds the images and their credits, nothing else.
	expect(everything).toHaveLength(files.length + 1);
});

it.each(Object.values(PHOTOS))("the widest file of $name is the size its markup gives", (photo) => {
	expect(photo.widths.at(-1)).toBe(photo.width);
	expect([...photo.widths]).toEqual([...photo.widths].sort((a, b) => a - b));
});

it("every file is in the credits, with its author, its source page and the licence", () => {
	expect(credits).toBeDefined();
	for (const name of files) {
		const stem = name.slice(0, name.lastIndexOf("."));
		expect(credits, `${name} is credited`).toContain(`\`${stem}.avif\`/\`.webp\``);
	}

	const rows = (credits ?? "").split("\n").filter((line) => line.startsWith("| `"));
	expect(rows).toHaveLength(Object.keys(PHOTOS).length);
	for (const row of rows) {
		expect(row).toMatch(/\[[^\]]+\]\(https:\/\/unsplash\.com\/@[\w.-]+\)/);
		expect(row).toMatch(/https:\/\/unsplash\.com\/photos\/[\w-]+/);
	}
	expect(credits).toContain("https://unsplash.com/license");
});
