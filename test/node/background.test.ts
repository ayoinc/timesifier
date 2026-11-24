import { expect, it } from "vitest";

// Work a request does not wait for goes through `inBackground`, which hands it
// to `waitUntil` and keeps count of it, so the tests can wait for all of it
// before they empty the database (app/lib/background.server.ts). This test reads
// every file in `app/` and fails on each other use of `waitUntil`.

/** Every file of `app/`, by its path from the repository, but the helper's own. */
const APP = Object.fromEntries(
	Object.entries(
		import.meta.glob<string>(["../../app/**/*.{ts,tsx}", "!../../app/lib/background.server.ts"], {
			eager: true,
			query: "?raw",
			import: "default",
		}),
	).map(([path, source]) => [path.replace("../../", ""), source]),
);

it("hands background work to the runtime only through inBackground", () => {
	const direct = Object.entries(APP)
		.filter(([, source]) => /\bwaitUntil\s*\(/.test(source))
		.map(([path]) => path);

	expect(Object.keys(APP).length).toBeGreaterThan(100);
	expect(direct).toEqual([]);
});
