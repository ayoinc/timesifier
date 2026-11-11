import { expect, it } from "vitest";
import { REACT_ARIA_STYLE_HASHES } from "../../workers/security-headers";

// The Content Security Policy allows a <style> element only by the hash of its
// text. React Aria inserts two from script. This test reads them out of the
// installed library, so an upgrade that changes one fails here and not in a browser.

// The modules the browser bundle is built from.
const sources = import.meta.glob<string>(
	[
		"../../node_modules/react-aria/dist/private/**/*.mjs",
		"../../node_modules/react-aria-components/dist/private/**/*.mjs",
		"../../node_modules/react-stately/dist/private/**/*.mjs",
	],
	{ eager: true, query: "?raw", import: "default" },
);

const CREATES_STYLE_ELEMENT = /createElement\(\s*["'`]style["'`]\s*\)/g;

/** The text each `style.textContent = \`…\`.trim()` in a module evaluates to. */
function styleTexts(source: string): string[] {
	const assignments = source.matchAll(/\.textContent\s*=\s*`([^`]*)`\.trim\(\)/g);
	return [...assignments].map(([, template = ""]) =>
		template
			// `${name}` is a module constant: `const name = 'value';`.
			.replace(/\$\{([\w$]+)\}/g, (_, name: string) => {
				const escaped = name.replaceAll("$", "\\$");
				const value = source.match(new RegExp(`${escaped}\\s*=\\s*'([^']*)'`))?.[1];
				if (value === undefined) throw new Error(`cannot resolve \${${name}} in a style text`);
				return value;
			})
			.trim(),
	);
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

const inserting = Object.entries(sources)
	.filter(([, source]) => source.match(CREATES_STYLE_ELEMENT))
	.map(([path, source]) => ({ path: path.replace("../../node_modules/", ""), source }));

it("React Aria creates <style> elements in the two modules the policy accounts for", () => {
	expect(Object.keys(sources).length).toBeGreaterThan(100);
	expect(
		inserting.map(({ path }) => path).sort(),
		"A module that creates a <style> element was added or removed. Read it, then update REACT_ARIA_STYLE_HASHES in workers/security-headers.ts and the list in docs/security.md.",
	).toEqual([
		"react-aria/dist/private/interactions/usePress.mjs",
		"react-aria/dist/private/overlays/usePreventScroll.mjs",
	]);
});

it("every <style> text React Aria inserts is allowed by hash, and no other hash is allowed", async () => {
	const derived: string[] = [];
	for (const { path, source } of inserting) {
		const texts = styleTexts(source);
		expect(
			texts.length,
			`${path}: one style text per created <style> element. The library changed how it writes the text; read the module and update this test.`,
		).toBe(source.match(CREATES_STYLE_ELEMENT)?.length);

		for (const text of texts) {
			const hash = await sha256(text);
			derived.push(hash);
			expect(
				REACT_ARIA_STYLE_HASHES,
				`${path} now inserts this <style> text:\n${text}\nIts hash is '${hash}'. Put that hash in REACT_ARIA_STYLE_HASHES in workers/security-headers.ts in place of the old one, and update test/browser-policy.test.ts and docs/security.md.`,
			).toContain(hash);
		}
	}

	expect(
		[...REACT_ARIA_STYLE_HASHES].sort(),
		"REACT_ARIA_STYLE_HASHES in workers/security-headers.ts allows a style text the library no longer inserts. Remove it.",
	).toEqual(derived.sort());
});
